// 定时补数的纯函数策略层。
//
// 目标不是“搜到多少就塞多少”，而是让自动任务只补入：
//   - 有可打开原文链接、且不是搜索结果页的材料；
//   - 有明确事件日期、关系类型合法、主体完整的新关系；
//   - 当前图谱里还没有的关系；
//   - 在批次上限和整张图容量内的少量高质量信号。
//
// 这一层不联网、不写库，便于在真正写入工作区之前完整预演和测试。

import { latestObservedDate } from "./signal-date";

export type SchedulerEdge = {
  from?: string;
  to?: string;
  relation?: string;
  direction?: string;
  quote?: string;
};

export type SchedulerCandidate = {
  title?: string;
  evidence?: string;
  source?: string;
  sourceUrl?: string;
  edges?: SchedulerEdge[];
  suggestedRelation?: string;
  _grade?: string;
  _duplicate?: boolean;
  _duplicateNote?: string;
};

export type SchedulerSignalLike = {
  title?: string;
  sourceUrl?: string;
  edges?: SchedulerEdge[];
};

export type SchedulerPolicyOptions = {
  now?: Date;
  maxAddedSignals?: number;
  maxAddedEdges?: number;
  maxGraphEdges?: number;
};

export type SchedulerSelection = {
  accepted: SchedulerCandidate[];
  rejected: Record<string, number>;
  availableGraphEdges: number;
};

export const DEFAULT_SCHEDULER_POLICY = {
  maxAddedSignals: 4,
  maxAddedEdges: 6,
  maxGraphEdges: 48,
} as const;

const RELATIONS = new Set(["equity", "supply", "compete", "personnel", "license"]);
const SOURCE_RANK: Record<string, number> = { statutory: 4, independent: 3, self: 2, related: 2, unverified: 0 };
const MAX_AGE_DAYS: Record<string, number> = {
  equity: 730,
  license: 730,
  supply: 548,
  personnel: 548,
  compete: 365,
};
const SEARCH_HOSTS = ["baidu.com", "bing.com", "google.com", "google.com.hk", "so.com", "sogou.com"];

function bump(record: Record<string, number>, key: string) {
  record[key] = (record[key] || 0) + 1;
}

function normalizeEntity(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function schedulerEdgeKey(edge: SchedulerEdge): string {
  const relation = String(edge.relation || "").trim();
  let from = normalizeEntity(String(edge.from || ""));
  let to = normalizeEntity(String(edge.to || ""));
  if (relation === "compete" || edge.direction === "mutual") [from, to] = [from, to].sort();
  return `${relation}|${from}|${to}`;
}

export function isWeakSchedulerSource(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return true;
    const host = parsed.hostname.toLowerCase();
    if (SEARCH_HOSTS.some(item => host === item || host.endsWith(`.${item}`))) return true;
    return /(^|\/)search(\/|$)/i.test(parsed.pathname) && Boolean(parsed.searchParams.get("q"));
  } catch {
    return true;
  }
}

function sourceRank(candidate: SchedulerCandidate) {
  return SOURCE_RANK[String(candidate._grade || "unverified")] || 0;
}

function candidateDate(candidate: SchedulerCandidate, now: Date) {
  return latestObservedDate(`${candidate.title || ""} ${candidate.evidence || ""} ${candidate.sourceUrl || ""}`, now);
}

function normalizedEdges(candidate: SchedulerCandidate): SchedulerEdge[] {
  return (candidate.edges || []).map(edge => ({
    ...edge,
    from: String(edge.from || "").trim().slice(0, 120),
    to: String(edge.to || "").trim().slice(0, 120),
    relation: String(edge.relation || candidate.suggestedRelation || "").trim(),
    direction: edge.direction === "mutual" ? "mutual" : "forward",
  })).filter(edge => edge.from && edge.to && RELATIONS.has(String(edge.relation)));
}

