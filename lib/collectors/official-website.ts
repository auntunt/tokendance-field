import { contentFingerprint, stableId } from "../dossier/id";
import type { CompanyPeopleEventsCollection, EvidencePointer } from "../dossier/types";
import { sourceLines, sourceText } from "./source-text";

export interface CollectOfficialWebsiteInput {
  companyId: string;
  companyName: string;
  industryId?: string;
  listing?: string;
  url: string;
  content: string;
  publishedAt?: string;
}

function officialDate(text: string): string {
  const iso = text.match(/(20\d{2})[年\-/.](\d{1,2})[月\-/.](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const monthDayYear = text.match(/(\d{1,2})\/(\d{1,2})\s+(20\d{2})/);
  return monthDayYear ? `${monthDayYear[3]}-${monthDayYear[1].padStart(2, "0")}-${monthDayYear[2].padStart(2, "0")}` : "";
}

export function collectOfficialWebsite(input: CollectOfficialWebsiteInput): CompanyPeopleEventsCollection {
  const text = sourceText(input.content);
  const lines = sourceLines(input.content);
  const publishedAt = input.publishedAt ?? officialDate(text);
  if (!publishedAt) throw new Error(`官网页面缺少发布日期：${input.url}`);
  const sourceId = stableId("src", input.url, contentFingerprint(text));
  const title = lines.find(line => line.length >= 8 && !/^(?:\d{2}\/\d{2}|20\d{2}|发布时间)/.test(line)) ?? "官网动态";
  const eventExcerpt = lines.filter(line => /(?:发布|亮相|AI|数字化|战略)/i.test(line)).slice(0, 4).join("；");
  const eventSummary = `${title}：${eventExcerpt}`
    .replace(/[。！？!?]+/g, "；")
    .replace(/；+/g, "；")
    .replace(/；$/, "")
    .slice(0, 500);
  const eventPointer: EvidencePointer = { sourceId, excerpt: eventExcerpt || title };
  const people = new Map<string, { name: string; title: string; excerpt: string }>();
  for (const line of lines) {
    for (const match of line.matchAll(/(?:公司|广联达)(董事长|总裁|高级副总裁|副总裁|财务总监|董事会秘书)([\u4e00-\u9fff]{2,4}?)(?=进行了|出席|作了|表示|指出|强调|，|。|；|$)/g)) {
      people.set(match[2], { name: match[2], title: match[1], excerpt: line });
    }
  }
  return {
    sources: [{
      id: sourceId,
      url: input.url,
      type: "official",
      publishedAt,
      fingerprint: contentFingerprint(text),
      pageOrExcerpt: text.slice(0, 4_000),
    }],
    company: {
      record: { id: input.companyId, name: input.companyName, industryId: input.industryId ?? "", controller: "", listing: input.listing ?? "" },
      evidence: {
        name: eventPointer,
        ...(input.industryId ? { industry_id: eventPointer } : {}),
        ...(input.listing ? { listing: eventPointer } : {}),
      },
    },
    people: [...people.values()].map(person => {
      const evidence: EvidencePointer = { sourceId, excerpt: person.excerpt };
      return {
        record: { id: stableId("person", input.companyId, person.name), name: person.name, bio: person.title, stance: "influencer" as const },
        evidence: { name: evidence, bio: evidence, stance: evidence },
      };
    }),
    positions: [...people.values()].map(person => {
      const evidence: EvidencePointer = { sourceId, excerpt: person.excerpt };
      const personId = stableId("person", input.companyId, person.name);
      return {
        record: {
          id: stableId("position", input.companyId, personId, person.title),
          companyId: input.companyId,
          personId,
          title: person.title,
          owns: "",
          start: "",
          end: "",
        },
        evidence: { company_id: evidence, person_id: evidence, title: evidence },
      };
    }),
    events: [{
      record: {
        id: stableId("event", input.companyId, publishedAt, title),
        companyId: input.companyId,
        occurredAt: publishedAt,
        kind: /战略/.test(text) ? "strategy" : "statement",
        summary: eventSummary,
      },
      evidence: {
        company_id: eventPointer,
        occurred_at: eventPointer,
        kind: eventPointer,
        summary: eventPointer,
      },
    }],
  };
}
