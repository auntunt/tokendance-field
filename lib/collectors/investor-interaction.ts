import { contentFingerprint, stableId } from "../dossier/id";
import type { CompanyPeopleEventsCollection, EvidencePointer } from "../dossier/types";
import { sourceLines, sourceText } from "./source-text";

export interface CollectInvestorInteractionInput {
  companyId: string;
  companyName: string;
  url: string;
  content: string;
  publishedAt: string;
}

export function collectInvestorInteraction(input: CollectInvestorInteractionInput): CompanyPeopleEventsCollection {
  const text = sourceText(input.content);
  const lines = sourceLines(input.content);
  const sourceId = stableId("src", input.url, contentFingerprint(text));
  const records = text.matchAll(/接待时间\s*[：:]?\s*(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日([\s\S]*?)(?=接待时间|$)/g);
  const events = [...records].map(match => {
    const occurredAt = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    const block = match[0];
    const channel = /互动易/.test(block) ? "深交所互动易云访谈" : "投资者交流";
    const index = block.match(/记录表（编号\s*([^）]+)）/)?.[1] ?? "";
    const summary = `${channel}${index ? `（${index}）` : ""}`;
    const evidence: EvidencePointer = { sourceId, excerpt: block.slice(0, 600) };
    return {
      record: {
        id: stableId("event", input.companyId, occurredAt, summary),
        companyId: input.companyId,
        occurredAt,
        kind: "statement" as const,
        summary,
      },
      evidence: { company_id: evidence, occurred_at: evidence, kind: evidence, summary: evidence },
    };
  });
  if (events.length === 0) throw new Error(`投资者互动页没有可解析记录：${input.url}`);
  const companyEvidence: EvidencePointer = {
    sourceId,
    excerpt: lines.find(line => line.includes(input.companyName)) ?? input.companyName,
  };
  return {
    sources: [{
      id: sourceId,
      url: input.url,
      type: "filing",
      publishedAt: input.publishedAt,
      fingerprint: contentFingerprint(text),
      pageOrExcerpt: text.slice(0, 4_000),
    }],
    company: {
      record: { id: input.companyId, name: input.companyName, industryId: "", controller: "", listing: "" },
      evidence: { name: companyEvidence },
    },
    people: [],
    positions: [],
    events,
  };
}
