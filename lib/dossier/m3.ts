import type { CompanyPeopleEventsCollection, FieldEvidence, SourcedRecord } from "./types";

function dedupe<T extends { id: string }>(items: Array<SourcedRecord<T>>): Array<SourcedRecord<T>> {
  const output = new Map<string, SourcedRecord<T>>();
  for (const item of items) output.set(item.record.id, item);
  return [...output.values()];
}

export function mergeCompanyPeopleEvents(
  collections: CompanyPeopleEventsCollection[],
): CompanyPeopleEventsCollection {
  if (collections.length === 0) throw new Error("没有可合并的 M3 采集结果");
  const first = collections[0];
  const company = collections.reduce((merged, current) => {
    if (current.company.record.id !== first.company.record.id) {
      throw new Error("不能合并不同公司的 M3 采集结果");
    }
    const evidence: FieldEvidence = { ...merged.evidence };
    const record = { ...merged.record };
    for (const field of ["name", "industryId", "controller", "listing"] as const) {
      const value = current.company.record[field];
      const evidenceField = field === "industryId" ? "industry_id" : field;
      if (value) {
        record[field] = value;
        evidence[evidenceField] = current.company.evidence[evidenceField];
      }
    }
    return { record, evidence };
  }, first.company);
  const sources = new Map(collections.flatMap(collection => collection.sources).map(source => [source.id, source]));
  return {
    sources: [...sources.values()],
    company,
    people: dedupe(collections.flatMap(collection => collection.people)),
    positions: dedupe(collections.flatMap(collection => collection.positions)),
    events: dedupe(collections.flatMap(collection => collection.events)),
  };
}