function isRecent(candidate: SchedulerCandidate, edges: SchedulerEdge[], now: Date) {
  const date = candidateDate(candidate, now);
  if (!date) return false;
  const strictestDays = Math.min(...edges.map(edge => MAX_AGE_DAYS[String(edge.relation)] || 365));
  return now.getTime() - date.getTime() <= strictestDays * 86400000;
}

function numberOption(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) >= 0 ? Math.floor(Number(value)) : fallback;
}

/** 写工作区前的质量、去重和容量预演。 */
export function selectSchedulerCandidates(
  candidates: SchedulerCandidate[],
  existingSignals: SchedulerSignalLike[],
  options: SchedulerPolicyOptions = {},
): SchedulerSelection {
  const now = options.now || new Date();
  const maxAddedSignals = numberOption(options.maxAddedSignals, DEFAULT_SCHEDULER_POLICY.maxAddedSignals);
  const maxAddedEdges = numberOption(options.maxAddedEdges, DEFAULT_SCHEDULER_POLICY.maxAddedEdges);
  const maxGraphEdges = numberOption(options.maxGraphEdges, DEFAULT_SCHEDULER_POLICY.maxGraphEdges);
  const existingEdgeKeys = new Set(existingSignals.flatMap(signal => signal.edges || []).map(schedulerEdgeKey).filter(key => !key.endsWith("||")));
  const existingUrls = new Set(existingSignals.map(signal => String(signal.sourceUrl || "").trim()).filter(Boolean));
  const existingEdgeCount = existingSignals.reduce((total, signal) => total + (signal.edges?.length || 0), 0);
  const availableGraphEdges = Math.max(0, maxGraphEdges - existingEdgeCount);
  const rejected: Record<string, number> = {};
  const accepted: SchedulerCandidate[] = [];
  let acceptedEdges = 0;

  const ranked = candidates.slice().sort((a, b) => {
    const grade = sourceRank(b) - sourceRank(a);
    if (grade) return grade;
    const date = (candidateDate(b, now)?.getTime() || 0) - (candidateDate(a, now)?.getTime() || 0);
    if (date) return date;
    return String(a.title || "").localeCompare(String(b.title || ""), "zh-CN");
  });

  for (const candidate of ranked) {
    const url = String(candidate.sourceUrl || "").trim();
    const title = String(candidate.title || "").trim();
    const evidence = String(candidate.evidence || "").trim();
    if (candidate._duplicate) { bump(rejected, "extractorDuplicate"); continue; }
    if (!url || isWeakSchedulerSource(url)) { bump(rejected, "weakSource"); continue; }
    if (sourceRank(candidate) < 2) { bump(rejected, "unverifiedSource"); continue; }
    if (title.length < 6 || evidence.length < 48) { bump(rejected, "thinEvidence"); continue; }
    if (existingUrls.has(url)) { bump(rejected, "duplicateSource"); continue; }

    const edges = normalizedEdges(candidate);
    if (!edges.length || edges.length > 3) { bump(rejected, "invalidEdges"); continue; }
    if (!isRecent(candidate, edges, now)) { bump(rejected, "staleOrUndated"); continue; }

    const novelEdges = edges.filter(edge => !existingEdgeKeys.has(schedulerEdgeKey(edge)));
    if (!novelEdges.length) { bump(rejected, "duplicateRelation"); continue; }
    if (accepted.length >= maxAddedSignals
      || acceptedEdges + novelEdges.length > maxAddedEdges
      || acceptedEdges + novelEdges.length > availableGraphEdges) {
      bump(rejected, "capacity");
      continue;
    }

    const acceptedCandidate = { ...candidate, edges: novelEdges };
    accepted.push(acceptedCandidate);
    acceptedEdges += novelEdges.length;
    existingUrls.add(url);
    for (const edge of novelEdges) existingEdgeKeys.add(schedulerEdgeKey(edge));
  }

  return { accepted, rejected, availableGraphEdges };
}
