import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stableId } from "./id";
import type {
  AnnualReportCollection,
  EvidencePointer,
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
    const item = evidence[field];
    const excerpt = typeof item === "string" ? item : item?.excerpt;
    if (!excerpt?.trim()) {
      throw new Error(`${table}.${field} 缺少来源摘录，拒绝写入 ${rowId}`);
    }
  }
}

function evidenceSourceId(item: string | EvidencePointer | undefined, fallbackSourceId: string): string {
  return typeof item === "object" && item.sourceId ? item.sourceId : fallbackSourceId;
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
  evidence: FieldEvidence = {},
): number {
  let count = 0;
  for (const [field, value] of Object.entries(values)) {
    if (!value) continue;
    insertFact(db, evidenceSourceId(evidence[field], sourceId), table, rowId, field);
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
    }, collection.company.evidence);

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
      }, item.evidence);
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
      }, item.evidence);
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
    }, collection.company.evidence);

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
      }, item.evidence);
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
      }, item.evidence);
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


function validateAnnualReportCollection(collection: AnnualReportCollection): void {
  const knownSources = new Set(collection.sources.map(source => source.id));
  const validate = (table: string, rowId: string, values: Record<string, string>, evidence: FieldEvidence) => {
    requireEvidence(table, rowId, values, evidence);
    for (const [field, value] of Object.entries(values)) {
      if (!value) continue;
      const pointer = evidence[field];
      if (typeof pointer !== "object" || !knownSources.has(pointer.sourceId)) {
        throw new Error(`${table}.${field} 缺少页码 Source，拒绝写入 ${rowId}`);
      }
    }
  };
  validate("company", collection.company.record.id, {
    name: collection.company.record.name,
    industry_id: collection.company.record.industryId,
  }, collection.company.evidence);
  const industry = collection.industry.record;
  validate("industry", industry.id, {
    name: industry.name,
    upstream: industry.upstream,
    downstream: industry.downstream,
    kpis: industry.kpis,
    regulators: industry.regulators,
  }, collection.industry.evidence);
  for (const item of collection.industryTerms) {
    const row = item.record;
    validate("industry_term", row.id, {
      industry_id: row.industryId,
      term: row.term,
      plain_meaning: row.plainMeaning,
      aliases: row.aliases,
    }, item.evidence);
  }
  for (const item of collection.businessLines) {
    const row = item.record;
    validate("business_line", row.id, {
      company_id: row.companyId,
      name: row.name,
      revenue_share: row.revenueShare,
    }, item.evidence);
  }
  for (const item of collection.financialSnapshots) {
    const row = item.record;
    validate("financial_snapshot", row.id, {
      company_id: row.companyId,
      year: row.year,
      revenue: row.revenue,
      net_profit: row.netProfit,
      rnd_expense: row.rndExpense,
      it_capex: row.itCapex,
      fundraising_projects: row.fundraisingProjects,
    }, item.evidence);
  }
  for (const item of collection.people) {
    const row = item.record;
    validate("person", row.id, { name: row.name, bio: row.bio, stance: row.stance }, item.evidence);
  }
  for (const item of collection.positions) {
    const row = item.record;
    validate("position", row.id, {
      company_id: row.companyId,
      person_id: row.personId,
      title: row.title,
      owns: row.owns,
      start: row.start,
      end: row.end,
    }, item.evidence);
  }
}

