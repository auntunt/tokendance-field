// 主动查询端点。接收模糊片段，走「术语纠错→实体消歧→维度路由→搜索采集→分级」链路，
// 返回 Candidate[] 供前端直接送进 acceptCandidates。
//
// 两阶段协议：
//   第一次 POST { fragment } → 若 needsConfirmation=true，返回解析结果让用户确认
//   第二次 POST { fragment, entityName, dimensions, confirmed:true } → 执行搜索
//
// 搜索后端：cn.bing.com，带浏览器 UA（已验证可用）。
// 抽取：复用 /api/collect 的核心逻辑（SSRF 防御、去重、extractRelations），
//       不经 HTTP 层以避免 Basic Auth 二次验证问题。
export const dynamic = "force-dynamic";

import { createHash, randomUUID } from "node:crypto";
import { getDb, ensureWorkspaceSchema } from "../../../db";
import { extractRelations, resolveExtractConfig } from "../../../lib/extractor";
import { corpusFingerprint, priorSightings, recordSighting, repeatVerdict } from "../../../lib/dedup";
import {
  parseQuery, buildSearchTasks, salientTerms, looksDegraded, relevantToEntity,
  MAX_SEARCH_TASKS, type SearchTask,
} from "../../../lib/query-intake";
import { ROSTER } from "../../../lib/fde-roster";
import { gradeOfUrl } from "../../../lib/corpus-import";
import type { DimensionId } from "../../../lib/fde-dimensions";
import { resolveCompany } from "../../../lib/company-resolver";

type ParseRequestBody = {
  fragment: string;
  // 若用户已确认，带上这些字段直接执行
  confirmed?: boolean;
  entityName?: string;
  dimensions?: DimensionId[];
  /** 大模型给出的高区分度搜索词。有就优先跑，没有才跑通用维度词。 */
  searchQueries?: string[];
};

type SearchResult = { url: string; title: string; snippet: string };

const BING_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const BING_TIMEOUT_MS = 12_000;
const FETCH_TIMEOUT_MS = 15_000;
const EXTRACT_TIMEOUT_MS = 180_000;
const MAX_URLS_PER_TASK = 3;

/** 一次查询在内存里保留多久。任务完成或失败后，前端仍可凭 id 取回结果。 */
const JOB_TTL_MS = 30 * 60_000;

type FailedPage = { url: string; reason: string };
type SkippedResult = { url: string; title: string };
type QueryCandidate = Record<string, unknown> & {
  _grade?: string;
  _duplicate?: boolean;
  _duplicateNote?: string;
  _dimension?: string;
};

type QueryJob = {
  id: string;
  fragment: string;
  entityName: string;
  dimensions: DimensionId[];
  searchTasks: SearchTask[];
  status: "running" | "done" | "error";
  startedAt: string;
  updatedAt: string;
  /** 给人看的当前动作，轮询时显示。 */
  progressText: string;
  currentQuery: string;
  completedTasks: number;
  totalTasks: number;
  urlsFetched: number;
  elapsedSeconds: number;
  candidates: QueryCandidate[];
  degradedQueries: string[];
  failedPages: FailedPage[];
  skippedResults: SkippedResult[];
  gradeSummary: Record<string, number>;
  result?: Record<string, unknown>;
  error?: string;
};

declare global {
  var tokendanceQueryJobs: Map<string, QueryJob> | undefined;
}

const queryJobs = globalThis.tokendanceQueryJobs ?? (globalThis.tokendanceQueryJobs = new Map<string, QueryJob>());

/**
 * 两次 Bing 请求之间的间隔。
 *
 * 不是保守估计，是实测出来的：连续 8 次无间隔请求之后，
 * Bing 不返回错误码，而是静默降级——只按查询里第一个中文词出结果
 * （「世纪互联 股东 持股」→ 别克世纪轿车、世纪佳缘）。
 * 因为 status 仍是 200、HTML 结构也正常，这种降级在代码里看不出来，
 * 只能靠间隔避开。间隔 20s 实测连续两轮全部正常。
 *
 * 6 个搜索任务 → 最多 5 次等待 ≈ 100s。这是主动查询能接受的代价：
 * 拿回一次干净的结果，比拿回六次「别克世纪」有用。
 */
