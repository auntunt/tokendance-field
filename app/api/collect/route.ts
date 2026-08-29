// Phase 4 采集器：接收 URL，抓取页面，提取可读文本，调用共享抽取函数。
// 不经过 /api/extract 的 HTTP 层（避免 Basic Auth 二次验证问题）。
//
// SSRF 防御：禁止私有地址段、回环和 file:// 协议。
// 去重：URL 规范化后哈希，命中已采集记录直接返回 duplicate。
export const dynamic = "force-dynamic";

import { createHash } from "node:crypto";
import { getDb, ensureWorkspaceSchema } from "../../../db";
import { extractRelations, resolveExtractConfig } from "../../../lib/extractor";
import { corpusFingerprint, priorSightings, recordSighting, repeatVerdict } from "../../../lib/dedup";
import { canonicalUrl, fetchPublicDocument } from "../../../lib/research/fetch-document";

type RequestBody = { url: string; source?: string; model?: string; endpoint?: string; apiKey?: string; force?: boolean };
type LogRow = { id: string; url: string; url_hash: string; source_name: string; fetched_at: string; status: string; error_msg: string | null; content_hash: string | null; candidates_count: number };

function urlHash(s: string) { return createHash("sha256").update(s).digest("hex").slice(0, 16); }

function ensureLogTable(db: ReturnType<typeof getDb>) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collection_log (
      id TEXT PRIMARY KEY NOT NULL,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      source_name TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      status TEXT NOT NULL,
      error_msg TEXT,
      content_hash TEXT,
      candidates_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS collection_url_hash_idx ON collection_log(url_hash);
  `);
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as RequestBody;
    const canonical = canonicalUrl(String(body.url ?? "").trim());
    const hash = urlHash(canonical);
    ensureWorkspaceSchema();
    const db = getDb(); ensureLogTable(db);

    // 同一个 URL 抓过就不再抓——这一层省的是网络请求，不是判重。
    // 真正的判重在抓完之后按内容做（见下方 corpusFingerprint）。
    const existing = body.force ? undefined : db.prepare("SELECT * FROM collection_log WHERE url_hash=? AND status='ok' ORDER BY fetched_at DESC LIMIT 1").get(hash) as LogRow | undefined;
    if (existing) return Response.json({ duplicate: true, sameUrl: true, previousFetch: existing.fetched_at, candidatesCount: existing.candidates_count, message: `这个网址 ${existing.fetched_at.slice(0, 10)} 抓过了，抽出 ${existing.candidates_count} 条。要重抓就勾上「重抓一遍」。` });

    const config = resolveExtractConfig(body);
    if (!config) return Response.json({ error: "抽取器未配置（EXTRACT_ENDPOINT / EXTRACT_API_KEY / EXTRACT_MODEL）" }, { status: 400 });

    let text: string;
    let kind: "html" | "pdf" | "text" = "html";
    let finalUrl = canonical;
    let cHash = "";
    try {
      const document = await fetchPublicDocument(canonical);
      text = document.text;
      kind = document.kind;
      finalUrl = document.canonicalUrl;
      cHash = document.contentHash;
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : "网络错误";
      db.prepare("INSERT INTO collection_log (id,url,url_hash,source_name,fetched_at,status,error_msg,content_hash,candidates_count) VALUES (?,?,?,?,?,?,?,?,?)").run(`col-${Date.now()}`, canonical, hash, body.source || canonical, new Date().toISOString(), "error", msg.slice(0, 500), null, 0);
      return Response.json({ error: `抓取失败：${msg}` }, { status: 502 });
    }

    const sourceName = body.source?.trim() || new URL(finalUrl).hostname;

    // 内容判重。上面的 URL 判重只省一次抓取，拦不住转载——
    // 同一份公告挂在巨潮、交易所和一堆媒体上，URL 全不一样，内容逐字相同。
    // 抓完再判是必要的：不抓下来就不知道内容是什么。
    const fingerprint = corpusFingerprint(text);
    const prior = priorSightings(db, fingerprint);
    const repeat = repeatVerdict(prior, sourceName);
    if (repeat && !body.force) {
      db.prepare("INSERT INTO collection_log (id,url,url_hash,source_name,fetched_at,status,error_msg,content_hash,candidates_count) VALUES (?,?,?,?,?,?,?,?,?)").run(`col-${Date.now()}`, canonical, hash, sourceName, new Date().toISOString(), "duplicate", null, cHash, 0);
      return Response.json({ duplicate: true, ...repeat, url: finalUrl, fingerprint, candidates: [] });
    }

    const candidates = await extractRelations(text, { ...config, source: sourceName, sourceUrl: finalUrl });
    const extractedAt = new Date().toISOString();
    recordSighting(db, {
      fingerprint, sourceName, sourceUrl: finalUrl,
      entryPoint: "collect", seenAt: extractedAt, textLength: text.length, candidatesCount: candidates.length,
    });
    db.prepare("INSERT INTO collection_log (id,url,url_hash,source_name,fetched_at,status,error_msg,content_hash,candidates_count) VALUES (?,?,?,?,?,?,?,?,?)").run(`col-${Date.now()}`, canonical, hash, sourceName, extractedAt, "ok", null, cHash, candidates.length);
    return Response.json({ url: finalUrl, source: sourceName, kind, textLength: text.length, contentHash: cHash, fingerprint, candidates, extractedAt, repeatedAnyway: repeat ? repeat.message : undefined });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "采集失败" }, { status: 500 });
  }
}

export async function GET() {
  try {
    ensureWorkspaceSchema();
    const db = getDb(); ensureLogTable(db);
    const logs = db.prepare("SELECT * FROM collection_log ORDER BY rowid DESC LIMIT 50").all() as LogRow[];
    return Response.json({ logs });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "查询采集日志失败" }, { status: 500 });
  }
}
