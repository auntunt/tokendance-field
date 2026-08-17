// 自动起草 / 口语修改约束。大模型只写草稿，永远不能签署。
//
// 两个模式：
//   propose —— 给一条刚收下的情报，把范围、认识状态、证伪、反例、来源、有效期、
//              概率全部起草出来；确定性规则先填，大模型补需要推理的部分。
//   patch   —— 用户用一句口语说要改什么（"概率改成70""有效期到年底"），
//              大模型按这句话修改当前约束，其余字段原样保留。
//
// 边界写死：
//   1. signedOff 永远 false。模型填得再满，最后一下必须由人签。
//   2. 推不出来的字段宁可留空，不用「未知」占位——门 2 会把占位词按没填算。
//   3. independent 只在链接指向法定披露渠道时允许；否则最多 related。
//   4. internal 必须带 humanSource，否则退回 related。

export const dynamic = "force-dynamic";

import { resolveExtractConfig } from "../../../lib/extractor";
import { proposeConstraints, DISCLOSURE_HOSTS } from "../../../lib/auto-propose";

type EnrichSignal = {
  id?: string;
  title: string;
  evidence: string;
  source: string;
  sourceUrl?: string;
  origin?: string;
  edges?: Array<{ from: string; to: string; relation?: string }>;
  constraints?: {
    scope?: Record<string, string>;
    epistemicState?: string;
    falsifier?: string;
    counterEvidence?: string;
    sourceType?: string;
    validUntil?: string;
    probability?: number;
    humanSource?: string;
  };
};

type RequestBody = {
  signal: EnrichSignal;
  instruction?: string;
  mode?: "propose" | "patch";
};

const SCOPE_KEYS = ["entityScope", "marketRegion", "dataBasis", "timeWindow", "ourAccess"] as const;
const EPISTEMIC = ["observation", "interpretation", "hypothesis", "action"];
const SOURCE_TYPES = ["unknown", "independent", "related", "internal"];

const ENRICH_SYSTEM = `你是情报判断的草稿员。你会收到一条原始情报、当前已有的约束草稿，以及用户可能给的一句口语修改要求。

你的任务：输出一套完整、可编辑的约束草稿。这是草稿，不是签署。

硬规则：
1. scope 五个字段：entityScope（涉及哪几家公司，尽量用法人全称）、marketRegion（哪个市场或地区，没有就写「没有明确地域边界」）、dataBasis（数字按什么口径，没有就写「没有可对齐的数字口径」）、timeWindow（材料时点起算的时间窗口，给具体日期范围）、ourAccess（我们能拿它做什么，没有就写「暂无明确用途」）。
2. epistemicState 只能是 observation / interpretation / hypothesis / action。
3. falsifier：写「出现什么公开事实，这条判断必须被推翻」，要具体可观察。
4. counterEvidence：写「目前最强反面证据」；确实没有就写找过哪里、为什么没有，不要写「未知」。
5. sourceType 只能是 unknown / independent / related / internal。没有十足把握时写 related。
6. validUntil 必须是 YYYY-MM-DD。材料没有明确期限时，从材料时点或今天起约 90 天。
7. probability 是 5 到 95 的整数，代表校准后的成立概率，不是「我觉得」。
8. humanSource 只有 sourceType=internal 时给；只写职务与场合，不写私事。
9. 如果用户有口语修改要求，只改他要求涉及的字段，其他字段保持 current 原样。
10. 只输出严格 JSON，不要 Markdown。

输出格式：
{"summary":"一句话说明起草依据","constraints":{"scope":{"entityScope":"","marketRegion":"","dataBasis":"","timeWindow":"","ourAccess":""},"epistemicState":"hypothesis","falsifier":"","counterEvidence":"","sourceType":"related","validUntil":"YYYY-MM-DD","probability":60,"humanSource":""}}`;

function jsonFrom(text: string) {
  const fenced = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("模型未返回可读取的 JSON");
  return JSON.parse(fenced.slice(start, end + 1)) as {
    summary?: string;
    constraints?: Record<string, unknown>;
  };
}

