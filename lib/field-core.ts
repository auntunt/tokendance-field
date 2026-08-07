// 判断纪律内核。整个文件的逻辑与 TokenDance Field 原版逐行等价：
// 六道约束门、权重更新式、Brier 打分、执行质量归因门槛，一律不动。
// 换本体只允许改 lib/ontology.ts。
import { DIMENSIONS, LocalScope, emptyScope } from "./ontology";

export type Verdict = "confirmed" | "watching" | "counter";
export type EpistemicState = "observation" | "interpretation" | "hypothesis" | "action";
// internal = 我方人际渠道（私下打听、客户口头透露、会议听到）。
// 它在门 5 的判定里和 related 同级，不因"我亲耳听到"获得任何豁免：
// 单一人际来源没有第三方可核查渠道，天然是弱来源。它的价值是提示方向，不是结论。
export type SourceType = "unknown" | "independent" | "related" | "internal";
export type DimensionScore = { dimension: string; score: number; matches: string[]; reason: string };
export type Constraints = {
  scope: LocalScope;
  epistemicState: EpistemicState;
  falsifier: string;
  counterEvidence: string;
  sourceType: SourceType;
  validUntil: string;
  probability: number;
  signedOff: boolean;
  /** 人际来源出处：谁说的、什么场合。sourceType 为 internal 时必填，否则门 5 不过。
   *  只记职务与场合，不记私生活——见 ontology.ts 的 PII 边界。 */
  humanSource?: string;
};
export type Edge = { from: string; to: string; relation: string; direction: "forward" | "mutual"; kind?: EdgeKind };
/** 边两端的实体类型。org=法人主体，person=自然人。默认 org，保持既有数据语义不变。 */
export type EdgeKind = "org-org" | "person-org" | "person-person";
export type ModelAnalysis = {
  summary: string;
  dimensions: Array<{ dimension: string; score: number; reason: string; evidence?: string[] }>;
  candidate_topics: Array<{ label: string; rationale: string; evidence?: string[] }>;
  questions: string[];
  local_context?: Partial<LocalScope>;
  epistemic_state?: EpistemicState;
  falsifiers?: string[];
  counterevidence?: string[];
  confidence?: number;
  provider: string;
  model: string;
  generatedAt: string;
};
export type Signal = {
  id: string;
  title: string;
  evidence: string;
  source: string;
  sourceUrl?: string;
  createdAt: string;
  dimensions: DimensionScore[];
  topics: string[];
  candidateScore: number;
  outcome: Verdict;
  starred?: boolean;
  aiAnalysis?: ModelAnalysis | null;
  constraints: Constraints;
  /** 供给管线写入：这条情报声称的企业关系边。人工录入时可为空。 */
  edges?: Edge[];
  /** 供给来源：manual / mirofish / import。用于溯源，不参与过闸判定。 */
  origin?: string;
};
export type Feedback = {
  id: string;
  signalId: string;
  topicId: string;
  verdict: Verdict;
  note: string;
  createdAt: string;
  weightChange: string;
  executionQuality: number;
  predictedProbability: number;
  brierScore: number;
};
export type Snapshot = { id: string; title: string; createdAt: string; signalCount: number; feedbackCount: number; note: string };

export const initialWeights = [25, 25, 25, 25];

export function emptyConstraints(): Constraints {
  return { scope: emptyScope(), epistemicState: "observation", falsifier: "", counterEvidence: "", sourceType: "unknown", validUntil: "", probability: 50, signedOff: false, humanSource: "" };
}

/** 权重夹在 12–40% 后归一化。防止任一维度被单次反馈打成噪声或独裁。 */
export function normalizeWeights(values: number[]) {
  const limited = values.map(value => Math.max(12, Math.min(40, value)));
  const total = limited.reduce((sum, value) => sum + value, 0);
  return limited.map(value => Math.round(value / total * 100));
}

export function isExpired(signal: Signal) {
  const raw = signal.constraints.validUntil;
  if (!raw) return false;
  // 有效期是 date-only（YYYY-MM-DD）。直接 new Date() 会按 UTC 零点解析，
  // 在 UTC+8 下"今天到期"从早上八点起就算过期了。所以按本地时区的当日日终比。
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  const deadline = parts
    ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 23, 59, 59, 999).getTime()
    : new Date(raw).getTime();
  return Number.isFinite(deadline) && deadline < Date.now();
}

