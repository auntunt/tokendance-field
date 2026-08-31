import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stableId } from "./id";
import type {
  FieldEvidence,
  JobPostingCollection,
  ProcurementCollection,
  SourceInput,
} from "./types";

export type DossierDatabase = InstanceType<typeof Database>;

export interface IngestResult {
  sourceId: string;
  companyId: string;
  jobPostings: number;
  orgUnits: number;
  systems: number;
  facts: number;
}

export function initializeDossierSchema(
  db: DossierDatabase,
  schemaPath = resolve(process.cwd(), "db/schema.sql"),
): void {
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(schemaPath, "utf8"));
}

function requireEvidence(
  table: string,
  rowId: string,
  values: Record<string, string>,
  evidence: FieldEvidence,
): void {
  for (const [field, value] of Object.entries(values)) {
    if (!value) continue;
    if (!evidence[field]?.trim()) {
      throw new Error(`${table}.${field} 缺少来源摘录，拒绝写入 ${rowId}`);
    }
  }
}

function validateJobCollection(collection: JobPostingCollection): void {
  requireEvidence("company", collection.company.record.id, { name: collection.company.record.name }, collection.company.evidence);
  for (const item of collection.jobPostings) {
    const row = item.record;
    requireEvidence("job_posting", row.id, {
      org_unit: row.orgUnit,
      title: row.title,
      tech_keywords: row.techKeywords,
      system_keywords: row.systemKeywords,
      posted_at: row.postedAt,
    }, item.evidence);
  }
  for (const item of collection.orgUnits) {
    requireEvidence("org_unit", item.record.id, {
      name: item.record.name,
      parent_id: item.record.parentId,
      head_person_id: item.record.headPersonId,
    }, item.evidence);
  }
}

function validateProcurementCollection(collection: ProcurementCollection): void {
  requireEvidence("company", collection.company.record.id, { name: collection.company.record.name }, collection.company.evidence);
  for (const item of collection.systems) {
    const row = item.record;
    requireEvidence("system_in_use", row.id, {
      category: row.category,
      product: row.product,
      vendor: row.vendor,
      covers_process_step: row.coversProcessStep,
      since: row.since,
    }, item.evidence);
  }
  for (const item of collection.orgUnits) {
    requireEvidence("org_unit", item.record.id, {
      name: item.record.name,
      parent_id: item.record.parentId,
      head_person_id: item.record.headPersonId,
    }, item.evidence);
  }
}

function insertSource(db: DossierDatabase, source: SourceInput): void {
  db.prepare(`
    INSERT INTO source (id, url, type, published_at, fingerprint, page_or_excerpt)
    VALUES (@id, @url, @type, @publishedAt, @fingerprint, @pageOrExcerpt)
    ON CONFLICT(id) DO UPDATE SET
      url = excluded.url,
      type = excluded.type,
      published_at = excluded.published_at,
      fingerprint = excluded.fingerprint,
      page_or_excerpt = excluded.page_or_excerpt
  `).run(source);
}

function insertCompany(db: DossierDatabase, id: string, name: string): void {
  db.prepare(`
    INSERT INTO company (id, name) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name
  `).run(id, name);
}

function insertFact(db: DossierDatabase, sourceId: string, table: string, rowId: string, field: string): void {
  db.prepare(`
    INSERT INTO fact (id, source_id, "table", row_id, field)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_id, "table", row_id, field) DO NOTHING
  `).run(stableId("fact", sourceId, table, rowId, field), sourceId, table, rowId, field);
}

function insertFacts(
  db: DossierDatabase,
  sourceId: string,
  table: string,
  rowId: string,
  values: Record<string, string>,
): number {
  let count = 0;
  for (const [field, value] of Object.entries(values)) {
    if (!value) continue;
    insertFact(db, sourceId, table, rowId, field);
    count += 1;
  }
  return count;
}

