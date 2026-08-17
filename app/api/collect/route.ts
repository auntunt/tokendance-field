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
import { looksLikePdf, pdfToText } from "../../../lib/pdf-text";

type RequestBody = { url: string; source?: string; model?: string; endpoint?: string; apiKey?: string; force?: boolean };
type LogRow = { id: string; url: string; url_hash: string; source_name: string; fetched_at: string; status: string; error_msg: string | null; content_hash: string | null; candidates_count: number };

const PRIVATE_IP = /^(127\.|0\.0\.0\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1|fc00:|fe80:|fd[0-9a-f]{2}:)/i;
const MAX_BYTES = 500_000;
/** PDF 上限单开一个，比 HTML 宽。披露公告动辄几十页，
 *  实测一份 4 页关联交易公告就 137KB，重组报告书会更大。 */
const MAX_PDF_BYTES = 8_000_000;
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

function decodeEntities(s: string) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, "—")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

function stripToText(fragment: string) {
  return decodeEntities(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** 正文提取。
 *
 *  先抽 <p> 段落，抽不到再退回整页剥标签。原因是实测踩到的：
 *  人民网这类站的导航不用 <nav>/<header> 语义标签，而是 <div class="wy">，
 *  STRIP_TAGS 认不出来。整页剥完 7745 字符里前几千字全是
 *  「党政 时政 人事 反腐 理论…」的栏目名，真正的正文只有 1134 字符。
 *  这些噪音会跟正文一起送进抽取模型，让它在栏目名里找企业主体。
 *
 *  段落法能绕开是因为导航几乎从不用 <p> 包链接列表。
 *  阈值 180：低于这个数说明页面正文不在 <p> 里（或是 JS 渲染的空壳），
 *  此时整页剥标签至少还能留下点东西，交给调用处的长度检查去拦。 */
function htmlToText(html: string) {
  const body = html.replace(STRIP_TAGS, " ");
  const paragraphs = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(match => stripToText(match[1]))
    .filter(text => text.length >= 24 && !/^(上一页|下一页|返回|分享|责编|编辑|来源)/.test(text));
  const joined = paragraphs.join("\n\n");
  if (joined.length >= 180) return joined;
  return stripToText(body);
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

    // 同一个 URL 抓过就不再抓——这一层省的是网络请求，不是判重。
    // 真正的判重在抓完之后按内容做（见下方 corpusFingerprint）。
    const existing = body.force ? undefined : db.prepare("SELECT * FROM collection_log WHERE url_hash=? AND status='ok' ORDER BY fetched_at DESC LIMIT 1").get(hash) as LogRow | undefined;
    if (existing) return Response.json({ duplicate: true, sameUrl: true, previousFetch: existing.fetched_at, candidatesCount: existing.candidates_count, message: `这个网址 ${existing.fetched_at.slice(0, 10)} 抓过了，抽出 ${existing.candidates_count} 条。要重抓就勾上「重抓一遍」。` });

    const config = resolveExtractConfig(body);
    if (!config) return Response.json({ error: "抽取器未配置（EXTRACT_ENDPOINT / EXTRACT_API_KEY / EXTRACT_MODEL）" }, { status: 400 });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let text: string;
    let kind: "html" | "pdf" = "html";
    try {
      // Accept 里带上 application/pdf：交易所的公告详情页会 302 到 PDF，
      // 只声明 text/html 的话有些站点会直接拒。
      const resp = await fetch(safeUrl, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; IntelEngineBot/1.0)", "Accept": "text/html,text/plain;q=0.9,application/pdf;q=0.8", "Accept-Language": "zh-CN,zh;q=0.9" } });
      clearTimeout(timer);
      const ct = resp.headers.get("content-type") || "";
      // 按 URL 和 content-type 两头判断。有些站点给 PDF 发的是
      // application/octet-stream，光看 header 会漏。
      const isPdf = looksLikePdf(resp.url || safeUrl, ct);
      if (!isPdf && !ct.includes("text/html") && !ct.includes("text/plain")) {
        return Response.json({ error: `不支持的内容类型：${ct.split(";")[0]}` }, { status: 400 });
      }
      const buf = await resp.arrayBuffer();
      const limit = isPdf ? MAX_PDF_BYTES : MAX_BYTES;
      if (buf.byteLength > limit) return Response.json({ error: `内容超过 ${limit / 1000}KB 上限` }, { status: 400 });
      if (isPdf) {
        kind = "pdf";
        text = await pdfToText(new Uint8Array(buf));
      } else {
        text = htmlToText(new TextDecoder("utf-8", { fatal: false }).decode(buf));
      }
    } catch (fetchErr) {
      clearTimeout(timer);
      const msg = fetchErr instanceof Error ? fetchErr.message : "网络错误";
      db.prepare("INSERT INTO collection_log (id,url,url_hash,source_name,fetched_at,status,error_msg,content_hash,candidates_count) VALUES (?,?,?,?,?,?,?,?,?)").run(`col-${Date.now()}`, canonical, hash, body.source || canonical, new Date().toISOString(), "error", msg.slice(0, 500), null, 0);
      return Response.json({ error: `抓取失败：${msg}` }, { status: 502 });
    }

    if (text.length < 40) {
      return Response.json({ error: kind === "pdf" ? "PDF 里没提到可读文本，可能是扫描件（图片型 PDF），需要 OCR" : "提取到的文本太短，可能是动态渲染的页面" }, { status: 400 });
    }
    const cHash = contentHash(text);
    const sourceName = body.source?.trim() || new URL(canonical).hostname;

    // 内容判重。上面的 URL 判重只省一次抓取，拦不住转载——
    // 同一份公告挂在巨潮、交易所和一堆媒体上，URL 全不一样，内容逐字相同。
    // 抓完再判是必要的：不抓下来就不知道内容是什么。
    const fingerprint = corpusFingerprint(text);
    const prior = priorSightings(db, fingerprint);
    const repeat = repeatVerdict(prior, sourceName);
    if (repeat && !body.force) {
      db.prepare("INSERT INTO collection_log (id,url,url_hash,source_name,fetched_at,status,error_msg,content_hash,candidates_count) VALUES (?,?,?,?,?,?,?,?,?)").run(`col-${Date.now()}`, canonical, hash, sourceName, new Date().toISOString(), "duplicate", null, cHash, 0);
      return Response.json({ duplicate: true, ...repeat, url: canonical, fingerprint, candidates: [] });
    }

    const candidates = await extractRelations(text, { ...config, source: sourceName, sourceUrl: canonical });
    const extractedAt = new Date().toISOString();
    recordSighting(db, {
      fingerprint, sourceName, sourceUrl: canonical,
      entryPoint: "collect", seenAt: extractedAt, textLength: text.length, candidatesCount: candidates.length,
    });
    db.prepare("INSERT INTO collection_log (id,url,url_hash,source_name,fetched_at,status,error_msg,content_hash,candidates_count) VALUES (?,?,?,?,?,?,?,?,?)").run(`col-${Date.now()}`, canonical, hash, sourceName, extractedAt, "ok", null, cHash, candidates.length);
    return Response.json({ url: canonical, source: sourceName, kind, textLength: text.length, contentHash: cHash, fingerprint, candidates, extractedAt, repeatedAnyway: repeat ? repeat.message : undefined });
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