/** 六道约束门。缺一道就不进入执行——原版逻辑，未改。 */
export function gateState(signal: Signal) {
  const scope = Object.values(signal.constraints.scope).every(value => String(value ?? "").trim().length > 0);
  const states = [
    signal.evidence.trim().length >= 20 && Boolean(signal.source.trim()),
    scope,
    Boolean(signal.constraints.epistemicState),
    Boolean(signal.constraints.falsifier.trim() && signal.constraints.counterEvidence.trim()),
    // internal 额外要求写清人际出处。这是收紧而非放宽：
    // 说不出"谁在什么场合说的"的私下消息，连来源谱系都不成立。
    signal.constraints.sourceType !== "unknown"
      && Boolean(signal.constraints.validUntil) && !isExpired(signal)
      && (signal.constraints.sourceType !== "internal" || Boolean(signal.constraints.humanSource?.trim())),
    signal.constraints.signedOff,
  ];
  return { states, passed: states.filter(Boolean).length, executable: states.every(Boolean) };
}

export const GATE_LABELS = ["原始证据", "本地边界", "认识状态", "证伪 / 反例", "来源 / 时效", "专家签署"] as const;

type SignalSeed = Pick<Signal, "title" | "evidence" | "source" | "sourceUrl"> & {
  id?: string;
  constraints?: Partial<Constraints>;
  edges?: Edge[];
  origin?: string;
};

/** 候选度打分。关键词命中只是"值得先看"的信号，不是"可以行动"的许可。 */
export function makeSignal(
  input: SignalSeed,
  weights: number[],
  topicRules: Array<{ id: string; words: string[] }>,
  createdAt = "刚刚",
): Signal {
  const text = `${input.title} ${input.evidence}`.toLowerCase();
  const dimensions = DIMENSIONS.map(rule => {
    const matches = rule.words.filter(word => text.includes(word.toLowerCase()));
    const evidenceDepth = Math.min(20, Math.floor(input.evidence.trim().length / 14));
    return { dimension: rule.dimension, score: Math.min(96, 35 + evidenceDepth + matches.length * 12), matches, reason: rule.reason };
  });
  const topics = topicRules.filter(topic => topic.words.some(word => text.includes(word))).map(topic => topic.id);
  const candidateScore = Math.round(dimensions.reduce((sum, item, index) => sum + item.score * weights[index], 0) / 100);
  const base = emptyConstraints();
  return {
    id: input.id || `signal-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: input.title.trim(),
    evidence: input.evidence.trim(),
    source: input.source.trim() || "人工录入",
    sourceUrl: input.sourceUrl?.trim(),
    createdAt,
    dimensions,
    topics: topics.length ? topics : ["unclustered"],
    candidateScore,
    outcome: "watching",
    edges: input.edges || [],
    origin: input.origin || "manual",
    constraints: { ...base, ...input.constraints, scope: { ...base.scope, ...(input.constraints?.scope || {}) } },
  };
}

export function normalizeSignal(signal: Signal, weights: number[], topicRules: Array<{ id: string; words: string[] }>) {
  const base = signal.dimensions?.length === 4 ? signal : makeSignal(signal, weights, topicRules, signal.createdAt || "历史记录");
  const defaults = emptyConstraints();
  return {
    ...base,
    edges: signal.edges || [],
    origin: signal.origin || "manual",
    constraints: { ...defaults, ...(signal.constraints || {}), scope: { ...defaults.scope, ...(signal.constraints?.scope || {}) } },
  };
}

/**
 * 一次真实结果的归因计算。
 * - 执行质量 < 60：判断错还是执行差分不开，结果只记录，不改写权重。
 * - 权重更新：w += 方向 × (本维得分 − 四维均值) × 0.08，再夹紧归一化。
 * - Brier：(预测概率 − 实际)² × 100。观察态用预测值自比，误差恒为 0。
 */
export function attribute(signal: Signal, weights: number[], verdict: Verdict, executionQuality: number) {
  const attributable = executionQuality >= 60;
  const direction = attributable ? (verdict === "confirmed" ? 1 : verdict === "counter" ? -1 : 0) : 0;
  const values = signal.dimensions.map(item => item.score);
  const average = values.reduce((sum, item) => sum + item, 0) / values.length;
  const nextWeights = direction ? normalizeWeights(weights.map((weight, index) => weight + direction * (values[index] - average) * .08)) : weights;
  const weightChange = direction
    ? nextWeights.map((weight, index) => `${weight - weights[index] >= 0 ? "+" : ""}${weight - weights[index]}`).join(" / ")
    : attributable ? "不调整" : "执行质量不足，不归因";
  const actual = verdict === "confirmed" ? 1 : verdict === "counter" ? 0 : signal.constraints.probability / 100;
  const brierScore = Math.round(Math.pow(signal.constraints.probability / 100 - actual, 2) * 100);
  return { attributable, direction, nextWeights, weightChange, brierScore };
}

export function verdictText(value: Verdict) { return value === "confirmed" ? "验证成立" : value === "counter" ? "记录反例" : "待验证"; }
export function verdictTone(value: Verdict) { return value === "confirmed" ? "good" : value === "counter" ? "bad" : "watching"; }
export function epistemicText(value: EpistemicState) {
  return ({ observation: "观察", interpretation: "解释", hypothesis: "假设", action: "行动主张" } as const)[value];
}
