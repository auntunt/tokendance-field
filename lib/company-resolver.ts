// 模糊商业信息查询的实体消歧层。
//
// 三层配合，而不是把一切交给大模型：
//   1. 确定性线索抽取——从一句话里把「名字可能叫什么、控股关系、是否上市、
//      地址、业务、融资、人员」这些可核对的线索切出来。
//   2. 本地公司索引召回——用 reports/history 里的 231 家公司做线索级检索，
//      给大模型提供「可引用的候选」，而不是让它凭空想。
//   3. 大模型推理——只有名字对不上或线索多义时才调用；它只负责提出候选和
//      搜索词，不负责宣布答案。最终事实仍然要回到搜索引擎和来源分级。
//
// 索引来自 reports/history 的最新一份，生成时冻结到 lib/fde-company-index.json。
// 它和查询库（SQLite query_log/query_entities）不是一套东西：报告是离线生成的事实
// 台账，查询是实时搜索入口；这里用报告台账给实时查询做消歧底座。

import { bigramSimilarity } from "./query-intake";
import rawIndex from "./fde-company-index.json";

export type ClueKind = "name" | "ownership" | "listing" | "address" | "business" | "finance" | "people";

export type CompanyClue = {
  kind: ClueKind;
  label: string;
  text: string;
};

export type IndexedCompany = {
  id: string;
  name: string;
  aliases?: string[];
  legalName?: string;
  ticker?: string;
  listing?: string;
  country?: string;
  city?: string;
  sector?: string;
  relevance?: string;
  watchlist?: boolean;
  relevanceReason?: string;
  facts?: Record<string, string>;
};

type RawIndexFile = {
  generatedAt: string;
  source: string;
  count: number;
  entries: IndexedCompany[];
};

const INDEX = (rawIndex as unknown as RawIndexFile).entries ?? [];

export type ResolvedCandidate = {
  id: string;
  name: string;
  legalName?: string;
  ticker?: string;
  listing?: string;
  country?: string;
  city?: string;
  sector?: string;
  relevance?: string;
  watchlist?: boolean;
  /** 0–1，综合相似度。 */
  score: number;
  /** 候选来源。llm 表示大模型提出、本地索引里没有的候选。 */
  source: "history" | "llm";
  reason: string;
  matchedClues: string[];
  snippets: string[];
};

export type ResolverMode = "exact" | "local" | "llm";

export type ResolverResult = {
  mode: ResolverMode;
  llmUsed: boolean;
  llmNote?: string;
  clues: CompanyClue[];
  candidates: ResolvedCandidate[];
  /** 大模型建议的搜索引擎查询词。执行阶段会优先跑这些，而不是通用维度词。 */
  searchQueries: string[];
  /** 大模型给出的最终名字猜测（可能不在任何名单里）。 */
  nameGuess?: string;
};

export type ResolverLlmConfig = { endpoint: string; apiKey: string; model: string };

// ─── 线索抽取（确定性，可测试）───────────────────────────────────────────────

const CLUE_LABEL: Record<ClueKind, string> = {
  name: "疑似名称",
  ownership: "股权/归属",
  listing: "上市/挂牌",
  address: "地址线索",
  business: "业务线索",
  finance: "融资线索",
  people: "人员线索",
};

