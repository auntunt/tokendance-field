export type ResearchProviderId = "xai" | "openai" | "anthropic" | "bing";

export type WebSearchHit = {
  url: string;
  title: string;
  snippet: string;
  provider: ResearchProviderId;
};

/** 大模型联网研究的可阅读初稿。每条发现都必须锚定到一个网页来源；
 * 它可以先被阅读，但在原文复核前绝不等同于已印证事实。 */
export type ResearchFinding = {
  title: string;
  evidence: string;
  sourceUrl: string;
  sourceTitle: string;
  dimension: string;
  /** 只有语料明确说出主体关系时才有边，不能为了画图硬凑。 */
  edges: Array<{ from: string; to: string; relation: string; direction: "forward" | "mutual"; quote: string }>;
};

export type ResearchMemo = {
  summary: string;
  findings: ResearchFinding[];
  openQuestions: string[];
  sourceUrls: string[];
  provider: ResearchProviderId;
};

export type ResearchProviderStatus = {
  id: ResearchProviderId;
  label: string;
  configured: boolean;
  active: boolean;
  model?: string;
  mode: "hosted-search" | "html-fallback";
};

export type ClaimValidationStatus = "single-source" | "corroborated" | "repeated-copy";

export type ClaimValidation = {
  claimId: string;
  status: ClaimValidationStatus;
  sourceCount: number;
  independentSourceCount: number;
  distinctContentCount: number;
};
