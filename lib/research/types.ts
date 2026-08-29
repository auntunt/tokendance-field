export type ResearchProviderId = "xai" | "openai" | "anthropic" | "bing";

export type WebSearchHit = {
  url: string;
  title: string;
  snippet: string;
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
