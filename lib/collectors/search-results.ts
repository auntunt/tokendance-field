import type { SearchCandidate } from "../dossier/types";

export interface SearchCandidateCollection {
  query: string;
  candidates: SearchCandidate[];
}

export function collectSearchCandidates(content: string): SearchCandidateCollection {
  const parsed = JSON.parse(content) as {
    query?: unknown;
    results?: Array<{ title?: unknown; url?: unknown; snippet?: unknown; publishedAt?: unknown }>;
  };
  if (typeof parsed.query !== "string" || !Array.isArray(parsed.results)) {
    throw new Error("搜索响应缺少 query/results");
  }
  const candidates = parsed.results.flatMap(result => {
    if (typeof result.url !== "string" || !/^https?:\/\//.test(result.url)) return [];
    return [{
      title: typeof result.title === "string" ? result.title : "",
      url: result.url,
      snippet: typeof result.snippet === "string" ? result.snippet : "",
      publishedAt: typeof result.publishedAt === "string" ? result.publishedAt : "",
    }];
  });
  return { query: parsed.query, candidates };
}
