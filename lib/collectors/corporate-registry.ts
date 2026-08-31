import { contentFingerprint, stableId } from "../dossier/id";
import type { CompanyPeopleEventsCollection, EvidencePointer, SourceType } from "../dossier/types";
import { sourceLines } from "./source-text";

export interface CollectCorporateRegistryInput {
  companyId: string;
  companyName: string;
  industryId?: string;
  url: string;
  content: string;
  publishedAt: string;
  sourceType?: SourceType;
}

function csvRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
}

export function collectCorporateRegistry(input: CollectCorporateRegistryInput): CompanyPeopleEventsCollection {
  const lines = sourceLines(input.content);
  if (lines.length < 2) throw new Error(`工商 CSV 没有数据行：${input.url}`);
  const headers = csvRow(lines[0]);
  const rows = lines.slice(1).map(csvRow);
  const nameIndex = headers.indexOf("企业名称");
  const row = rows.find(cells => cells[nameIndex] === input.companyName);
  if (!row) throw new Error(`工商 CSV 找不到企业：${input.companyName}`);
  const value = (header: string) => {
    const index = headers.indexOf(header);
    return index >= 0 ? row[index] ?? "" : "";
  };
  const sourceId = stableId("src", input.url, contentFingerprint(input.content));
  const pointer: EvidencePointer = { sourceId, excerpt: lines[rows.indexOf(row) + 1] };
  const legalRepresentative = value("法定代表人");
  const listing = [value("上市地"), value("股票代码")].filter(Boolean).join(" ");
  const personId = legalRepresentative ? stableId("person", input.companyId, legalRepresentative) : "";
  return {
    sources: [{
      id: sourceId,
      url: input.url,
      type: input.sourceType ?? "filing",
      publishedAt: input.publishedAt,
      fingerprint: contentFingerprint(input.content),
      pageOrExcerpt: input.content.slice(0, 4_000),
    }],
    company: {
      record: {
        id: input.companyId,
        name: value("企业名称"),
        industryId: input.industryId ?? "",
        controller: value("实际控制人"),
        listing,
      },
      evidence: {
        name: pointer,
        ...(input.industryId ? { industry_id: pointer } : {}),
        ...(value("实际控制人") ? { controller: pointer } : {}),
        ...(listing ? { listing: pointer } : {}),
      },
    },
    people: legalRepresentative ? [{
      record: { id: personId, name: legalRepresentative, bio: "法定代表人", stance: "decider" },
      evidence: { name: pointer, bio: pointer, stance: pointer },
    }] : [],
    positions: legalRepresentative ? [{
      record: {
        id: stableId("position", input.companyId, personId, "法定代表人"),
        companyId: input.companyId,
        personId,
        title: "法定代表人",
        owns: "",
        start: "",
        end: "",
      },
      evidence: { company_id: pointer, person_id: pointer, title: pointer },
    }] : [],
    events: [],
  };
}