const BING_GAP_MS = 20_000;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * 距离上次 Bing 请求不足 BING_GAP_MS 的话，补足差额。
 *
 * 关键是「补足」而不是「无条件等」：中间抓取和抽取本来就要花几十秒，
 * 那段时间同样在拉开两次 Bing 请求的间隔。无条件 sleep 会把这段时间白白叠加，
 * 一轮下来能超过 5 分钟——浏览器和反向代理会直接掐断连接。
 */
async function throttleBing(lastAt: number): Promise<void> {
  if (!lastAt) return;
  const waited = Date.now() - lastAt;
  if (waited < BING_GAP_MS) await sleep(BING_GAP_MS - waited);
}

// looksDegraded / relevantToEntity 放在 lib/query-intake.ts 里，
// 和纠错、抽名、路由一起被 tests/query-intake.test.mjs 覆盖。
// 这两条规则最容易悄悄失效（判错不报错，只是结果变垃圾），必须有测试。
const STRIP_TAGS = /<(script|style|noscript|head|nav|footer|header|aside|iframe|svg)[^>]*>[\s\S]*?<\/\1>/gi;

function decodeHtmlEntities(s: string) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

function stripToText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Bing 搜索，返回前 N 条结果的 URL + 标题 + 摘要。
 *
 *  为什么用 cn.bing.com 而不是 Bing Search API：
 *  API 需要 Azure 账号，且有配额限制；cn.bing.com 在本环境已验证可通过 browser UA 访问。
 *  实测通过：见会话历史中的世纪互联 OCP 查询记录。
 *
 *  结果抽取：Bing 的 #b_results > li.b_algo，每条含 h2>a（标题+URL）和 .b_caption p（摘要）。
 */
async function bingSearch(query: string, maxResults = MAX_URLS_PER_TASK): Promise<SearchResult[]> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&cc=CN`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BING_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": BING_UA, "Accept-Language": "zh-CN,zh;q=0.9", "Accept": "text/html" },
    });
    clearTimeout(timer);
    const html = await resp.text();

    // 抽取 .b_algo 条目：<h2><a href="...">标题</a></h2>...<p>摘要</p>
    const results: SearchResult[] = [];
    const algoPattern = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    let algoMatch: RegExpExecArray | null;
    while ((algoMatch = algoPattern.exec(html)) !== null && results.length < maxResults) {
      const block = algoMatch[1];
      const hrefMatch = /href="(https?:\/\/[^"]+)"/.exec(block);
      const titleMatch = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block);
      const snippetMatch = /<p[^>]*class="[^"]*b_[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)
        || /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
      if (!hrefMatch) continue;
      const href = hrefMatch[1];
      // 过滤掉 Bing 自己的页面和广告
      if (href.includes("bing.com") || href.includes("microsoft.com")) continue;
      results.push({
        url: href,
        title: titleMatch ? stripToText(titleMatch[1]) : "",
        snippet: snippetMatch ? stripToText(snippetMatch[1]).slice(0, 300) : "",
      });
    }
    return results;
  } catch {
    clearTimeout(timer);
    return [];
  }
}

/** 抓取一个 URL 的文本正文，复用 collect route 里的 htmlToText 逻辑。 */
async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": BING_UA,
        "Accept": "text/html,text/plain;q=0.9",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    clearTimeout(timer);
    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("text/plain")) return null;
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > 500_000) return null;
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const body = html.replace(STRIP_TAGS, " ");
    const paragraphs = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(m => stripToText(m[1]))
      .filter(t => t.length >= 24 && !/^(上一页|下一页|返回|分享|责编|编辑|来源)/.test(t));
    const joined = paragraphs.join("\n\n");
    return joined.length >= 180 ? joined : stripToText(body);
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function ensureQuerySchema(db: ReturnType<typeof getDb>) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS query_log (
      id TEXT PRIMARY KEY NOT NULL,
      fragment TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      dimensions TEXT NOT NULL,
      searched_at TEXT NOT NULL,
      urls_fetched INTEGER NOT NULL DEFAULT 0,
      candidates_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS query_entities (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      legal_name TEXT,
      first_seen TEXT NOT NULL,
      query_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS query_log_entity_idx ON query_log(entity_name);
  `);
}

