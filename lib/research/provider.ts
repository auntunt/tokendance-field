import type { ResearchProviderId, ResearchProviderStatus, WebSearchHit } from "./types";

const SEARCH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const SEARCH_TIMEOUT_MS = 28_000;

type ProviderConfig = {
  id: ResearchProviderId;
  endpoint?: string;
  apiKey?: string;
  model?: string;
};

type ResponsesAnnotation = { url?: string; title?: string };
type ResponsesSource = { url?: string; title?: string };
type ResponsesOutput = {
  type?: string;
  action?: { sources?: ResponsesSource[] };
  content?: Array<{ type?: string; text?: string; annotations?: ResponsesAnnotation[] }>;
};
type ResponsesBody = {
  output_text?: string;
  output?: ResponsesOutput[];
  citations?: string[];
  error?: { message?: string };
};

function responseEndpoint(base: string) {
  const cleaned = base.replace(/\/+$/, "");
  return cleaned.endsWith("/responses") ? cleaned : `${cleaned}/responses`;
}

function configuredProvider(): ProviderConfig {
  const requested = String(process.env.RESEARCH_SEARCH_PROVIDER || "auto").toLowerCase();
  const xaiKey = process.env.XAI_API_KEY?.trim();
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();

  if ((requested === "auto" || requested === "xai") && xaiKey) {
    return {
      id: "xai",
      apiKey: xaiKey,
      endpoint: responseEndpoint(process.env.XAI_BASE_URL || "https://api.x.ai/v1"),
      model: process.env.XAI_WEB_SEARCH_MODEL || "grok-4.6",
    };
  }
  if ((requested === "auto" || requested === "openai") && openaiKey) {
    return {
      id: "openai",
      apiKey: openaiKey,
      endpoint: responseEndpoint(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
      model: process.env.OPENAI_WEB_SEARCH_MODEL || "gpt-5",
    };
  }
  if (requested === "anthropic" && anthropicKey) {
    return {
      id: "anthropic",
      apiKey: anthropicKey,
      endpoint: (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1").replace(/\/+$/, "") + "/messages",
      model: process.env.ANTHROPIC_WEB_SEARCH_MODEL || "claude-sonnet-4-6",
    };
  }
  return { id: "bing" };
}

export function getResearchProviderStatus(): ResearchProviderStatus[] {
  const active = configuredProvider();
  return [
    {
      id: "xai", label: "Grok / xAI", configured: Boolean(process.env.XAI_API_KEY?.trim()), active: active.id === "xai",
      model: process.env.XAI_WEB_SEARCH_MODEL || "grok-4.6", mode: "hosted-search",
    },
    {
      id: "openai", label: "OpenAI", configured: Boolean(process.env.OPENAI_API_KEY?.trim()), active: active.id === "openai",
      model: process.env.OPENAI_WEB_SEARCH_MODEL || "gpt-5", mode: "hosted-search",
    },
    {
      id: "anthropic", label: "Anthropic", configured: Boolean(process.env.ANTHROPIC_API_KEY?.trim()), active: active.id === "anthropic",
      model: process.env.ANTHROPIC_WEB_SEARCH_MODEL || "claude-sonnet-4-6", mode: "hosted-search",
    },
    { id: "bing", label: "Bing 网页检索", configured: true, active: active.id === "bing", mode: "html-fallback" },
  ];
}

export function activeResearchProvider() {
  return configuredProvider().id;
}

export function researchSearchGapMs() {
  return configuredProvider().id === "bing" ? 20_000 : 0;
}

function cleanText(value: string) {
  return value.replace(/\[\[\d+\]\]\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

function collectResponseHits(body: ResponsesBody, provider: "xai" | "openai", maxResults: number): WebSearchHit[] {
  const answerParts: string[] = [];
  const found: Array<{ url: string; title: string }> = [];

  for (const item of body.output || []) {
    for (const source of item.action?.sources || []) {
      if (source.url) found.push({ url: source.url, title: source.title || "" });
    }
    for (const content of item.content || []) {
      if (content.text) answerParts.push(content.text);
      for (const annotation of content.annotations || []) {
        if (annotation.url) found.push({ url: annotation.url, title: annotation.title || "" });
      }
    }
  }
  for (const url of body.citations || []) found.push({ url, title: "" });

  const answer = cleanText(body.output_text || answerParts.join(" ")).slice(0, 520);
  const seen = new Set<string>();
  const hits: WebSearchHit[] = [];
  for (const item of found) {
    try {
      const url = new URL(item.url);
      url.hash = "";
      const normalized = url.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      hits.push({
        url: normalized,
        title: cleanText(item.title) || url.hostname,
        snippet: answer,
        provider,
      });
      if (hits.length >= maxResults) break;
    } catch { /* Provider citations can include non-web identifiers. */ }
  }
  return hits;
}

async function hostedSearch(config: ProviderConfig, query: string, maxResults: number): Promise<WebSearchHit[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = {
      model: config.model,
      input: [{ role: "user", content: `检索并核对这个主题。只使用可以打开的原始网页来源，优先法定披露、官方网站和独立媒体；返回与查询直接相关的来源。\n\n查询：${query}` }],
      tools: [{ type: "web_search" }],
    };
    if (config.id === "openai") body.include = ["web_search_call.action.sources"];
    const response = await fetch(config.endpoint!, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
    });
    const data = await response.json() as ResponsesBody;
    if (!response.ok) throw new Error(data.error?.message || `${config.id} 联网搜索失败（${response.status}）`);
    return collectResponseHits(data, config.id as "xai" | "openai", maxResults);
  } finally {
    clearTimeout(timer);
  }
}

function collectAnthropicHits(payload: unknown, maxResults: number): WebSearchHit[] {
  const found: Array<{ url: string; title: string }> = [];
  const texts: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (typeof item.text === "string") texts.push(item.text);
    if (typeof item.url === "string" && /^https?:\/\//.test(item.url)) {
      found.push({ url: item.url, title: typeof item.title === "string" ? item.title : "" });
    }
    Object.values(item).forEach(walk);
  };
  walk(payload);
  const snippet = cleanText(texts.join(" ")).slice(0, 520);
  const seen = new Set<string>();
  const hits: WebSearchHit[] = [];
  for (const item of found) {
    try {
      const url = new URL(item.url); url.hash = "";
      if (seen.has(url.toString())) continue;
      seen.add(url.toString());
      hits.push({ url: url.toString(), title: cleanText(item.title) || url.hostname, snippet, provider: "anthropic" });
      if (hits.length >= maxResults) break;
    } catch { /* Ignore malformed citations. */ }
  }
  return hits;
}

async function anthropicSearch(config: ProviderConfig, query: string, maxResults: number): Promise<WebSearchHit[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(config.endpoint!, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", "x-api-key": config.apiKey!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1200,
        messages: [{ role: "user", content: `检索并核对这个主题。只使用可以打开的原始网页来源，优先法定披露、官方网站和独立媒体。\n\n查询：${query}` }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
      }),
    });
    const data = await response.json() as Record<string, unknown> & { error?: { message?: string } };
    if (!response.ok) throw new Error(data.error?.message || `anthropic 联网搜索失败（${response.status}）`);
    return collectAnthropicHits(data, maxResults);
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtmlEntities(value: string) {
  return value.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

function stripToText(html: string) {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

async function searchBingAt(base: string, query: string, maxResults: number): Promise<WebSearchHit[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${base}/search?q=${encodeURIComponent(query)}&setlang=zh-CN&cc=CN`, {
      signal: controller.signal,
      headers: { "User-Agent": SEARCH_UA, "Accept-Language": "zh-CN,zh;q=0.9", Accept: "text/html" },
    });
    const html = await response.text();
    const results: WebSearchHit[] = [];
    const pattern = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null && results.length < maxResults) {
      const block = match[1];
      const href = /href="(https?:\/\/[^"]+)"/.exec(block)?.[1];
      if (!href || href.includes("bing.com") || href.includes("microsoft.com")) continue;
      results.push({
        url: href,
        title: stripToText(/<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block)?.[1] || ""),
        snippet: stripToText(/<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] || "").slice(0, 320),
        provider: "bing",
      });
    }
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function bingSearch(query: string, maxResults: number) {
  const primary = await searchBingAt("https://cn.bing.com", query, maxResults);
  if (primary.length) return primary;
  return searchBingAt("https://www.bing.com", query, maxResults);
}

export async function searchWeb(query: string, maxResults = 4): Promise<WebSearchHit[]> {
  const config = configuredProvider();
  if (config.id === "bing") return bingSearch(query, maxResults);
  try {
    const hits = config.id === "anthropic"
      ? await anthropicSearch(config, query, maxResults)
      : await hostedSearch(config, query, maxResults);
    if (hits.length) return hits;
  } catch (error) {
    console.warn(`[research] ${config.id} search failed, falling back to Bing:`, error instanceof Error ? error.message : error);
  }
  return bingSearch(query, maxResults);
}
