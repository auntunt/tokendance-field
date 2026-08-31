import type { DossierDatabase } from "./repository";

export interface MissingSourceField {
  table: string;
  rowId: string;
  field: string;
}

const DIRECT_TABLES = [
  "company", "org_unit", "business_line", "system_in_use", "relationship",
  "financial_snapshot", "event", "job_posting", "opportunity",
] as const;

function rowsForCompany(db: DossierDatabase, table: string, companyId: string): Array<Record<string, unknown>> {
  if (table === "company") return db.prepare("SELECT * FROM company WHERE id=?").all(companyId) as Array<Record<string, unknown>>;
  return db.prepare(`SELECT * FROM ${table} WHERE company_id=?`).all(companyId) as Array<Record<string, unknown>>;
}

function isFilled(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

export function findMissingSourceFields(db: DossierDatabase, companyId: string): MissingSourceField[] {
  const rows = new Map<string, Array<Record<string, unknown>>>();
  for (const table of DIRECT_TABLES) rows.set(table, rowsForCompany(db, table, companyId));
  rows.set("process_step", db.prepare(`
    SELECT ps.* FROM process_step ps JOIN business_line bl ON bl.id=ps.business_line_id
    WHERE bl.company_id=?
  `).all(companyId) as Array<Record<string, unknown>>);
  const positions = db.prepare("SELECT * FROM position WHERE company_id=?").all(companyId) as Array<Record<string, unknown>>;
  rows.set("position", positions);
  const personIds = [...new Set(positions.map(row => String(row.person_id)))];
  rows.set("person", personIds.flatMap(personId => {
    const row = db.prepare("SELECT * FROM person WHERE id=?").get(personId) as Record<string, unknown> | undefined;
    return row ? [row] : [];
  }));
  const company = db.prepare("SELECT industry_id FROM company WHERE id=?").get(companyId) as {industry_id:string|null} | undefined;
  if (company?.industry_id) {
    rows.set("industry", db.prepare("SELECT * FROM industry WHERE id=?").all(company.industry_id) as Array<Record<string, unknown>>);
    rows.set("industry_term", db.prepare("SELECT * FROM industry_term WHERE industry_id=?").all(company.industry_id) as Array<Record<string, unknown>>);
  }

  const missing: MissingSourceField[] = [];
  for (const [table, records] of rows) {
    for (const row of records) {
      const rowId = String(row.id);
      for (const [field, value] of Object.entries(row)) {
        if (field === "id" || !isFilled(value)) continue;
        const fact = db.prepare(`
          SELECT 1 FROM fact f JOIN source s ON s.id=f.source_id
          WHERE f."table"=? AND f.row_id=? AND f.field=?
            AND length(trim(s.url))>0 AND length(trim(s.page_or_excerpt))>0
          LIMIT 1
        `).get(table, rowId, field);
        if (!fact) missing.push({ table, rowId, field });
      }
    }
  }
  return missing.sort((left, right) => `${left.table}:${left.rowId}:${left.field}`.localeCompare(`${right.table}:${right.rowId}:${right.field}`, "en"));
}

export function requireCompleteSourceCoverage(db: DossierDatabase, companyId: string): void {
  const missing = findMissingSourceFields(db, companyId);
  if (missing.length === 0) return;
  const first = missing[0];
  throw new Error(`字段缺少来源：${first.table}.${first.field} (${first.rowId})，共 ${missing.length} 项`);
}
