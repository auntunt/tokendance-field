import type { ResearchProviderId } from "../research/types";

/**
 * A persistent investigation is the product's unit of work. The original
 * question is merely the entry point; claims, sources and follow-up work all
 * remain addressable through this id.
 */
export type InvestigationStatus = "researching" | "ready" | "partial" | "failed";
export type ResearchPassStatus = "queued" | "researching" | "ready" | "failed";
export type SourceCheckStatus = "cited" | "fetching" | "verified" | "failed";
export type ClaimAssessment = "lead" | "supported" | "contested";
/** 情报库的一级观察对象。行业（FDE）是集合，不与公司或人员混为一个节点。 */
export type InvestigationSubjectType = "industry" | "company" | "person";

export type InvestigationLens = {
  id: "identity" | "current" | "organization" | "ecosystem" | "counter";
  title: string;
  description: string;
  instruction: string;
};

export const INVESTIGATION_LENSES: InvestigationLens[] = [
  {
    id: "identity",
    title: "主体与时间线",
    description: "先确认是谁、过去发生过什么，避免把同名主体或旧消息混进来。",
    instruction: "确认主体身份、别名、法定/上市主体及最近两年的关键时间线；清楚标出无法确认之处。",
  },
  {
    id: "current",
    title: "当前动作",
    description: "把正在推进的产品、业务、AI 或项目动作拆成可核对的事实。",
    instruction: "聚焦当前业务动作、产品、项目、AI 应用和商业化证据；区分宣布、试点、已落地和结果。",
  },
  {
    id: "organization",
    title: "组织与关键人",
    description: "找公开可证实的组织、负责人、岗位变化和实际协作链条。",
    instruction: "研究公开可证实的组织结构、关键负责人、职务变化、业务线和团队协作；不要猜测私人信息。",
  },
  {
    id: "ecosystem",
    title: "生态与关系",
    description: "提取投资、合作、供应、竞争、授权等有来源支撑的关系。",
    instruction: "寻找与该主体直接相关的投资、客户、供应、合作、竞争或授权关系；只有原文明确说出关系时才输出边。",
  },
  {
    id: "counter",
    title: "反证与缺口",
    description: "主动找冲突信息、过期表述和还不能下结论的部分。",
    instruction: "主动寻找反证、冲突日期、夸大表述和无法核对的关键空缺；不要为了完整而补猜测。",
  },
];

const INDUSTRY_LENSES: InvestigationLens[] = [
  {
    id: "identity", title: "行业边界与时间线", description: "先定义观察的行业、交付模式和时间范围，避免把相邻赛道混进来。",
    instruction: "确认这个行业的名称、边界、别名、上下游和最近两年的关键变化；尤其区分 FDE、实施、驻场、咨询和外包。",
  },
  {
    id: "current", title: "需求、产品与落地", description: "看需求侧、产品形态、采购与真实落地，而不是只收集公司宣传。",
    instruction: "研究行业当前的需求变化、典型产品、AI/自动化落地、采购或部署证据；区分宣布、试点、已部署和已产生结果。",
  },
  {
    id: "organization", title: "供给侧与关键人", description: "找服务商、典型公司、岗位和决定行业走向的公开人物。",
    instruction: "梳理服务商类型、代表公司、关键岗位、人才流动和组织能力；不要猜测私人信息。",
  },
  {
    id: "ecosystem", title: "产业链与关系", description: "提取投资、客户、合作、供应和竞争等有来源的行业关系。",
    instruction: "寻找行业内直接可核对的投资、客户、供应、合作、竞争或平台关系；只有原文明确说出关系时才输出边。",
  },
  {
    id: "counter", title: "反证与空白", description: "主动找不成立的案例、概念混用和还未被证实的判断。",
    instruction: "主动寻找反例、口径冲突、样本偏差和待验证缺口；不要为了完整而补猜测。",
  },
];

const PERSON_LENSES: InvestigationLens[] = [
  {
    id: "identity", title: "身份与任职时间线", description: "确认同名、现任角色、公开履历和时间点。",
    instruction: "确认该人员的公开身份、现任/历任角色、组织归属和关键时间线；明确同名或过期信息。",
  },
  {
    id: "current", title: "当前职责与公开动作", description: "聚焦当前职责、公开发言、发布和项目动作。",
    instruction: "研究其可公开核对的当前职责、公开发言、产品/项目发布及业务动作；不要推断私人活动。",
  },
  {
    id: "organization", title: "组织位置与协作", description: "看人员如何嵌入团队、业务线和职责链条。",
    instruction: "找公开可证实的直属组织、业务线、职责范围和协作关系；只保留原文明确的组织或人员关系。",
  },
  {
    id: "ecosystem", title: "外部关联", description: "看投资、董事、顾问、伙伴和行业组织等公开关联。",
    instruction: "寻找公开可证实的董事、投资、顾问、合作或行业组织关联；没有明确出处不要输出关系。",
  },
  {
    id: "counter", title: "反证与空白", description: "标记冲突履历、已离任信息和未验证说法。",
    instruction: "主动寻找冲突履历、离任信息、来源过期和无法核对的说法；不要把传闻写成事实。",
  },
];

export function lensesForSubject(subjectType: InvestigationSubjectType) {
  if (subjectType === "industry") return INDUSTRY_LENSES;
  if (subjectType === "person") return PERSON_LENSES;
  return INVESTIGATION_LENSES;
}

export type InvestigationPass = {
  id: string;
  lens: InvestigationLens["id"];
  title: string;
  description: string;
  status: ResearchPassStatus;
  summary: string;
  openQuestions: string[];
  error?: string;
  startedAt?: string;
  completedAt?: string;
};

export type InvestigationSource = {
  id: string;
  url: string;
  domain: string;
  title: string;
  citedByPasses: string[];
  checkStatus: SourceCheckStatus;
  fetchedAt?: string;
  error?: string;
};

export type InvestigationClaim = {
  id: string;
  passId: string;
  title: string;
  evidence: string;
  dimension: string;
  assessment: ClaimAssessment;
  sourceIds: string[];
  sourceCheckSummary: { verified: number; cited: number; failed: number };
  relations: Array<{
    from: string;
    to: string;
    relation: string;
    direction: "forward" | "mutual";
    quote: string;
  }>;
};

export type InvestigationDossier = {
  id: string;
  question: string;
  entityName: string;
  subjectType: InvestigationSubjectType;
  status: InvestigationStatus;
  provider: ResearchProviderId;
  createdAt: string;
  updatedAt: string;
  passes: InvestigationPass[];
  claims: InvestigationClaim[];
  sources: InvestigationSource[];
  openQuestions: string[];
};
