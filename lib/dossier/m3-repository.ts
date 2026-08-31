import type { DossierDatabase, IngestResult } from "./repository";
import { stableId } from "./id";
import type { CompanyPeopleEventsCollection, EvidencePointer, FieldEvidence, SourceInput } from "./types";

function evidencePointer(evidence: FieldEvidence, field: string): EvidencePointer | null {
  const item = evidence[field];
  return typeof item === "object" && item.sourceId && item.excerpt.trim() ? item : null;
}

function validateFields(
  knownSources: Set<string>,
  table: string,
  rowId: string,
  values: Record<string, string>,
  evidence: FieldEvidence,
): void {
  for (const [field, value] of Object.entries(values)) {
    if (!value) continue;
    const pointer = evidencePointer(evidence, field);
    if (!pointer || !knownSources.has(pointer.sourceId)) {
      throw new Error(`${table}.${field} 缺少有效 Source/摘录，拒绝写入 ${rowId}`);
    }
  }
}

function insertSource(db: DossierDatabase, source: SourceInput): void {
  db.prepare(`
    INSERT INTO source (id, url, type, published_at, fingerprint, page_or_excerpt)
    VALUES (@id, @url, @type, @publishedAt, @fingerprint, @pageOrExcerpt)
    ON CONFLICT(id) DO UPDATE SET url=excluded.url, type=excluded.type,
      published_at=excluded.published_at, fingerprint=excluded.fingerprint,
      page_or_excerpt=excluded.page_or_excerpt
  `).run(source);
}

function insertFacts(
  db: DossierDatabase,
  table: string,
  rowId: string,
  values: Record<string, string>,
  evidence: FieldEvidence,
): number {
  let count = 0;
  for (const [field, value] of Object.entries(values)) {
    if (!value) continue;
    const pointer = evidencePointer(evidence, field);
    if (!pointer) throw new Error(`${table}.${field} 缺少证据`);
    db.prepare(`
      INSERT INTO fact (id, source_id, "table", row_id, field) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id, "table", row_id, field) DO NOTHING
    `).run(stableId("fact", pointer.sourceId, table, rowId, field), pointer.sourceId, table, rowId, field);
    count += 1;
  }
  return count;
}

export function ingestCompanyPeopleEvents(
  db: DossierDatabase,
  collection: CompanyPeopleEventsCollection,
): IngestResult {
  const knownSources = new Set(collection.sources.map(source => source.id));
  if (knownSources.size === 0) throw new Error("M3 采集结果没有 Source");
  const company = collection.company.record;
  validateFields(knownSources, "company", company.id, {
    name: company.name,
    industry_id: company.industryId,
    controller: company.controller,
    listing: company.listing,
  }, collection.company.evidence);
  for (const item of collection.people) {
    validateFields(knownSources, "person", item.record.id, {
      name: item.record.name, bio: item.record.bio, stance: item.record.stance,
    }, item.evidence);
  }
  for (const item of collection.positions) {
    const row = item.record;
    validateFields(knownSources, "position", row.id, {
      company_id: row.companyId, person_id: row.personId, title: row.title,
      owns: row.owns, start: row.start, end: row.end,
    }, item.evidence);
  }
  for (const item of collection.events) {
    const row = item.record;
    validateFields(knownSources, "event", row.id, {
      company_id: row.companyId, occurred_at: row.occurredAt, kind: row.kind, summary: row.summary,
    }, item.evidence);
  }

  return db.transaction(() => {
    for (const source of collection.sources) insertSource(db, source);
    if (company.industryId) {
      db.prepare("INSERT INTO industry (id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
        .run(company.industryId, company.industryId);
    }
    db.prepare(`
      INSERT INTO company (id, name, industry_id, controller, listing) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,
        industry_id=COALESCE(excluded.industry_id, company.industry_id),
        controller=CASE WHEN excluded.controller='' THEN company.controller ELSE excluded.controller END,
        listing=CASE WHEN excluded.listing='' THEN company.listing ELSE excluded.listing END
    `).run(company.id, company.name, company.industryId || null, company.controller, company.listing);
    let facts = insertFacts(db, "company", company.id, {
      name: company.name, industry_id: company.industryId, controller: company.controller, listing: company.listing,
    }, collection.company.evidence);
    for (const item of collection.people) {
      const row = item.record;
      db.prepare(`
        INSERT INTO person (id, name, bio, stance) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, bio=excluded.bio, stance=excluded.stance
      `).run(row.id, row.name, row.bio, row.stance);
      facts += insertFacts(db, "person", row.id, { name: row.name, bio: row.bio, stance: row.stance }, item.evidence);
    }
    for (const item of collection.positions) {
      const row = item.record;
      db.prepare(`
        INSERT INTO position (id, company_id, person_id, title, owns, start, end) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, owns=excluded.owns, start=excluded.start, end=excluded.end
      `).run(row.id, row.companyId, row.personId, row.title, row.owns, row.start || null, row.end || null);
      facts += insertFacts(db, "position", row.id, {
        company_id: row.companyId, person_id: row.personId, title: row.title,
        owns: row.owns, start: row.start, end: row.end,
      }, item.evidence);
    }
    for (const item of collection.events) {
      const row = item.record;
      db.prepare(`
        INSERT INTO event (id, company_id, occurred_at, kind, summary) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET occurred_at=excluded.occurred_at, kind=excluded.kind, summary=excluded.summary
      `).run(row.id, row.companyId, row.occurredAt, row.kind, row.summary);
      facts += insertFacts(db, "event", row.id, {
        company_id: row.companyId, occurred_at: row.occurredAt, kind: row.kind, summary: row.summary,
      }, item.evidence);
    }
    return {
      sourceId: collection.sources[0].id,
      companyId: company.id,
      jobPostings: 0,
      orgUnits: 0,
      systems: 0,
      facts,
    };
  })();
}
