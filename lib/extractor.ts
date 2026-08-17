// 企业关系抽取器——纯函数，不依赖 Next.js。
// extract/route.ts 和 collect/route.ts 都引用这里，避免经过 HTTP + Auth 层。
type RawEdge = { from?: unknown; to?: unknown; relation?: unknown; direction?: unknown; quote?: unknown; fromKind?: unknown; toKind?: unknown };
type RawCandidate = { title?: unknown; evidence?: unknown; relation?: unknown; edges?: unknown };

/** 主体的本体类型。抽真实报道时踩到的：报道极少写法人全称。
 *  实测 10 个主体里 5 个不是法人——「昆仑云」是品牌（同篇里「昆仑云晟（北京）科技有限公司」才是法人）、
 *  「韶关数据中心集群」「万洋众创城」是园区、「巴斯夫（广东）一体化基地」是项目、
 *  上一批还抽到过「海油安澜号」这种设备名。
 *
 *  这些主体进台账就跟工商数据对不上，关系图会长出连不上的孤岛节点。
 *  六道门管不了这件事：门问的是「这个判断的证据够不够」，
 *  不问「这个主体在现实中是不是一个能签合同的法人」。是本体问题，不是纪律问题。
 *  所以不加第七道门，而是在抽取层就把类型标出来，让人在写入时补法人名。 */