function payloadText(payload: unknown): string {
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

function textOf(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function dateOf(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  const direct = /^\d{4}-\d{2}-\d{2}$/.exec(text);
  if (direct) return direct[0];
  const parts = /(\d{4})\s*[年/-]\s*(\d{1,2})\s*[月/-]\s*(\d{1,2})/.exec(text);
  if (parts) {
    const y = +parts[1], m = +parts[2], d = +parts[3];
    if (y >= 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  return fallback;
}

function clampProbability(value: unknown, fallback = 50): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(5, Math.min(95, n));
}

function hostOf(url?: string): string {
  if (!url) return "";
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function sanitizeSourceType(value: unknown, signal: EnrichSignal, current: string): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (SOURCE_TYPES.includes(text)) {
    if (text === "independent") {
      const host = hostOf(signal.sourceUrl);
      const disclosure = DISCLOSURE_HOSTS.some((item: string) => host === item || host.endsWith(`.${item}`));
      return disclosure ? "independent" : "related";
    }
    if (text === "internal" && !textOf(signal.constraints?.humanSource)) return current || "related";
    return text;
  }
  return current || "related";
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as RequestBody;
    const signal = body.signal;
    if (!signal?.title || !signal?.evidence) return Response.json({ error: "缺少情报标题或原始依据" }, { status: 400 });

    const config = resolveExtractConfig({});
    if (!config) return Response.json({ error: "抽取器未配置（EXTRACT_ENDPOINT / EXTRACT_API_KEY / EXTRACT_MODEL）" }, { status: 503 });

    // 确定性提议先跑一遍：范围和有效期来自语料与 URL，不依赖模型。
    const proposal = proposeConstraints({
      title: signal.title, evidence: signal.evidence, source: signal.source,
      sourceUrl: signal.sourceUrl, origin: signal.origin,
      edges: (signal.edges || []).map(edge => ({ from: edge.from, to: edge.to, relation: edge.relation })),
    });
    const current = signal.constraints || {};
    const currentScope = current.scope || {};
    const baseScope = signal.origin === "private" ? currentScope : proposal.constraints.scope || {};
    const baseValidUntil = signal.origin === "private" ? textOf(current.validUntil) : proposal.constraints.validUntil || "";
    const baseSource = signal.origin === "private"
      ? "internal"
      : proposal.hint === "disclosure" ? "independent" : "related";

    const currentJson = JSON.stringify({
      scope: { ...baseScope, ...currentScope },
      epistemicState: current.epistemicState || "hypothesis",
      falsifier: current.falsifier || "",
      counterEvidence: current.counterEvidence || "",
      sourceType: current.sourceType || baseSource,
      validUntil: current.validUntil || baseValidUntil,
      probability: current.probability ?? 50,
      humanSource: current.humanSource || "",
    });

    const today = new Date().toISOString().slice(0, 10);
    const userPrompt = [
      `今天的日期：${today}`,
      `情报标题：${signal.title}`,
      `来源：${signal.source}`,
      signal.sourceUrl ? `来源链接：${signal.sourceUrl}` : "",
      signal.origin ? `来源性质：${signal.origin}` : "",
      `原始依据：${signal.evidence}`,
      `当前草稿：${currentJson}`,
      body.instruction?.trim() ? `用户的口语修改要求：${body.instruction.trim()}` : "用户没有修改要求，请把能起草的字段都起草出来。",
      `模式：${body.mode === "patch" ? "按用户要求修改，其他保持" : "完整起草"}`,
    ].filter(Boolean).join("\n");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    let raw: string;
    try {
      const upstream = await fetch(config.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "system", content: ENRICH_SYSTEM }, { role: "user", content: userPrompt }],
          response_format: { type: "json_object" },
          temperature: 0.1,
        }),
      });
      raw = await upstream.text();
    } finally {
      clearTimeout(timer);
    }
    if (!raw.trim()) throw new Error("模型返回空响应");

    let payload: unknown;
    try { payload = JSON.parse(raw); }
    catch { return Response.json({ error: "模型服务返回的不是 JSON", detail: raw.slice(0, 400) }, { status: 502 }); }
    const text = payloadText(payload);
    if (!text.trim()) return Response.json({ error: "模型返回了空正文", detail: raw.slice(0, 400) }, { status: 502 });

    let parsed: { summary?: string; constraints?: Record<string, unknown> };
    try { parsed = jsonFrom(text); }
    catch { return Response.json({ error: "模型正文里没有可读取的 JSON", detail: text.slice(0, 400) }, { status: 502 }); }

    const modelConstraints = (parsed.constraints || {}) as Record<string, unknown>;
    const modelScope = (modelConstraints.scope || {}) as Record<string, unknown>;
    const nextScope: Record<string, string> = {};
    for (const key of SCOPE_KEYS) {
      const fromModel = textOf(modelScope[key]);
      nextScope[key] = body.mode === "patch"
        ? (fromModel || currentScope[key] || "")
        : (fromModel || (proposal.constraints.scope || {})[key] || "");
    }

    const sourceType = sanitizeSourceType(modelConstraints.sourceType, signal, textOf(current.sourceType, baseSource));
    // propose 模式的有效期走确定性半衰期（股权 365 天 / 竞争 90 天等），
    // 只有口语修改时允许大模型按用户指令改日期。
    let validUntil = body.mode === "patch"
      ? dateOf(modelConstraints.validUntil, textOf(current.validUntil, baseValidUntil))
      : baseValidUntil;
    // 有效期不能落在过去。模型偶尔会把「明年三月底」算成今年，这里退回原草稿日期。
    if (validUntil && validUntil < today) validUntil = textOf(current.validUntil, baseValidUntil);
    const probability = clampProbability(modelConstraints.probability, Number(current.probability) || 50);

    return Response.json({
      ok: true,
      mode: body.mode || "propose",
      summary: textOf(parsed.summary, "已按材料与口语要求起草"),
      model: config.model,
      generatedAt: new Date().toISOString(),
      constraints: {
        scope: nextScope,
        epistemicState: EPISTEMIC.includes(textOf(modelConstraints.epistemicState)) ? textOf(modelConstraints.epistemicState) : "hypothesis",
        falsifier: textOf(modelConstraints.falsifier, textOf(current.falsifier)),
        counterEvidence: textOf(modelConstraints.counterEvidence, textOf(current.counterEvidence)),
        sourceType,
        validUntil,
        probability,
        signedOff: false,
        humanSource: sourceType === "internal" ? textOf(modelConstraints.humanSource, textOf(current.humanSource)) : textOf(current.humanSource),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "自动起草失败";
    console.error("[enrich] 失败：", error);
    return Response.json({ error: message }, { status: 500 });
  }
}
