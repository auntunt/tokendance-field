import { contentFingerprint, stableId } from "../dossier/id";
import type { EvidencePointer, PeerBenchmark, RelationshipCollection } from "../dossier/types";
import { sourceLines, sourceText } from "./source-text";

export interface CollectPeerCaseInput {
  companyId: string;
  companyName: string;
  peerName: string;
  url: string;
  content: string;
  publishedAt: string;
}

function detectedProducts(text: string): string[] {
  return ["Autodesk Assistant", "Construction IQ", "Procore Assist", "Assist"]
    .filter(product => text.toLowerCase().includes(product.toLowerCase()))
    .filter((product, index, values) => product !== "Assist" || !values.includes("Procore Assist"));
}

export function collectPeerCase(input: CollectPeerCaseInput): {
  benchmark: PeerBenchmark;
  relationship: RelationshipCollection;
} {
  const text = sourceText(input.content);
  if (!text.toLowerCase().includes(input.peerName.toLowerCase())) throw new Error(`同业案例缺少 ${input.peerName}`);
  const products = detectedProducts(text);
  if (products.length === 0) throw new Error("同业案例没有抽取到 AI 产品");
  const lines = sourceLines(input.content);
  const relevant = lines.filter(line => products.some(product => line.toLowerCase().includes(product.toLowerCase()))).slice(0, 5);
  const excerpt = relevant.join("；");
  const sourceId = stableId("src", input.url, contentFingerprint(text));
  const source = {
    id: sourceId,
    url: input.url,
    type: "third_party" as const,
    publishedAt: input.publishedAt,
    fingerprint: contentFingerprint(text),
    pageOrExcerpt: text.slice(0, 4_000),
  };
  const evidence: EvidencePointer = { sourceId, excerpt };
  const approach = /validate|验证/i.test(excerpt) && /summar/i.test(excerpt)
    ? "在项目数据上检索、验证和摘要"
    : /tool|工具|report|报告/i.test(excerpt)
      ? "在项目内问答、调用工具并生成报告"
      : "用 AI 辅助项目工作流";
  return {
    benchmark: { peer: input.peerName, products: products.join("、"), approach, source, excerpt },
    relationship: {
      source,
      company: { record: { id: input.companyId, name: input.companyName }, evidence: { name: evidence } },
      relationships: [{
        record: {
          id: stableId("relationship", input.companyId, "competitor", input.peerName),
          companyId: input.companyId,
          counterparty: input.peerName,
          kind: "competitor",
          amount: "",
          periodStart: "",
          periodEnd: "",
        },
        evidence: { company_id: evidence, counterparty: evidence, kind: evidence },
      }],
    },
  };
}

export function renderPeerBenchmarkTable(benchmarks: PeerBenchmark[]): string {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  return `<table><thead><tr><th>对标方</th><th>产品</th><th>已公开做法</th><th>来源</th></tr></thead><tbody>${benchmarks.map(row => `<tr><td>${escape(row.peer)}</td><td>${escape(row.products)}</td><td>${escape(row.approach)}</td><td><a href="${escape(row.source.url)}">来源</a></td></tr>`).join("")}</tbody></table>`;
}