export const ENTITY_KINDS = ["legal", "brand", "project", "site", "asset", "unknown"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export type CandidateEdge = { from: string; to: string; relation: string; direction: "forward" | "mutual"; quote: string; fromKind: EntityKind; toKind: EntityKind };
export type ExtractedCandidate = { title: string; evidence: string; source: string; sourceUrl?: string; suggestedRelation: string; edges: CandidateEdge[] };

const RELATION_IDS = ["equity", "supply", "compete", "personnel", "license"] as const;
const MAX_TEXT = 12000;
const MAX_CANDIDATES = 12;

const EXTRACT_SYSTEM = `你是企业关系情报的抽取器，不是分析师。你的唯一任务：从给定的公开语料中，找出可核查的"主体—主体"关系事实。

硬规则：
1. 只抽取语料里明确写出的关系。语料没写的，一律不抽——不要用常识、不要用你的先验知识补全。
2. 每条关系必须给出 quote：语料中支撑它的原文片段，逐字复制，不改写、不翻译、不省略成摘要。
3. 主体名用语料里出现的全称或最完整的称法。不要缩写成简称，不要把"公司"、"该公司"这类指代当作主体名。
3b. 每个主体必须标注它到底是什么（fromKind / toKind），只能取：
   legal   = 法人实体，名称是可注册的公司/机构全称（如"昆仑云晟（北京）科技有限公司"）
   brand   = 品牌名、平台名、业务线名，背后的法人语料没写（如"昆仑云"）
   project = 项目名、工程名、基地名（如"巴斯夫（广东）一体化基地"）
   site    = 园区、集群、场所（如"万洋众创城"、"韶关数据中心集群"）
   asset   = 设备、船舶、机组等物（如"海油安澜号"）
   unknown = 判断不了
   按语料写法判断，不要用你的先验知识去猜某个品牌背后的法人是谁。
   同一篇语料里若既出现品牌名又出现对应法人全称，主体名优先用法人全称并标 legal。
4. 关系类型只能取：equity(投资持股) / supply(供应采购) / compete(竞争替代) / personnel(人事交叉) / license(技术授权)。取不准就选最接近的一个，不要自造类型。
5. direction: forward 表示 from 指向 to（如 A 持股 B、A 供货给 B）；mutual 表示对称关系（如互为竞争对手）。
6. 不要给出概率、置信度或结论性判断。判断由人做，你只负责把事实切出来。
7. 语料里没有任何企业关系时，返回空数组。宁可空手，不要编造。

只输出严格 JSON，不要 Markdown 代码块：
{"candidates":[{"title":"一句话说明谁和谁发生了什么关系","evidence":"该关系在语料中的完整上下文，可多句，须来自原文","relation":"equity|supply|compete|personnel|license","edges":[{"from":"主体全称","to":"主体全称","fromKind":"legal|brand|project|site|asset|unknown","toKind":"legal|brand|project|site|asset|unknown","relation":"equity|supply|compete|personnel|license","direction":"forward|mutual","quote":"逐字原文片段"}]}]}`;

const SIMULATE_SYSTEM = `你是沙盘推演助手。任务：给定一个假设场景，生成若该场景成立则应当能观察到的情报信号候选。
这些候选是假设性的，不是事实。每条候选要说明：如果场景成立，应能在什么来源找到什么证据。
关系类型只能取：equity / supply / compete / personnel / license。
宁可少生成，不要空泛。场景过于模糊时，返回空数组。
输出格式与抽取器完全相同：只输出严格 JSON，不要 Markdown：
主体同样要标 fromKind / toKind：legal(法人全称) / brand(品牌) / project(项目) / site(园区场所) / asset(设备物) / unknown。
{"candidates":[{"title":"…","evidence":"（假设）…","relation":"…","edges":[{"from":"…","to":"…","fromKind":"legal|brand|project|site|asset|unknown","toKind":"legal|brand|project|site|asset|unknown","relation":"…","direction":"forward|mutual","quote":"（假设）…"}]}]}`;

function normalizeRelation(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  return (RELATION_IDS as readonly string[]).includes(text) ? text : "equity";
}

/** 认不出来的一律落 unknown，不落 legal。
 *  这里必须往"存疑"一侧倒：漏标一个 legal 只是多让人确认一次，
 *  错标成 legal 就是把品牌名当法人放进台账，且不会再有人复核。 */
function normalizeKind(value: unknown): EntityKind {
  const text = String(value ?? "").trim().toLowerCase();
  return (ENTITY_KINDS as readonly string[]).includes(text) ? text as EntityKind : "unknown";
}

/** 主体名带这些尾缀的，无论模型标了什么都按对应类型算。
 *  模型偶尔会把"XX基地""XX产业园"标成 legal，字面证据比模型判断可靠。 */
const KIND_BY_SUFFIX: Array<[RegExp, EntityKind]> = [
  [/(有限公司|股份公司|集团有限公司|有限责任公司|合伙企业|事务所|研究院|大学|银行$|支行$|分行$)/, "legal"],
  [/(基地|工程|项目|中心建设)$/, "project"],
  [/(园区|产业园|众创城|集群|开发区|厂区|车间)$/, "site"],
];

/** 尾缀能定性时用尾缀，否则用模型标注。返回值只用于提示人，不阻断写入。 */
export function classifyEntity(name: string, declared: unknown): EntityKind {
  for (const [pattern, kind] of KIND_BY_SUFFIX) if (pattern.test(name)) return kind;
  return normalizeKind(declared);
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

export async function extractRelations(corpus: string, config: ExtractConfig, timeoutMs = 180_000): Promise<ExtractedCandidate[]> {
  const systemPrompt = config.mode === "simulate" ? SIMULATE_SYSTEM : EXTRACT_SYSTEM;
  const userMsg = config.mode === "simulate"
    ? `沙盘场景：${corpus.slice(0, MAX_TEXT)}`
    : `来源：${config.source}\n\n语料原文：\n${corpus.slice(0, MAX_TEXT)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(config.endpoint, {
      method: "POST",
      signal: controller.signal,
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
        .map(e => {
          const from = str(e.from, 120), to = str(e.to, 120);
          return { from, to, relation: normalizeRelation(e.relation ?? item.relation), direction: String(e.direction ?? "forward") === "mutual" ? "mutual" as const : "forward" as const, quote: str(e.quote, 600), fromKind: classifyEntity(from, e.fromKind), toKind: classifyEntity(to, e.toKind) };
        })
        .filter(e => e.from && e.to && e.from !== e.to);
      return { title: str(item.title, 200), evidence: str(item.evidence, 4000), source: config.source, sourceUrl: config.sourceUrl, suggestedRelation: normalizeRelation(item.relation ?? edges[0]?.relation), edges };
    }).filter(c => c.title && c.evidence.length >= 20 && c.edges.length > 0);
  } finally {
    clearTimeout(timer);
  }
}
