import { contentFingerprint, stableId } from "../dossier/id";
import type { ProcurementCollection, SourceType } from "../dossier/types";
import { isoDateFromText, sourceLines, sourceText, unique } from "./source-text";

export interface CollectProcurementInput {
  companyId: string;
  companyName?: string;
  url: string;
  content: string;
  sourceType?: SourceType;
  publishedAt?: string;
}

function labelValue(lines: string[], labels: string[]): string {
  for (const line of lines) {
    for (const label of labels) {
      const match = line.match(new RegExp(`${label}\\s*[：:]?\\s*(.+)$`));
      if (match?.[1]) return match[1].trim();
    }
  }
  return "";
}

function vendors(lines: string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    const match = line.match(/中标(?:成交)?供应商名称\s*[：:]\s*(.+)$/);
    if (match?.[1] && !/[、，]地址/.test(match[1])) found.push(match[1].trim());
  }
  return unique(found);
}

function systemCategory(text: string): string {
  if (/(?:数据平台|数据资源|数据治理|数据仓库|大数据)/.test(text)) return "数据平台";
  if (/ERP/i.test(text)) return "ERP";
  if (/CRM/i.test(text)) return "CRM";
  if (/(?:BI|商业智能)/i.test(text)) return "BI";
  if (/(?:OA|协同办公)/i.test(text)) return "OA";
  if (/MES/i.test(text)) return "MES";
  return "其他";
}

function requirementExcerpt(lines: string[]): string {
  const selected = lines.filter(line => /(?:采购需求|用途|简要技术|服务要求)/.test(line));
  return selected.slice(0, 5).join("；");
}

export function collectProcurement(input: CollectProcurementInput): ProcurementCollection {
  const text = sourceText(input.content);
  const lines = sourceLines(input.content);
  const publishedAt = input.publishedAt || isoDateFromText(text);
  const project = labelValue(lines, ["项目名称", "采购项目名称"]);
  const buyer = input.companyName || labelValue(lines, ["采购单位", "采购人名称", "采购人"]);
  if (!publishedAt) throw new Error(`招投标来源缺少发布日期：${input.url}`);
  if (!project) throw new Error(`招投标来源缺少项目名称：${input.url}`);
  if (!buyer) throw new Error(`招投标来源缺少采购单位：${input.url}`);

  const supplierNames = vendors(lines);
  const requirements = requirementExcerpt(lines);
  const sourceId = stableId("src", input.url, contentFingerprint(text));
  const category = systemCategory(`${project}\n${requirements}`);
  const systemId = stableId("sys", input.companyId, category, project);
  const systemEvidence: Record<string, string> = {
    category: `${project}\n${requirements}`.trim(),
    product: project,
  };
  if (supplierNames.length) systemEvidence.vendor = supplierNames.join("；");
  if (requirements) systemEvidence.covers_process_step = requirements;

  return {
    source: {
      id: sourceId,
      url: input.url,
      type: input.sourceType ?? "filing",
      publishedAt,
      fingerprint: contentFingerprint(text),
      pageOrExcerpt: text.slice(0, 4_000),
    },
    company: {
      record: { id: input.companyId, name: buyer },
      evidence: { name: lines.find(line => line.includes(buyer)) ?? buyer },
    },
    systems: [{
      record: {
        id: systemId,
        companyId: input.companyId,
        category,
        product: project,
        vendor: supplierNames.join("、"),
        coversProcessStep: requirements,
        since: "",
      },
      evidence: systemEvidence,
    }],
    orgUnits: [{
      record: {
        id: stableId("org", input.companyId, buyer),
        companyId: input.companyId,
        name: buyer,
        parentId: "",
        headPersonId: "",
      },
      evidence: { name: lines.find(line => line.includes(buyer)) ?? buyer },
    }],
  };
}
