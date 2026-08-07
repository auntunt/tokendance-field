// Phase 4 采集器：接收 URL，抓取页面，提取可读文本，调用共享抽取函数。
// 不经过 /api/extract 的 HTTP 层（避免 Basic Auth 二次验证问题）。
//
// SSRF 防御：禁止私有地址段、回环和 file:// 协议。
// 去重：URL 规范化后哈希，命中已采集记录直接返回 duplicate。
export const dynamic = "force-dynamic";

import { createHash } from "node:crypto";
import { getDb, ensureWorkspaceSchema } from "../../../db";
import { extractRelations, resolveExtractConfig } from "../../../lib/extractor";

type RequestBody = { url: string; source?: string; model?: string; endpoint?: string; apiKey?: string };
type LogRow = { id: string; url: string; url_hash: string; source_name: string; fetched_at: string; status: string; error_msg: string | null; content_hash: string | null; candidates_count: number };

const PRIVATE_IP = /^(127\.|0\.0\.0\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1|fc00:|fe80:|fd[0-9a-f]{2}:)/i;
const MAX_BYTES = 500_000;
const STRIP_TAGS = /<(script|style|noscript|head|nav|footer|header|aside|iframe|figure|svg)[^>]*>[\s\S]*?<\/\1>/gi;

function ssrfGuard(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("无法解析该 URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("只允许 http/https 协议");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || PRIVATE_IP.test(host)) throw new Error("不允许请求内部地址");
  return url.toString();
}

function canonicalUrl(raw: string) {
  const url = new URL(raw); url.hash = "";
  ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach(k => url.searchParams.delete(k));
  return url.toString();
}

function htmlToText(html: string) {
  return html.replace(STRIP_TAGS, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ").trim();
}

function urlHash(s: string) { return createHash("sha256").update(s).digest("hex").slice(0, 16); }
function contentHash(s: string) { return createHash("sha256").update(s.slice(0, 50_000)).digest("hex").slice(0, 16); }

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
    const safeUrl = ssrfGuard(String(body.url ?? "").trim());
    const canonical = canonicalUrl(safeUrl);
    const hash = urlHash(canonical);
    ensureWorkspaceSchema();
    const db = getDb(); ensureLogTable(db);

    const existing = db.prepare("SELECT * FROM collection_log WHERE url_hash=? AND status='ok' ORDER BY fetched_at DESC LIMIT 1").get(hash) as LogRow | undefined;
    if (existing) return Response.json({ duplicate: true, previousFetch: existing.fetched_at, candidatesCount: existing.candidates_count });

    const config = resolveExtractConfig(body);
    if (!config) return Response.json({ error: "抽取器未配置（EXTRACT_ENDPOINT / EXTRACT_API_KEY / EXTRACT_MODEL）" }, { status: 400 });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let html: string;
    try {
      const resp = await fetch(safeUrl, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; IntelEngineBot/1.0)", "Accept": "text/html,text/plain;q=0.9", "Accept-Language": "zh-CN,zh;q=0.9" } });
      clearTimeout(timer);
      const ct = resp.headers.get("content-type") || "";
      if (!ct.includes("text/html") && !ct.includes("text/plain")) return Response.json({ error: `不支持的内容类型：${ct.split(";")[0]}` }, { status: 400 });
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) return Response.json({ error: `页面超过 ${MAX_BYTES / 1000}KB 上限` }, { status: 400 });
      html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    } catch (fetchErr) {
      clearTimeout(timer);
      const msg = fetchErr instanceof Error ? fetchErr.message : "网络错误";
      db.prepare("INSERT INTO collection_log (id,url,url_hash,source_name,fetched_at,status,error_msg,content_hash,candidates_count) VALUES (?,?,?,?,?,?,?,?,?)").run(`col-${Date.now()}`, canonical, hash, body.source || canonical, new Date().toISOString(), "error", msg.slice(0, 500), null, 0);
      return Response.json({ error: `抓取失败：${msg}` }, { status: 502 });
    }

    const text = htmlToText(html);
    if (text.length < 40) return Response.json({ error: "提取到的文本太短，可能是动态渲染的页面" }, { status: 400 });
    const cHash = contentHash(text);
    const sourceName = body.source?.trim() || new URL(canonical).hostname;

    const candidates = await extractRelations(text, { ...config, source: sourceName, sourceUrl: canonical });
    db.prepare("INSERT INTO collection_log (id,url,url_hash,source_name,fetched_at,status,error_msg,content_hash,candidates_count) VALUES (?,?,?,?,?,?,?,?,?)").run(`col-${Date.now()}`, canonical, hash, sourceName, new Date().toISOString(), "ok", null, cHash, candidates.length);
    return Response.json({ url: canonical, source: sourceName, textLength: text.length, contentHash: cHash, candidates, extractedAt: new Date().toISOString() });
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
