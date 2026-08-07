// 企业关系抽取器——纯函数，不依赖 Next.js。
// extract/route.ts 和 collect/route.ts 都引用这里，避免经过 HTTP + Auth 层。
type RawEdge = { from?: unknown; to?: unknown; relation?: unknown; direction?: unknown; quote?: unknown };
type RawCandidate = { title?: unknown; evidence?: unknown; relation?: unknown; edges?: unknown };

export type CandidateEdge = { from: string; to: string; relation: string; direction: "forward" | "mutual"; quote: string };
export type ExtractedCandidate = { title: string; evidence: string; source: string; sourceUrl?: string; suggestedRelation: string; edges: CandidateEdge[] };

const RELATION_IDS = ["equity", "supply", "compete", "personnel", "license"] as const;
const MAX_TEXT = 12000;
const MAX_CANDIDATES = 12;

const EXTRACT_SYSTEM = `你是企业关系情报的抽取器，不是分析师。你的唯一任务：从给定的公开语料中，找出可核查的"主体—主体"关系事实。

硬规则：
1. 只抽取语料里明确写出的关系。语料没写的，一律不抽——不要用常识、不要用你的先验知识补全。
2. 每条关系必须给出 quote：语料中支撑它的原文片段，逐字复制，不改写、不翻译、不省略成摘要。
3. 主体名用语料里出现的全称或最完整的称法。不要缩写成简称，不要把"公司"、"该公司"这类指代当作主体名。
4. 关系类型只能取：equity(投资持股) / supply(供应采购) / compete(竞争替代) / personnel(人事交叉) / license(技术授权)。取不准就选最接近的一个，不要自造类型。
5. direction: forward 表示 from 指向 to（如 A 持股 B、A 供货给 B）；mutual 表示对称关系（如互为竞争对手）。
6. 不要给出概率、置信度或结论性判断。判断由人做，你只负责把事实切出来。
7. 语料里没有任何企业关系时，返回空数组。宁可空手，不要编造。

只输出严格 JSON，不要 Markdown 代码块：
{"candidates":[{"title":"一句话说明谁和谁发生了什么关系","evidence":"该关系在语料中的完整上下文，可多句，须来自原文","relation":"equity|supply|compete|personnel|license","edges":[{"from":"主体全称","to":"主体全称","relation":"equity|supply|compete|personnel|license","direction":"forward|mutual","quote":"逐字原文片段"}]}]}`;

const SIMULATE_SYSTEM = `你是沙盘推演助手。任务：给定一个假设场景，生成若该场景成立则应当能观察到的情报信号候选。
这些候选是假设性的，不是事实。每条候选要说明：如果场景成立，应能在什么来源找到什么证据。
关系类型只能取：equity / supply / compete / personnel / license。
宁可少生成，不要空泛。场景过于模糊时，返回空数组。
输出格式与抽取器完全相同：只输出严格 JSON，不要 Markdown：
{"candidates":[{"title":"…","evidence":"（假设）…","relation":"…","edges":[{"from":"…","to":"…","relation":"…","direction":"forward|mutual","quote":"（假设）…"}]}]}`;

function normalizeRelation(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  return (RELATION_IDS as readonly string[]).includes(text) ? text : "equity";
}
function str(value: unknown, limit: number) { return String(value ?? "").trim().slice(0, limit); }
function jsonFrom(text: string) {
  const fenced = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
  const start = fenced.indexOf("{"); const end = fenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("模型未返回可读取的 JSON");
  return JSON.parse(fenced.slice(start, end + 1)) as { candidates?: unknown };
}

export type ExtractConfig = { endpoint: string; apiKey: string; model: string; source: string; sourceUrl?: string; mode?: "extract" | "simulate" };

/** 三个都得有才算配置好；缺一个返回 null，由调用方决定报什么错。 */
export function resolveExtractConfig(body: { endpoint?: string; apiKey?: string; model?: string }) {
  const endpoint = body.endpoint?.trim() || process.env.EXTRACT_ENDPOINT?.trim();
  const apiKey = body.apiKey?.trim() || process.env.EXTRACT_API_KEY?.trim();
  const model = body.model?.trim() || process.env.EXTRACT_MODEL?.trim();
  if (!endpoint || !apiKey || !model) return null;
  return { endpoint, apiKey, model };
}

export async function extractRelations(corpus: string, config: ExtractConfig): Promise<ExtractedCandidate[]> {
  const systemPrompt = config.mode === "simulate" ? SIMULATE_SYSTEM : EXTRACT_SYSTEM;
  const userMsg = config.mode === "simulate"
    ? `沙盘场景：${corpus.slice(0, MAX_TEXT)}`
    : `来源：${config.source}\n\n语料原文：\n${corpus.slice(0, MAX_TEXT)}`;

  const upstream = await fetch(config.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }], response_format: { type: "json_object" }, temperature: 0.1 }),
  });
  const raw = await upstream.text();
  if (!upstream.ok) throw Object.assign(new Error(`抽取服务返回 ${upstream.status}`), { detail: raw.slice(0, 500) });

  const payload = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content ?? "";
  const parsed = jsonFrom(content);
  const list = Array.isArray(parsed.candidates) ? (parsed.candidates as RawCandidate[]) : [];

  return list.slice(0, MAX_CANDIDATES).map(item => {
    const edges = (Array.isArray(item.edges) ? item.edges as RawEdge[] : [])
      .map(e => ({ from: str(e.from, 120), to: str(e.to, 120), relation: normalizeRelation(e.relation ?? item.relation), direction: String(e.direction ?? "forward") === "mutual" ? "mutual" as const : "forward" as const, quote: str(e.quote, 600) }))
      .filter(e => e.from && e.to && e.from !== e.to);
    return { title: str(item.title, 200), evidence: str(item.evidence, 4000), source: config.source, sourceUrl: config.sourceUrl, suggestedRelation: normalizeRelation(item.relation ?? edges[0]?.relation), edges };
  }).filter(c => c.title && c.evidence.length >= 20 && c.edges.length > 0);
}
