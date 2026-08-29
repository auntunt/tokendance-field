import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { looksLikePdf, pdfToText } from "../pdf-text";

const PRIVATE_IPV6 = /^(::1$|::$|fc|fd|fe8|fe9|fea|feb)/i;
const STRIP_TAGS = /<(script|style|noscript|head|nav|footer|header|aside|iframe|figure|svg)[^>]*>[\s\S]*?<\/\1>/gi;

export type PublicDocument = {
  url: string;
  canonicalUrl: string;
  title: string;
  text: string;
  kind: "html" | "pdf" | "text";
  contentType: string;
  bytes: number;
  contentHash: string;
};

export function canonicalUrl(raw: string) {
  const url = new URL(raw);
  url.hash = "";
  ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach(key => url.searchParams.delete(key));
  return url.toString();
}

function isPrivateAddress(address: string) {
  if (address.toLowerCase().startsWith("::ffff:")) return isPrivateAddress(address.slice(7));
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  return isIP(address) === 6 ? PRIVATE_IPV6.test(address) : true;
}

async function assertPublicUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("无法解析该 URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只允许 http/https 协议");
  if (url.username || url.password) throw new Error("URL 不允许携带账号凭据");
  if (url.hostname.toLowerCase() === "localhost") throw new Error("不允许请求内部地址");
  if (isIP(url.hostname) && isPrivateAddress(url.hostname)) throw new Error("不允许请求内部地址");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error("目标域名解析到内部地址");
  return url;
}

function decodeEntities(value: string) {
  return value.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, "—")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

function stripToText(fragment: string) {
  return decodeEntities(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function htmlToText(html: string) {
  const body = html.replace(STRIP_TAGS, " ");
  const paragraphs = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(match => stripToText(match[1]))
    .filter(text => text.length >= 24 && !/^(上一页|下一页|返回|分享|责编|编辑|来源)/.test(text));
  const joined = paragraphs.join("\n\n");
  return joined.length >= 180 ? joined : stripToText(body);
}

function pageTitle(html: string) {
  return stripToText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").slice(0, 300);
}

export function contentHash(text: string) {
  return createHash("sha256").update(text.slice(0, 200_000)).digest("hex").slice(0, 24);
}

export async function fetchPublicDocument(raw: string, options: {
  timeoutMs?: number;
  maxHtmlBytes?: number;
  maxPdfBytes?: number;
  userAgent?: string;
} = {}): Promise<PublicDocument> {
  const timeoutMs = options.timeoutMs || 20_000;
  const maxHtmlBytes = options.maxHtmlBytes || 500_000;
  const maxPdfBytes = options.maxPdfBytes || 8_000_000;
  const userAgent = options.userAgent || "Mozilla/5.0 (compatible; IntelEngineBot/1.0)";
  let current = (await assertPublicUrl(raw)).toString();

  for (let redirect = 0; redirect <= 4; redirect++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(current, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": userAgent, Accept: "text/html,text/plain;q=0.9,application/pdf;q=0.8", "Accept-Language": "zh-CN,zh;q=0.9" },
      });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("页面重定向缺少目标地址");
      current = (await assertPublicUrl(new URL(location, current).toString())).toString();
      continue;
    }
    if (!response.ok) throw new Error(`页面返回 ${response.status}`);

    const contentType = response.headers.get("content-type") || "";
    const isPdf = looksLikePdf(current, contentType);
    if (!isPdf && !contentType.includes("text/html") && !contentType.includes("text/plain")) {
      throw new Error(`不支持的内容类型：${contentType.split(";")[0] || "未知"}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const limit = isPdf ? maxPdfBytes : maxHtmlBytes;
    if (bytes.byteLength > limit) throw new Error(`内容超过 ${Math.round(limit / 1000)}KB 上限`);

    let text: string;
    let title = "";
    let kind: PublicDocument["kind"];
    if (isPdf) {
      kind = "pdf";
      text = await pdfToText(bytes);
    } else {
      const rawText = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      kind = contentType.includes("text/plain") ? "text" : "html";
      title = kind === "html" ? pageTitle(rawText) : "";
      text = kind === "html" ? htmlToText(rawText) : rawText.trim();
    }
    if (text.length < 40) throw new Error(kind === "pdf" ? "PDF 没有可读文本，可能需要 OCR" : "页面正文太短，可能依赖动态渲染");
    const finalUrl = canonicalUrl(current);
    return { url: current, canonicalUrl: finalUrl, title, text, kind, contentType, bytes: bytes.byteLength, contentHash: contentHash(text) };
  }
  throw new Error("页面重定向次数过多");
}