export function ingestAnnualReportCollection(db: DossierDatabase, collection: AnnualReportCollection): IngestResult {
  validateAnnualReportCollection(collection);
  return db.transaction(() => {
    for (const source of collection.sources) insertSource(db, source);
    const fallbackSourceId = collection.sources[0]?.id;
    if (!fallbackSourceId) throw new Error("年报没有可写入的页码 Source");
    const industry = collection.industry.record;
    db.prepare(`
      INSERT INTO industry (id, name, upstream, downstream, kpis, regulators)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, upstream=excluded.upstream,
        downstream=excluded.downstream, kpis=excluded.kpis, regulators=excluded.regulators
    `).run(industry.id, industry.name, industry.upstream, industry.downstream, industry.kpis, industry.regulators);
    let facts = insertFacts(db, fallbackSourceId, "industry", industry.id, {
      name: industry.name, upstream: industry.upstream, downstream: industry.downstream,
      kpis: industry.kpis, regulators: industry.regulators,
    }, collection.industry.evidence);

    const company = collection.company.record;
    db.prepare(`
      INSERT INTO company (id, name, industry_id) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, industry_id=excluded.industry_id
    `).run(company.id, company.name, company.industryId);
    facts += insertFacts(db, fallbackSourceId, "company", company.id, {
      name: company.name, industry_id: company.industryId,
    }, collection.company.evidence);

    for (const item of collection.industryTerms) {
      const row = item.record;
      db.prepare(`
        INSERT INTO industry_term (id, industry_id, term, plain_meaning, aliases) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(industry_id, term) DO UPDATE SET plain_meaning=excluded.plain_meaning, aliases=excluded.aliases
      `).run(row.id, row.industryId, row.term, row.plainMeaning, row.aliases);
      facts += insertFacts(db, fallbackSourceId, "industry_term", row.id, {
        industry_id: row.industryId, term: row.term, plain_meaning: row.plainMeaning, aliases: row.aliases,
      }, item.evidence);
    }
    for (const item of collection.businessLines) {
      const row = item.record;
      db.prepare(`
        INSERT INTO business_line (id, company_id, name, revenue_share) VALUES (?, ?, ?, ?)
        ON CONFLICT(company_id, name) DO UPDATE SET revenue_share=excluded.revenue_share
      `).run(row.id, row.companyId, row.name, row.revenueShare ? Number(row.revenueShare) : null);
      facts += insertFacts(db, fallbackSourceId, "business_line", row.id, {
        company_id: row.companyId, name: row.name, revenue_share: row.revenueShare,
      }, item.evidence);
    }
    for (const item of collection.financialSnapshots) {
      const row = item.record;
      db.prepare(`
        INSERT INTO financial_snapshot (id, company_id, year, revenue, net_profit, rnd_expense, it_capex, fundraising_projects)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_id, year) DO UPDATE SET revenue=excluded.revenue, net_profit=excluded.net_profit,
          rnd_expense=excluded.rnd_expense, it_capex=excluded.it_capex, fundraising_projects=excluded.fundraising_projects
      `).run(row.id, row.companyId, Number(row.year), row.revenue ? Number(row.revenue) : null,
        row.netProfit ? Number(row.netProfit) : null, row.rndExpense ? Number(row.rndExpense) : null,
        row.itCapex ? Number(row.itCapex) : null, row.fundraisingProjects);
      facts += insertFacts(db, fallbackSourceId, "financial_snapshot", row.id, {
        company_id: row.companyId, year: row.year, revenue: row.revenue, net_profit: row.netProfit,
        rnd_expense: row.rndExpense, it_capex: row.itCapex, fundraising_projects: row.fundraisingProjects,
      }, item.evidence);
    }
    for (const item of collection.people) {
      const row = item.record;
      db.prepare(`
        INSERT INTO person (id, name, bio, stance) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, bio=excluded.bio, stance=excluded.stance
      `).run(row.id, row.name, row.bio, row.stance);
      facts += insertFacts(db, fallbackSourceId, "person", row.id, {
        name: row.name, bio: row.bio, stance: row.stance,
      }, item.evidence);
    }
    for (const item of collection.positions) {
      const row = item.record;
      db.prepare(`
        INSERT INTO position (id, company_id, person_id, title, owns, start, end) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, owns=excluded.owns, start=excluded.start, end=excluded.end
      `).run(row.id, row.companyId, row.personId, row.title, row.owns, row.start || null, row.end || null);
      facts += insertFacts(db, fallbackSourceId, "position", row.id, {
        company_id: row.companyId, person_id: row.personId, title: row.title,
        owns: row.owns, start: row.start, end: row.end,
      }, item.evidence);
    }
    return {
      sourceId: fallbackSourceId,
      companyId: company.id,
      jobPostings: 0,
      orgUnits: 0,
      systems: 0,
      facts,
    };
  })();
}