const CLUE_RULES: Array<{ kind: ClueKind; pattern: RegExp; capture?: number }> = [
  // 地址类最容易给出「中关村孵化器 23 号楼」这种高区分度信息，排在前面。
  { kind: "address", pattern: /(?:中关村|孵化器|产业园|科技园|软件园|创新园|开发区|园区|基地|大厦|号楼|号院|座|层|路|街|大道)[A-Za-z0-9\u4e00-\u9fa5（）()\-]{0,20}/g },
  // 「做的是工程绘图相关」「主营 CAD」这类直接描述业务。
  { kind: "business", pattern: /(?:做|从事|主营|主要做|业务是|做的是|产品是|做.*?相关)[\u4e00-\u9fa5A-Za-z0-9、，, ]{2,24}/g },
  // 没有动词的裸业务词也要能抓住：工程绘图 / 大模型 / SaaS 这类词本身就是线索。
  { kind: "business", pattern: /(?:工程绘图|工业软件|CAD|BIM|软件开发|智能制造|系统集成|人工智能|大模型|智能体|SaaS|电商|金融科技|医疗健康|教育科技|物流科技|建筑科技|芯片设计|数据分析|云服务)/g },
  { kind: "ownership", pattern: /(?:控股|持股|收购|投资|参股|子公司|母公司|隶属于|旗下|股东)/g },
  { kind: "listing", pattern: /(?:今年|去年|近期|已经|刚|即将|计划)?(?:上市|IPO|挂牌|科创板|创业板|主板|北交所|港股|美股|A股|新三板)/g },
  { kind: "finance", pattern: /(?:融资|估值|投资方|投资人|轮次|A轮|B轮|C轮|天使|并购|市值|营收)/g },
  { kind: "people", pattern: /(?:创始人|CEO|CTO|CFO|高管|团队来自|来自|曾在|前)[A-Za-z0-9\u4e00-\u9fa5]{0,16}/g },
];

function around(fragment: string, index: number, length: number, before = 12, after = 24): string {
  const start = Math.max(0, index - before);
  const end = Math.min(fragment.length, index + length + after);
  return fragment.slice(start, end).trim();
}

/** 每种线索展示的上下文宽度不同：地址要看门牌号，股权只要关系短语。 */
function clueContext(kind: ClueKind): { before: number; after: number } {
  if (kind === "address") return { before: 4, after: 4 };
  if (kind === "business") return { before: 4, after: 8 };
  if (kind === "ownership" || kind === "listing") return { before: 6, after: 8 };
  if (kind === "finance" || kind === "people") return { before: 6, after: 10 };
  return { before: 6, after: 10 };
}