export function ingestJobPostingCollection(
  db: DossierDatabase,
  collection: JobPostingCollection,
): IngestResult {
  validateJobCollection(collection);
  return db.transaction(() => {
    insertSource(db, collection.source);
    insertCompany(db, collection.company.record.id, collection.company.record.name);
    let facts = insertFacts(db, collection.source.id, "company", collection.company.record.id, {
      name: collection.company.record.name,
    });

    for (const item of collection.orgUnits) {
      const row = item.record;
      db.prepare(`
        INSERT INTO org_unit (id, company_id, name, parent_id, head_person_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(company_id, name) DO UPDATE SET
          parent_id = COALESCE(excluded.parent_id, org_unit.parent_id),
          head_person_id = COALESCE(excluded.head_person_id, org_unit.head_person_id)
      `).run(row.id, row.companyId, row.name, row.parentId || null, row.headPersonId || null);
      facts += insertFacts(db, collection.source.id, "org_unit", row.id, {
        name: row.name,
        parent_id: row.parentId,
        head_person_id: row.headPersonId,
      });
    }

    for (const item of collection.jobPostings) {
      const row = item.record;
      db.prepare(`
        INSERT INTO job_posting (id, company_id, org_unit, title, tech_keywords, system_keywords, posted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_id, title, posted_at) DO UPDATE SET
          org_unit = excluded.org_unit,
          tech_keywords = excluded.tech_keywords,
          system_keywords = excluded.system_keywords
      `).run(row.id, row.companyId, row.orgUnit, row.title, row.techKeywords, row.systemKeywords, row.postedAt);
      facts += insertFacts(db, collection.source.id, "job_posting", row.id, {
        org_unit: row.orgUnit,
        title: row.title,
        tech_keywords: row.techKeywords,
        system_keywords: row.systemKeywords,
        posted_at: row.postedAt,
      });
    }

    return {
      sourceId: collection.source.id,
      companyId: collection.company.record.id,
      jobPostings: collection.jobPostings.length,
      orgUnits: collection.orgUnits.length,
      systems: 0,
      facts,
    };
  })();
}

export function ingestProcurementCollection(
  db: DossierDatabase,
  collection: ProcurementCollection,
): IngestResult {
  validateProcurementCollection(collection);
  return db.transaction(() => {
    insertSource(db, collection.source);
    insertCompany(db, collection.company.record.id, collection.company.record.name);
    let facts = insertFacts(db, collection.source.id, "company", collection.company.record.id, {
      name: collection.company.record.name,
    });

    for (const item of collection.orgUnits) {
      const row = item.record;
      db.prepare(`
        INSERT INTO org_unit (id, company_id, name, parent_id, head_person_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(company_id, name) DO NOTHING
      `).run(row.id, row.companyId, row.name, row.parentId || null, row.headPersonId || null);
      facts += insertFacts(db, collection.source.id, "org_unit", row.id, {
        name: row.name,
        parent_id: row.parentId,
        head_person_id: row.headPersonId,
      });
    }

    for (const item of collection.systems) {
      const row = item.record;
      db.prepare(`
        INSERT INTO system_in_use (id, company_id, category, product, vendor, covers_process_step, since)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_id, category, product) DO UPDATE SET
          vendor = excluded.vendor,
          covers_process_step = excluded.covers_process_step,
          since = excluded.since
      `).run(
        row.id,
        row.companyId,
        row.category,
        row.product,
        row.vendor,
        row.coversProcessStep,
        row.since || null,
      );
      facts += insertFacts(db, collection.source.id, "system_in_use", row.id, {
        category: row.category,
        product: row.product,
        vendor: row.vendor,
        covers_process_step: row.coversProcessStep,
        since: row.since,
      });
    }

    return {
      sourceId: collection.source.id,
      companyId: collection.company.record.id,
      jobPostings: 0,
      orgUnits: collection.orgUnits.length,
      systems: collection.systems.length,
      facts,
    };
  })();
}
