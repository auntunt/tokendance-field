export type SourceType = "filing" | "official" | "third_party";

export interface SourceInput {
  id: string;
  url: string;
  type: SourceType;
  publishedAt: string;
  fingerprint: string;
  pageOrExcerpt: string;
}

export type FieldEvidence = Record<string, string>;

export interface SourcedRecord<T> {
  record: T;
  evidence: FieldEvidence;
}

export interface CompanyRecord {
  id: string;
  name: string;
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
