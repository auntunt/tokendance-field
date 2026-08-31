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

export interface CompanyProfileRecord extends CompanyRecord {
  industryId: string;
  controller: string;
  listing: string;
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

export interface EventRecord {
  id: string;
  companyId: string;
  occurredAt: string;
  kind: "hire" | "leave" | "procurement" | "pilot" | "statement" | "strategy" | "lawsuit";
  summary: string;
}

export interface RelationshipRecord {
  id: string;
  companyId: string;
  counterparty: string;
  kind: "customer" | "supplier" | "it_vendor" | "competitor" | "investor";
  amount: string;
  periodStart: string;
  periodEnd: string;
}

export interface RelationshipCollection {
  source: SourceInput;
  company: SourcedRecord<CompanyRecord>;
  relationships: Array<SourcedRecord<RelationshipRecord>>;
}

export interface PeerBenchmark {
  peer: string;
  products: string;
  approach: string;
  source: SourceInput;
  excerpt: string;
}

export interface SearchCandidate {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string;
}

export interface IndustryUpdateRecord {
  id: string;
  industryId: string;
  foundAt: string;
  kind: "peer_case" | "procurement" | "policy" | "vendor_move" | "target_action";
  companyId: string;
  summary: string;
  promotedToEventId: string;
}

export interface IndustryWeeklyCollection {
  sources: SourceInput[];
  updates: Array<SourcedRecord<IndustryUpdateRecord>>;
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

export interface CompanyPeopleEventsCollection {
  sources: SourceInput[];
  company: SourcedRecord<CompanyProfileRecord>;
  people: Array<SourcedRecord<PersonRecord>>;
  positions: Array<SourcedRecord<PositionRecord>>;
  events: Array<SourcedRecord<EventRecord>>;
}
