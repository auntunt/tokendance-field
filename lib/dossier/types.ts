export type SourceType = "filing" | "official" | "third_party";

export interface SourceInput {
  id: string;
  url: string;
  type: SourceType;
  publishedAt: string;
  fingerprint: string;
  pageOrExcerpt: string;
}

export interface EvidencePointer {
  sourceId: string;
  excerpt: string;
}

export type FieldEvidence = Record<string, string | EvidencePointer>;

export interface SourcedRecord<T> {
  record: T;
  evidence: FieldEvidence;
}

export interface CompanyRecord {
  id: string;
  name: string;
}

export interface IndustryRecord {
  id: string;
  name: string;
  upstream: string;
  downstream: string;
  kpis: string;
  regulators: string;
}

export interface IndustryTermRecord {
  id: string;
  industryId: string;
  term: string;
  plainMeaning: string;
  aliases: string;
}

export interface BusinessLineRecord {
  id: string;
  companyId: string;
  name: string;
  revenueShare: string;
}

export interface FinancialSnapshotRecord {
  id: string;
  companyId: string;
  year: string;
  revenue: string;
  netProfit: string;
  rndExpense: string;
  itCapex: string;
  fundraisingProjects: string;
}

export interface PersonRecord {
  id: string;
  name: string;
  bio: string;
  stance: "decider" | "influencer" | "user" | "blocker" | "unknown";
}

export interface PositionRecord {
  id: string;
  companyId: string;
  personId: string;
  title: string;
  owns: string;
  start: string;
  end: string;
}

export interface OrgUnitRecord {
  id: string;
  companyId: string;
  name: string;
  parentId: string;
  headPersonId: string;
}

export interface JobPostingRecord {
  id: string;
  companyId: string;
  orgUnit: string;
  title: string;
  techKeywords: string;
  systemKeywords: string;
  postedAt: string;
}

export interface SystemInUseRecord {
  id: string;
  companyId: string;
  category: string;
  product: string;
  vendor: string;
  coversProcessStep: string;
  since: string;
}

export interface JobPostingCollection {
  source: SourceInput;
  company: SourcedRecord<CompanyRecord>;
  jobPostings: Array<SourcedRecord<JobPostingRecord>>;
  orgUnits: Array<SourcedRecord<OrgUnitRecord>>;
}

export interface ProcurementCollection {
  source: SourceInput;
  company: SourcedRecord<CompanyRecord>;
  systems: Array<SourcedRecord<SystemInUseRecord>>;
  orgUnits: Array<SourcedRecord<OrgUnitRecord>>;
}

export interface AnnualReportCollection {
  sources: SourceInput[];
  company: SourcedRecord<CompanyRecord & { industryId: string }>;
  industry: SourcedRecord<IndustryRecord>;
  industryTerms: Array<SourcedRecord<IndustryTermRecord>>;
  businessLines: Array<SourcedRecord<BusinessLineRecord>>;
  financialSnapshots: Array<SourcedRecord<FinancialSnapshotRecord>>;
  people: Array<SourcedRecord<PersonRecord>>;
  positions: Array<SourcedRecord<PositionRecord>>;
}