/** 从自然语言片段里切出可核对线索。相同文本去重，保留先出现的。 */
export function extractClues(fragment: string, extractedName = ""): CompanyClue[] {
  const seen = new Set<string>();
  const clues: CompanyClue[] = [];

  if (extractedName && extractedName.trim().length >= 2) {
    clues.push({ kind: "name", label: CLUE_LABEL.name, text: extractedName.trim().slice(0, 40) });
    seen.add(`name:${extractedName.trim()}`);
  }

  for (const rule of CLUE_RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(fragment)) !== null) {
      const context = clueContext(rule.kind);
      const text = around(fragment, match.index, match[0].length, context.before, context.after).replace(/\s+/g, " ").slice(0, 80);
      const key = `${rule.kind}:${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clues.push({ kind: rule.kind, label: CLUE_LABEL[rule.kind], text });
    }
  }

  // 同一类线索经常被动词版规则和裸词版规则各抓一次（「做的是工程绘图相关」
  // 和「工程绘图」）。合并时保留更短、更贴近原词的那条，避免确认面板刷屏。
  const merged: CompanyClue[] = [];
  for (const clue of clues) {
    const index = merged.findIndex(item =>
      item.kind === clue.kind && (item.text.includes(clue.text) || clue.text.includes(item.text))
    );
    if (index >= 0) {
      if (clue.text.length < merged[index].text.length) merged[index] = clue;
      continue;
    }
    merged.push(clue);
  }

  return merged.slice(0, 12);
}

// ─── 本地索引召回 ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set(["有限", "公司", "股份", "集团", "科技", "技术", "智能", "中国", "北京", "上海", "深圳", "杭州", "广州", "成都", "一个", "什么", "最近", "现在"]);

function tokenize(text: string): Set<string> {
  const clean = text.replace(/[\s，。！？、：；""''（）()【】《》…—\-_/\\|,.]/g, "").toLowerCase();
  const tokens = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) {
    const gram = clean.slice(i, i + 2);
    if (!STOP_WORDS.has(gram)) tokens.add(gram);
  }
  if (clean.length === 1) tokens.add(clean);
  // 英文/数字词整体保留一个 token，避免把 OCP 拆成 OC/CP。
  for (const word of text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) tokens.add(word);
  return tokens;
}

function tokenOverlap(needle: string, hay: string): number {
  const a = tokenize(needle);
  if (a.size === 0) return 0;
  const b = tokenize(hay);
  let hit = 0;
  for (const token of a) if (b.has(token)) hit++;
  return hit / a.size;
}

const CLUE_WEIGHT: Record<ClueKind, number> = {
  name: 2,
  ownership: 2.4,
  listing: 1.4,
  address: 2.8,
  business: 2.6,
  finance: 2.2,
  people: 2.0,
};

function companyText(entry: IndexedCompany): string {
  const parts = [
    entry.name,
    ...(entry.aliases ?? []),
    entry.legalName ?? "",
    entry.ticker ?? "",
    entry.country ?? "",
    entry.city ?? "",
    entry.sector ?? "",
    entry.relevanceReason ?? "",
    ...Object.values(entry.facts ?? {}),
  ];
  return parts.filter(Boolean).join(" \n ");
}

function nameSimilarity(query: string, entry: IndexedCompany): number {
  const names = [entry.name, entry.legalName ?? "", ...(entry.aliases ?? [])].filter(Boolean);
  let best = 0;
  for (const name of names) {
    best = Math.max(best, bigramSimilarity(query, name));
    const q = query.replace(/[\s（）()]/g, "");
    const n = name.replace(/[\s（）()]/g, "");
    if (q && n && (q === n || n.includes(q) || q.includes(n))) best = Math.max(best, 0.96);
  }
  return best;
}

/** 一条候选命中了什么线索，以及命中原文。 */
function matchedEvidence(entry: IndexedCompany, clues: CompanyClue[]): { score: number; clues: CompanyClue[]; snippets: string[] } {
  const hay = companyText(entry);
  let score = 0;
  const matchedClues: CompanyClue[] = [];
  const snippets = new Set<string>();
  const facts = entry.facts ?? {};

  for (const clue of clues) {
    if (clue.kind === "name") continue;
    const overlap = tokenOverlap(clue.text, hay);
    if (overlap <= 0) continue;
    const weight = CLUE_WEIGHT[clue.kind] * (0.35 + 0.65 * overlap);
    score += weight;
    matchedClues.push(clue);
    for (const value of Object.values(facts)) {
      if (tokenOverlap(clue.text, value) >= 0.45 && value) snippets.add(value.slice(0, 160));
    }
    if (snippets.size === 0) {
      const pos = hay.indexOf(clue.text.slice(0, 8));
      if (pos >= 0) snippets.add(hay.slice(Math.max(0, pos - 30), Math.min(hay.length, pos + 90)).trim());
    }
  }

  return { score, clues: matchedClues, snippets: [...snippets].slice(0, 3) };
}

/** 从冻结的公司索引里召回最相关的候选。 */
export function recallCompanies(extractedName: string, clues: CompanyClue[]): ResolvedCandidate[] {
  const scored: ResolvedCandidate[] = [];
  for (const entry of INDEX) {
    const nameSim = nameSimilarity(extractedName, entry);
    const evidence = matchedEvidence(entry, clues);
    const nonNameClues = clues.filter(c => c.kind !== "name").length;
    const clueScore = nonNameClues ? evidence.score / (nonNameClues * 2.4) : 0;
    const score = nameSim * 0.55 + Math.min(1, clueScore) * 0.45;
    if (score < 0.16) continue;
    const matchedClueTexts = evidence.clues.map(c => c.text);
    scored.push({
      id: entry.id,
      name: entry.name,
      legalName: entry.legalName,
      ticker: entry.ticker,
      listing: entry.listing,
      country: entry.country,
      city: entry.city,
      sector: entry.sector,
      relevance: entry.relevance,
      watchlist: Boolean(entry.watchlist),
      score: Math.round(score * 100) / 100,
      source: "history",
      reason: matchedClueTexts.length
        ? `命中线索：${matchedClueTexts.slice(0, 3).join("；")}`
        : `名称相似度 ${(nameSim * 100).toFixed(0)}%`,
      matchedClues: matchedClueTexts,
      snippets: evidence.snippets,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8);
}

// ─── 大模型推理 ──────────────────────────────────────────────────────────────

export type LlmResolverLoose = {
  nameGuess?: string;
  confidence?: number;
  clues?: Partial<Record<ClueKind, string[]>>;
  matches?: Array<{
    id?: string;
    name?: string;
    legalName?: string;
    ticker?: string;
    confidence?: number;
    reason?: string;
    matchedClues?: string[];
  }>;
  searchQueries?: string[];
  note?: string;
};

const RESOLVER_SYSTEM = `你是商业信息查询里的实体消歧器。用户会给一段非常模糊的中文线索，可能包含错别字公司名、控股关系、上市时间、地址、业务描述、融资或人员信息。你的任务不是宣布事实，而是提出可核验的候选和下一步搜索词。

硬规则：
1. 永远不要把线索当成结论。你说出的候选只是猜测，事实必须回到来源验证。
2. 优先从给定的候选名单里匹配；名单都不像时，才给出名单外猜测，并在 note 里注明「名单外」。
3. 每条候选必须写 reason：它命中了哪些线索、哪里还不确定。
4. searchQueries 给 2–4 条中文搜索引擎查询词，优先组合高区分度线索（地址、业务词、控股关系），不要只放一个模糊公司名。
5. 只输出严格 JSON，不要 Markdown。

输出格式：
{"nameGuess":"最可能的企业名，可含「（待核）」","confidence":0到1,"clues":{"ownership":[],"listing":[],"address":[],"business":[],"finance":[],"people":[]},"matches":[{"id":"候选名单里的id，没有就空字符串","name":"企业名","legalName":"","ticker":"","confidence":0到1,"reason":"","matchedClues":[]}],"searchQueries":["查询词"],"note":"一句话说明推理边界"}`;

function compactCandidate(c: ResolvedCandidate): string {
  const facts = c.snippets.slice(0, 3).join(" / ");
  return [
    `id=${c.id}`,
    `name=${c.name}`,
    c.legalName ? `legalName=${c.legalName}` : "",
    c.ticker ? `ticker=${c.ticker}` : "",
    `listing=${c.listing ?? ""}`,
    `city=${c.city ?? ""}`,
    `sector=${c.sector ?? ""}`,
    `evidence=${facts || c.reason}`,
  ].filter(Boolean).join(" | ");
}

function jsonFromLlm(text: string): LlmResolverLoose {
  const fenced = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("模型未返回可读取的 JSON");
  return JSON.parse(fenced.slice(start, end + 1)) as LlmResolverLoose;
}

function parseLlmContent(payload: unknown): string {
  const value = payload as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    content?: Array<{ text?: string }>;
  };
  return value.output_text || value.choices?.[0]?.message?.content || value.choices?.[0]?.message?.reasoning_content
    || value.content?.map(item => item.text || "").join("")
    || value.output?.flatMap(item => item.content ?? []).map(item => item.text || "").join("")
    || "";
}

/** 调用大模型做一次模糊消歧。失败时抛错，由调用方决定是否回退本地结果。 */
export async function llmResolveCompany(
  fragment: string,
  extractedName: string,
  localCandidates: ResolvedCandidate[],
  config: ResolverLlmConfig,
): Promise<LlmResolverLoose> {
  const candidateLines = localCandidates.slice(0, 8).map((c, i) => `${i + 1}. ${compactCandidate(c)}`).join("\n");
  const userPrompt = [
    `用户原始输入：${fragment}`,
    `规则抽出的疑似名称：${extractedName || "（没有）"}`,
    "本地索引召回：",
    candidateLines || "（没有可引用的本地候选）",
    "请给出候选和 searchQueries。",
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const upstream = await fetch(config.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: RESOLVER_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
    });
    clearTimeout(timer);
    const raw = await upstream.text();
    if (!upstream.ok) throw new Error(`解析服务返回 ${upstream.status}: ${raw.slice(0, 200)}`);
    const payload = JSON.parse(raw) as unknown;
    const text = parseLlmContent(payload);
    if (!text.trim()) throw new Error("模型返回空正文");
    return jsonFromLlm(text);
  } finally {
    clearTimeout(timer);
  }
}

// ─── 整合入口 ────────────────────────────────────────────────────────────────

function toLlmCandidate(match: NonNullable<LlmResolverLoose["matches"]>[number], local: ResolvedCandidate[]): ResolvedCandidate {
  const localHit = local.find(c => c.id === match.id || c.name === match.name || c.legalName === match.legalName);
  const name = String(match.name || localHit?.name || "").trim();
  const confidence = Math.max(0, Math.min(1, Number(match.confidence) || 0));
  return {
    id: match.id || localHit?.id || `llm-${name}`,
    name: name || "待确认主体",
    legalName: match.legalName || localHit?.legalName,
    ticker: match.ticker || localHit?.ticker,
    listing: localHit?.listing,
    country: localHit?.country,
    city: localHit?.city,
    sector: localHit?.sector,
    relevance: localHit?.relevance,
    watchlist: localHit?.watchlist,
    score: confidence,
    source: localHit ? "history" : "llm",
    reason: String(match.reason || "").slice(0, 300),
    matchedClues: Array.isArray(match.matchedClues) ? match.matchedClues : [],
    snippets: localHit?.snippets ?? [],
  };
}

/**
 * 查询解析总入口。
 *
 * 判定顺序：
 *   - 本地索引里有接近唯一的强名称命中，且没有纠错/多线索 -> exact，不调模型。
 *   - 名称含糊但线索明确 -> local，给多个候选，由人点选。
 *   - 名称对不上或候选歧义 -> 调大模型推理；模型不可用时回退 local。
 */
export async function resolveCompany(
  fragment: string,
  extractedName: string,
  config?: ResolverLlmConfig | null,
): Promise<ResolverResult> {
  const clues = extractClues(fragment, extractedName);
  const local = recallCompanies(extractedName, clues);
  const bestNameSim = local.length ? nameSimilarity(extractedName, local[0]) : 0;
  const strongUnique = local.length === 1 && bestNameSim >= 0.9 && clues.filter(c => c.kind !== "name").length <= 2;

  const localResult: ResolverResult = {
    mode: strongUnique ? "exact" : "local",
    llmUsed: false,
    clues,
    candidates: local,
    // 精确命中时不要给自定义搜索词：让通用任务继续按「实体名 + FDE + 维度」补齐。
    searchQueries: strongUnique ? [] : buildSearchQueries(fragment, extractedName, local),
  };

  if (strongUnique) return localResult;

  const ambiguous = clues.filter(c => c.kind !== "name").length >= 2 || local.length > 1 || bestNameSim < 0.55;
  if (!ambiguous || !config) return localResult;

  try {
    const loose = await llmResolveCompany(fragment, extractedName, local, config);
    const matches = (loose.matches ?? [])
      .filter(m => String(m.name || "").trim())
      .slice(0, 5)
      .map(m => toLlmCandidate(m, local));

    const candidates = matches.length ? matches : local;
    const queries = Array.isArray(loose.searchQueries) && loose.searchQueries.length
      ? loose.searchQueries.map(q => String(q).trim()).filter(Boolean).slice(0, 6)
      : localResult.searchQueries;

    return {
      mode: "llm",
      llmUsed: true,
      llmNote: loose.note,
      clues,
      candidates,
      searchQueries: queries,
      nameGuess: loose.nameGuess,
    };
  } catch (error) {
    return { ...localResult, mode: "local", llmUsed: false, llmNote: error instanceof Error ? `大模型解析不可用，已回退本地匹配：${error.message}` : "大模型解析不可用，已回退本地匹配" };
  }
}

/** 本地召回失败时，把高区分度线索拼成搜索词。 */
export function buildSearchQueries(fragment: string, extractedName: string, candidates: ResolvedCandidate[]): string[] {
  const queries: string[] = [];
  const strongClues = extractClues(fragment, extractedName)
    .filter(c => ["address", "business", "ownership"].includes(c.kind))
    .map(c => c.text);
  if (candidates[0]) queries.push(`${candidates[0].name} ${strongClues.slice(0, 2).join(" ")}`.trim());
  if (strongClues.length >= 2) queries.push(strongClues.join(" "));
  return queries.filter((q, i) => q && queries.indexOf(q) === i).slice(0, 4);
}