function urlHash(s: string) { return createHash("sha256").update(s).digest("hex").slice(0, 16); }

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of queryJobs) {
    if (now - new Date(job.updatedAt).getTime() > JOB_TTL_MS) queryJobs.delete(id);
  }
}

/** 后台执行查询。HTTP 请求创建任务后立刻返回，前端轮询拿结果——
 *  再长的任务都不会被 Nginx / 浏览器的超时杀掉。 */
async function executeQueryJob(job: QueryJob) {
  try {
    ensureWorkspaceSchema();
    const db = getDb();
    ensureQuerySchema(db);
    const config = resolveExtractConfig({});
    if (!config) throw new Error("抽取器未配置（EXTRACT_ENDPOINT / EXTRACT_API_KEY / EXTRACT_MODEL）");

    const allCandidates: QueryCandidate[] = [];
    let urlsFetched = 0;
    const processedUrls = new Set<string>();
    let lastBingAt = 0;

    for (let taskIndex = 0; taskIndex < job.searchTasks.length; taskIndex++) {
      const task = job.searchTasks[taskIndex];
      job.completedTasks = taskIndex;
      job.currentQuery = task.query;
      job.progressText = `正在跑第 ${taskIndex + 1}/${job.searchTasks.length} 组搜索：${task.query}`;
      job.updatedAt = new Date().toISOString();

      await throttleBing(lastBingAt);
      lastBingAt = Date.now();
      const results = await bingSearch(task.query);

      if (looksDegraded(job.entityName, results)) {
        job.degradedQueries.push(task.query);
        continue;
      }

      for (const result of results) {
        if (processedUrls.has(result.url)) continue;
        processedUrls.add(result.url);
        job.progressText = `正在处理 ${result.url}`;
        job.updatedAt = new Date().toISOString();

        if (!relevantToEntity(job.entityName, result)) {
          job.skippedResults.push({ url: result.url, title: result.title });
          continue;
        }

        const text = await fetchText(result.url);
        if (!text || text.length < 40) continue;
        urlsFetched++;
        job.urlsFetched = urlsFetched;

        const fingerprint = corpusFingerprint(text);
        const sourceName = new URL(result.url).hostname;
        const prior = priorSightings(db, fingerprint);
        const repeat = repeatVerdict(prior, sourceName);
        const grade = gradeOfUrl(result.url);

        if (repeat) {
          allCandidates.push({
            title: result.title || `来自 ${sourceName}`,
            evidence: result.snippet || text.slice(0, 400),
            source: sourceName,
            sourceUrl: result.url,
            edges: [],
            suggestedRelation: "unclustered",
            origin: "pipeline",
            _grade: grade,
            _duplicate: true,
            _duplicateNote: repeat.message,
            _dimension: task.dimension,
          });
          continue;
        }

        try {
          const extracted = await extractRelations(text, { ...config, source: sourceName, sourceUrl: result.url }, EXTRACT_TIMEOUT_MS);
          const extractedAt = new Date().toISOString();
          recordSighting(db, {
            fingerprint, sourceName, sourceUrl: result.url,
            entryPoint: "query", seenAt: extractedAt, textLength: text.length, candidatesCount: extracted.length,
          });
          for (const candidate of extracted) {
            allCandidates.push({ ...candidate, _grade: grade, _dimension: task.dimension });
          }
        } catch (err) {
          job.failedPages.push({ url: result.url, reason: err instanceof Error ? err.message : "抽取失败" });
        }
      }
    }

    job.candidates = allCandidates;
    job.urlsFetched = urlsFetched;
    job.gradeSummary = {
      statutory: allCandidates.filter(c => c._grade === "statutory").length,
      independent: allCandidates.filter(c => c._grade === "independent").length,
      self: allCandidates.filter(c => c._grade === "self").length,
      unverified: allCandidates.filter(c => c._grade === "unverified").length,
    };

    const now = new Date().toISOString();
    db.prepare("INSERT INTO query_log (id, fragment, entity_name, dimensions, searched_at, urls_fetched, candidates_count) VALUES (?,?,?,?,?,?,?)").run(
      `qry-${Date.now()}-${urlHash(job.entityName)}`, job.fragment, job.entityName, job.dimensions.join(","), now, urlsFetched, allCandidates.length,
    );
    db.prepare(`
      INSERT INTO query_entities (id, name, first_seen, query_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET query_count = query_count + 1
    `).run(`qe-${urlHash(job.entityName)}`, job.entityName, now);

    job.result = {
      phase: "results",
      entityName: job.entityName,
      fragment: job.fragment,
      dimensions: job.dimensions.map(id => ({ id, reason: "", confidence: "default" })),
      searchTasks: job.searchTasks.map(t => ({ query: t.query, kind: t.kind, dimension: t.dimension })),
      degradedQueries: job.degradedQueries,
      failedPages: job.failedPages,
      skippedResults: job.skippedResults,
      urlsFetched: job.urlsFetched,
      candidates: job.candidates,
      gradeSummary: job.gradeSummary,
    };
    job.status = "done";
    job.progressText = "查询完成";
    job.updatedAt = new Date().toISOString();
  } catch (error) {
    job.status = "error";
    job.error = error instanceof Error ? error.message : "查询失败";
    job.progressText = "查询失败";
    job.updatedAt = new Date().toISOString();
  }
}



