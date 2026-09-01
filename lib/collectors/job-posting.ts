import { contentFingerprint, stableId } from "../dossier/id";
import type { JobPostingCollection, SourceType } from "../dossier/types";
import { isoDateFromText, sourceLines, sourceText, unique } from "./source-text";

const TECH_KEYWORDS = [
  "IDC", "数据中心", "运维", "弱电", "电气", "暖通", "工程施工", "服务器", "存储",
  "自动化", "通信", "网络", "测试", "人工智能", "机器学习", "数据工程",
];

const SYSTEM_KEYWORDS = [
  "DCIM", "BMS", "EMS", "ERP", "CRM", "SAP", "Oracle", "Azure", "Kubernetes",
  "Docker", "UPS", "HV", "服务器", "存储", "网络设备",
];

const JOB_TITLE_ENDING = /(?:工程师(?:\/主管)?|主管(?:（[^）]+）)?|实习生|管培生|产品经理|架构师|数据分析师|专员)$/i;

export interface CollectJobPostingInput {
  companyId: string;
  companyName: string;
  url: string;
  content: string;
  sourceType?: SourceType;
  publishedAt?: string;
}

function keywordMatches(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return unique(keywords.filter(keyword => lower.includes(keyword.toLowerCase())));
}

function looksLikeJobTitle(line: string): boolean {
  if (line.length < 3 || line.length > 48) return false;
  if (/[。；：]/.test(line) || /(?:职位描述|公司简介|招聘岗位|立即投递|全部职位)/.test(line)) return false;
  return JOB_TITLE_ENDING.test(line);
}

function inferOrgUnit(title: string): string {
  const explicit = title.match(/^(.{2,18}?部)/)?.[1];
  if (explicit) return explicit;
  if (/(?:IDC|数据中心|运维|弱电|电气|暖通)/i.test(title)) return "数据中心运维";
  if (/(?:AI|人工智能|算法|数据|研发)/i.test(title)) return "技术研发";
  return "";
}

export function collectJobPostings(input: CollectJobPostingInput): JobPostingCollection {
  const text = sourceText(input.content);
  const lines = sourceLines(input.content);
  const postedAt = input.publishedAt || isoDateFromText(text);
  if (!postedAt) throw new Error(`招聘来源缺少发布日期：${input.url}`);

  const companyExcerpt = lines.find(line => line.includes(input.companyName)) ?? input.companyName;
  const sourceId = stableId("src", input.url, contentFingerprint(text));
  const jobPostings: JobPostingCollection["jobPostings"] = [];
  const orgUnits = new Map<string, JobPostingCollection["orgUnits"][number]>();

  for (let index = 0; index < lines.length; index += 1) {
    const title = lines[index];
    if (!looksLikeJobTitle(title)) continue;
    const window: string[] = [title];
    for (let offset = index + 1; offset < lines.length && window.length < 7; offset += 1) {
      if (looksLikeJobTitle(lines[offset])) break;
      window.push(lines[offset]);
    }
    const excerpt = window.join("\n");
    const techKeywords = keywordMatches(excerpt, TECH_KEYWORDS).join("、");
    const systemKeywords = keywordMatches(excerpt, SYSTEM_KEYWORDS).join("、");
    const orgUnit = inferOrgUnit(title);
    const id = stableId("job", input.companyId, title, postedAt);
    const evidence: Record<string, string> = {
      title,
      posted_at: lines.find(line => line.includes(postedAt.slice(0, 4))) ?? postedAt,
    };
    if (orgUnit) evidence.org_unit = title;
    if (techKeywords) evidence.tech_keywords = excerpt;
    if (systemKeywords) evidence.system_keywords = excerpt;
    jobPostings.push({
      record: { id, companyId: input.companyId, orgUnit, title, techKeywords, systemKeywords, postedAt },
      evidence,
    });
    if (orgUnit && !orgUnits.has(orgUnit)) {
      orgUnits.set(orgUnit, {
        record: {
          id: stableId("org", input.companyId, orgUnit),
          companyId: input.companyId,
          name: orgUnit,
          parentId: "",
          headPersonId: "",
        },
        evidence: { name: title },
      });
    }
  }

  if (jobPostings.length === 0) throw new Error(`招聘来源未抽取到职位：${input.url}`);
  return {
    source: {
      id: sourceId,
      url: input.url,
      type: input.sourceType ?? "official",
      publishedAt: postedAt,
      fingerprint: contentFingerprint(text),
      pageOrExcerpt: text.slice(0, 4_000),
    },
    company: {
      record: { id: input.companyId, name: input.companyName },
      evidence: { name: companyExcerpt },
    },
    jobPostings,
    orgUnits: [...orgUnits.values()],
  };
}
