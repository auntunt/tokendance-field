import type { ResearchFinding, ResearchMemo, ResearchProviderId, ResearchProviderStatus, WebSearchHit } from "./types";

const SEARCH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
// 联网情报研究不是即时搜索。兼容中转的 web_search 经常需要读数个页面后
// 才返回引用；28 秒会把正常的研究误判为失败，再悄悄退回 Bing。
const DEFAULT_HOSTED_SEARCH_TIMEOUT_MS = 180_000;
const DEFAULT_RESEARCH_MEMO_TIMEOUT_MS = 180_000;

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

function researchTimeoutMs(name: "RESEARCH_WEB_SEARCH_TIMEOUT_MS" | "RESEARCH_LLM_TIMEOUT_MS", fallback: number, minimum: number) {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) ? Math.max(minimum, configured) : fallback;
}

function hostedSearchTimeoutMs() {
  return researchTimeoutMs("RESEARCH_WEB_SEARCH_TIMEOUT_MS", DEFAULT_HOSTED_SEARCH_TIMEOUT_MS, 30_000);
}

function researchMemoTimeoutMs() {
  return researchTimeoutMs("RESEARCH_LLM_TIMEOUT_MS", DEFAULT_RESEARCH_MEMO_TIMEOUT_MS, 60_000);
}

function responseText(body: ResponsesBody) {
  const parts: string[] = [];
  if (body.output_text) parts.push(body.output_text);
  for (const item of body.output || []) {
    for (const content of item.content || []) if (content.text) parts.push(content.text);
  }
  return cleanText(parts.join("\n"));
}

function citedUrls(body: ResponsesBody) {
  const urls = new Set<string>();
  const take = (value?: string) => {
    if (!value) return;
    try { const url = new URL(value); url.hash = ""; urls.add(url.toString()); } catch { /* Ignore non-web citations. */ }
  };
  for (const item of body.output || []) {
    for (const source of item.action?.sources || []) take(source.url);
    for (const content of item.content || []) for (const annotation of content.annotations || []) take(annotation.url);
  }
  for (const url of body.citations || []) take(url);
  return [...urls];
}

function jsonFromModel(text: string): Record<string, unknown> | null {
  const plain = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = plain.indexOf("{"); const end = plain.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try { return JSON.parse(plain.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
}

function compact(value: unknown, limit: number) { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit); }

function normalizeFinding(value: unknown, allowedUrls: Set<string>): ResearchFinding | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const sourceUrl = compact(raw.sourceUrl, 1200);
  let normalizedUrl = "";
  try { const url = new URL(sourceUrl); url.hash = ""; normalizedUrl = url.toString(); } catch { return null; }
  // 模型产出只能引用本轮工具实际返回的网页，避免把“看似合理”的链接伪造成来源。
  if (!allowedUrls.has(normalizedUrl)) return null;
  const edges = Array.isArray(raw.edges) ? raw.edges.flatMap(edge => {
    if (!edge || typeof edge !== "object") return [];
    const item = edge as Record<string, unknown>;
    const from = compact(item.from, 120), to = compact(item.to, 120);
    const relation = compact(item.relation, 40);
    const quote = compact(item.quote, 600);
    if (!from || !to || !quote || ![
      "equity", "supply", "compete", "personnel", "license",
      "organization", "product", "deployment", "partnership",
    ].includes(relation)) return [];
    return [{ from, to, relation, direction: item.direction === "mutual" ? "mutual" as const : "forward" as const, quote }];
  }) : [];
  const title = compact(raw.title, 240), evidence = compact(raw.evidence, 1600);
  if (!title || evidence.length < 16) return null;
  return { title, evidence, sourceUrl: normalizedUrl, sourceTitle: compact(raw.sourceTitle, 240) || new URL(normalizedUrl).hostname, dimension: compact(raw.dimension, 80) || "business", edges };
}

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

/** 给界面用的保守预期：首次可读初稿不追求秒回。 */
export function researchFirstDraftEstimateMs() {
  return configuredProvider().id === "bing" ? 20_000 : Math.min(researchMemoTimeoutMs(), 120_000);
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
  const timer = setTimeout(() => controller.abort(), hostedSearchTimeoutMs());
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

/**
 * 把联网模型当研究员，而非 URL 枚举器。模型的初稿保留结论与引用；
 * 网页抓取仍会在后续阶段做原文复核，但不会再决定初稿是否存在。
 */
export async function researchWithLLM(input: {
  question: string;
  entityName: string;
  dimensions: string[];
  /** A dossier deliberately researches several independent angles instead of
   * treating one web-search response as the whole answer. */
  lens?: { title: string; instruction: string };
}): Promise<ResearchMemo | null> {
  const config = configuredProvider();
  if (config.id !== "xai" && config.id !== "openai") return null;
  const controller = new AbortController();
  // Some hosted web-search providers take longer than ordinary completions
  // because they are reading several pages before returning citations. Keep
  // this independently configurable, rather than silently giving up at 90s.
  const timeoutMs = researchMemoTimeoutMs();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(config.endpoint!, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        input: [{ role: "user", content: `你是企业情报研究员。请联网研究以下问题，并只输出 JSON（不要 Markdown）：\n\n问题：${input.question}\n主体：${input.entityName}\n本轮研究角度：${input.lens?.title || "综合研究"}\n本轮要求：${input.lens?.instruction || "梳理与问题最相关、可公开核对的事实。"}\n关注维度：${input.dimensions.join("、")}\n\nJSON 格式：\n{"summary":"给决策者读的2-4句初稿","findings":[{"title":"可阅读的具体发现","evidence":"来源中支持该发现的原文摘录或精确转述","sourceUrl":"必须来自本轮联网工具返回的网页URL","sourceTitle":"来源标题","dimension":"业务/融资/团队等","edges":[{"from":"主体","to":"主体","relation":"equity|supply|compete|personnel|license|organization|product|deployment|partnership","direction":"forward|mutual","quote":"来源中的关系原文"}]}],"openQuestions":["仍待验证的问题"]}\n\n规则：优先法定披露、官网和独立媒体；最多 6 条发现；没有明确主体关系时 edges 为空数组；不要编造 URL 或关系；把战略、产品、部署进展和商业化证据分开。组织部门、产品、项目或落地场景也可以作为图谱节点，但只能在引用原文明确说出归属、负责、发布或部署关系时输出。每条发现都必须能追溯到本轮工具实际返回的 URL。` }],
        tools: [{ type: "web_search" }],
      }),
    });
    const body = await response.json() as ResponsesBody;
    if (!response.ok) throw new Error(body.error?.message || `${config.id} 联网研究失败（${response.status}）`);
    const sourceUrls = citedUrls(body);
    const allowed = new Set(sourceUrls);
    const parsed = jsonFromModel(responseText(body));
    if (!parsed) return null;
    const findings = (Array.isArray(parsed.findings) ? parsed.findings : []).map(item => normalizeFinding(item, allowed)).filter((item): item is ResearchFinding => Boolean(item)).slice(0, 6);
    const openQuestions = (Array.isArray(parsed.openQuestions) ? parsed.openQuestions : []).map(item => compact(item, 220)).filter(Boolean).slice(0, 5);
    const summary = compact(parsed.summary, 1800);
    if (!summary && !findings.length) return null;
    return { summary, findings, openQuestions, sourceUrls, provider: config.id };
  } catch (error) {
    console.warn(`[research] ${config.id} research memo failed:`, error instanceof Error ? error.message : error);
    return null;
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
  const timer = setTimeout(() => controller.abort(), hostedSearchTimeoutMs());
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