export async function POST(request: Request) {
  try {
    const body = await request.json() as ParseRequestBody;
    const fragment = String(body.fragment ?? "").trim();
    if (fragment.length < 2) {
      return Response.json({ error: "查询词太短" }, { status: 400 });
    }

    ensureWorkspaceSchema();
    const db = getDb();
    ensureQuerySchema(db);

    // 从 SQLite 取历史查询实体（用于消歧）
    type CachedEntity = { id: string; name: string; legal_name?: string };
    const cachedRaw = db.prepare("SELECT id, name, legal_name FROM query_entities ORDER BY query_count DESC LIMIT 100").all() as CachedEntity[];
    const cachedEntities = cachedRaw.map(row => ({ id: row.id, name: row.name, legalName: row.legal_name }));

    // 阶段一：解析（不执行搜索）
    if (!body.confirmed) {
      const parsed = parseQuery(fragment, ROSTER, cachedEntities);
      // 模糊消歧：本地索引召回 + 必要时大模型推理。大模型配置不可用时只走本地。
      const resolver = await resolveCompany(parsed.correction.fragment, parsed.extractedName, resolveExtractConfig({}));
      const resolverEntity = resolver.candidates[0]?.name || parsed.entityName;
      const searchTasks = buildSearchTasks(resolverEntity, parsed.dimensions, MAX_SEARCH_TASKS, parsed.salient);
      // 精确命中时不再要求确认，哪怕名单与历史缓存里重复出现同一个名字。
      // 有术语纠错时仍然确认：把 OPC 自动改成 OCP 后，用户应该看见改了什么。
      const resolverUnique = resolver.mode === "exact" && resolver.candidates.length === 1;
      const needsConfirmation =
        parsed.correction.changed || (!resolverUnique && (parsed.needsConfirmation || resolver.candidates.length !== 1 || resolver.mode === "llm"));
      return Response.json({
        phase: "parse",
        needsConfirmation,
        correction: parsed.correction,
        extractedName: parsed.extractedName,
        entityName: resolverEntity,
        disambiguation: parsed.disambiguation,
        dimensions: parsed.dimensions,
        salient: parsed.salient,
        searchTasks,
        resolver,
        searchQueries: resolver.searchQueries,
        // 两条路取更长的那条，给用户一个不会越等越久的预计时间
        estimatedSeconds: Math.round((Math.max(searchTasks.length, resolver.searchQueries.length) - 1) * BING_GAP_MS / 1000),
      });
    }

    // 阶段二：执行搜索（用户已确认）
    //
    // 解析只跑一次，然后让用户在确认面板上的选择覆盖它。
    // 用户没选的部分沿用解析结果——parseQuery 已经做过实体名抽取，
    // 不能再退回「把整句当实体名」的老兜底。
    const parsed = parseQuery(fragment, ROSTER, cachedEntities);
    const entityName = String(body.entityName ?? "").trim() || parsed.entityName;

    const dimensionIds = (body.dimensions && body.dimensions.length > 0)
      ? body.dimensions
      : parsed.dimensions.map(d => d.id);

    const dimensions = parsed.dimensions.filter(d => dimensionIds.includes(d.id));
    // 用户可能改了实体名，salient 要按新名字重算（避免把名字里的词又当关键词搜一遍）
    const salient = salientTerms(parsed.correction.fragment, entityName);
    const primaryDimension = dimensions[0]?.id ?? parsed.dimensions[0]?.id ?? "business";
    // 大模型给出的高区分度搜索词优先；没有才用「实体名 + 维度提示」。
    const customQueries = (body.searchQueries ?? []).map(q => String(q).trim()).filter(Boolean).slice(0, MAX_SEARCH_TASKS);
    const searchTasks: SearchTask[] = customQueries.length
      ? customQueries.map((query, index) => ({
          entityName,
          dimension: dimensions[index % Math.max(dimensions.length, 1)]?.id ?? primaryDimension,
          query,
          kind: "clue",
        }))
      : buildSearchTasks(entityName, dimensions, MAX_SEARCH_TASKS, salient);

    const config = resolveExtractConfig({});
    if (!config) {
      return Response.json({ error: "抽取器未配置（EXTRACT_ENDPOINT / EXTRACT_API_KEY / EXTRACT_MODEL）" }, { status: 400 });
    }

    // 阶段二改为后台任务：创建后立刻返回 jobId，前端轮询 /api/query/jobs?id=...
    // 搜索和抽取在后台继续跑，不再受 Nginx / 浏览器连接超时影响。
    const now = new Date().toISOString();
    const job: QueryJob = {
      id: `qj-${Date.now()}-${randomUUID().slice(0, 8)}`,
      fragment,
      entityName,
      dimensions: dimensionIds,
      searchTasks,
      status: "running",
      startedAt: now,
      updatedAt: now,
      progressText: "任务已创建",
      currentQuery: "",
      completedTasks: 0,
      totalTasks: searchTasks.length,
      urlsFetched: 0,
      elapsedSeconds: 0,
      candidates: [],
      degradedQueries: [],
      failedPages: [],
      skippedResults: [],
      gradeSummary: { statutory: 0, independent: 0, self: 0, unverified: 0 },
    };
    queryJobs.set(job.id, job);
    pruneJobs();
    void executeQueryJob(job);

    return Response.json({
      phase: "started",
      jobId: job.id,
      entityName,
      fragment,
      dimensions: dimensions.map(d => ({ id: d.id, reason: d.reason, confidence: d.confidence })),
      searchTasks: searchTasks.map(t => ({ query: t.query, kind: t.kind, dimension: t.dimension })),
      estimatedSeconds: Math.round((searchTasks.length - 1) * BING_GAP_MS / 1000),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "查询失败" }, { status: 500 });
  }
}

// GET：返回最近的查询记录（供监控集派生使用）
export async function GET() {
  try {
    ensureWorkspaceSchema();
    const db = getDb();
    ensureQuerySchema(db);
    type QueryRow = { id: string; fragment: string; entity_name: string; dimensions: string; searched_at: string; candidates_count: number };
    const logs = db.prepare("SELECT * FROM query_log ORDER BY rowid DESC LIMIT 50").all() as QueryRow[];
    type EntityRow = { id: string; name: string; legal_name?: string; query_count: number };
    const entities = db.prepare("SELECT * FROM query_entities ORDER BY query_count DESC LIMIT 20").all() as EntityRow[];
    return Response.json({ logs, entities });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "查询记录读取失败" }, { status: 500 });
  }
}
