import type { ClaimValidationStatus } from "./types";

export type ResearchBriefCandidate = {
  title: string;
  evidence: string;
  source: string;
  sourceUrl?: string;
  dimension?: string;
  validation?: ClaimValidationStatus;
  duplicate?: boolean;
};

export type ResearchBrief = {
  verdict: "corroborated" | "provisional" | "insufficient";
  headline: string;
  usable: ResearchBriefCandidate[];
  needsValidation: ResearchBriefCandidate[];
  repeatedCopies: number;
  evidenceGaps: string[];
  nextActions: string[];
};

const DIMENSION_ACTION: Record<string, string> = {
  shareholders: "核对最终受益人、持股比例和变更公告，再判断控制权影响。",
  team: "确认该人物是否仍在任、实际职责和是否拥有预算或签字权。",
  funding: "核对融资/项目的时间、金额、投资方与资金实际用途。",
  business: "把业务动作映射到具体流程、系统和业务负责人，避免只停留在新闻描述。",
  fde: "确认交付现场的流程负责人、现有系统、数据边界和试点入口。",
  background: "寻找法定披露或独立原文，核对背景描述是否仍然有效。",
};

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * 把候选事实转成给研究员看的行动摘要。
 * 这里不让模型生成结论：是否可暂用只由来源独立性和正文指纹决定。
 */
export function buildResearchBrief(input: {
  candidates: ResearchBriefCandidate[];
  failedPages?: Array<{ url: string; reason: string }>;
  degradedQueries?: string[];
}): ResearchBrief {
  const candidates = input.candidates.filter(candidate => !candidate.duplicate);
  const usable = candidates.filter(candidate => candidate.validation === "corroborated").slice(0, 3);
  const needsValidation = candidates.filter(candidate => candidate.validation !== "corroborated").slice(0, 4);
  const repeatedCopies = input.candidates.filter(candidate => candidate.duplicate || candidate.validation === "repeated-copy").length;
  const evidenceGaps: string[] = [];

  if (input.degradedQueries?.length) evidenceGaps.push(`${input.degradedQueries.length} 组搜索结果与主体无关，尚未形成有效语料。`);
  if (input.failedPages?.length) evidenceGaps.push(`${input.failedPages.length} 个原始页面未完成抽取，不能据此下结论。`);
  if (!candidates.length) evidenceGaps.push("没有抽到可核验事实；需要补充更具体的主体、时间或原始链接。");
  if (candidates.length && !usable.length) evidenceGaps.push("当前没有跨独立来源印证的主张，所有结论都只能作为待核线索。");
  if (repeatedCopies) evidenceGaps.push(`${repeatedCopies} 条材料属于重复转载，不增加证据强度。`);

  const nextActions = unique([
    ...needsValidation.map(candidate => DIMENSION_ACTION[candidate.dimension || ""] || "为该主张寻找第二个独立原始来源，并核对日期、主体与原文片段。"),
    ...usable.map(candidate => DIMENSION_ACTION[candidate.dimension || ""] || "把已印证事实转成相关方、流程或系统的具体进场问题。"),
    ...(!usable.length && candidates.length ? ["在确认面板中缩小主体或时间范围，再进行一轮定向搜索。"] : []),
  ]).slice(0, 4);

  const verdict = usable.length ? "corroborated" : candidates.length ? "provisional" : "insufficient";
  const headline = verdict === "corroborated"
    ? `已找到 ${usable.length} 条可暂用的多源事实；其余线索仍需逐条核实。`
    : verdict === "provisional"
      ? `找到了 ${candidates.length} 条线索，但尚无多源印证，不能直接当作结论。`
      : "本轮没有形成可核验结论；应先补足可打开的原始来源。";

  return { verdict, headline, usable, needsValidation, repeatedCopies, evidenceGaps: unique(evidenceGaps), nextActions };
}
