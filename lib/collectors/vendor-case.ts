import { contentFingerprint, stableId } from "../dossier/id";
import type { EvidencePointer, RelationshipCollection } from "../dossier/types";
import { sourceLines, sourceText } from "./source-text";

export interface CollectVendorCaseInput {
  companyId: string;
  companyName: string;
  vendorName: string;
  url: string;
  content: string;
  publishedAt: string;
}

export function collectVendorCase(input: CollectVendorCaseInput): RelationshipCollection {
  const text = sourceText(input.content);
  if (!text.includes(input.companyName) || !text.includes(input.vendorName)) {
    throw new Error("厂商案例页没有同时出现客户和厂商名称");
  }
  const lines = sourceLines(input.content);
  const excerpt = lines.filter(line => line.includes(input.companyName) || line.includes(input.vendorName)).slice(0, 5).join("；");
  const sourceId = stableId("src", input.url, contentFingerprint(text));
  const evidence: EvidencePointer = { sourceId, excerpt };
  return {
    source: {
      id: sourceId,
      url: input.url,
      type: "third_party",
      publishedAt: input.publishedAt,
      fingerprint: contentFingerprint(text),
      pageOrExcerpt: text.slice(0, 4_000),
    },
    company: { record: { id: input.companyId, name: input.companyName }, evidence: { name: evidence } },
    relationships: [{
      record: {
        id: stableId("relationship", input.companyId, "it_vendor", input.vendorName),
        companyId: input.companyId,
        counterparty: input.vendorName,
        kind: "it_vendor",
        amount: "",
        periodStart: "",
        periodEnd: "",
      },
      evidence: { company_id: evidence, counterparty: evidence, kind: evidence },
    }],
  };
}
