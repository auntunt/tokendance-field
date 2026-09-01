import { stableId } from "./id";
import type { DossierDatabase } from "./repository";

export interface SnapshotRecord {
  table: string;
  rowId: string;
  fields: Record<string, string | number | null>;
  sourceUrls: string[];
}

export interface DossierSnapshot {
  companyId: string;
  records: SnapshotRecord[];
}

export interface SnapshotChange {
  kind: "added" | "removed" | "changed";
  table: string;
  rowId: string;
  field: string;
  before: string | number | null;
  after: string | number | null;
  sourceUrls: string[];
}

const DIRECT_TABLES = [
  "company", "org_unit", "business_line", "system_in_use", "relationship",
  "financial_snapshot", "event", "job_posting", "opportunity",
] as const;

function sourceUrls(db: DossierDatabase, table: string, rowId: string): string[] {
  return (db.prepare(`
    SELECT DISTINCT s.url FROM fact f JOIN source s ON s.id=f.source_id
    WHERE f."table"=? AND f.row_id=? ORDER BY s.url
  `).all(table, rowId) as Array<{url:string}>).map(row => row.url);
}

function recordFromRow(db: DossierDatabase, table: string, row: Record<string, unknown>): SnapshotRecord {
  const rowId = String(row.id);
  const fields = Object.fromEntries(Object.entries(row)
    .filter(([field]) => field !== "id")
    .map(([field, value]) => [field, value === undefined ? null : value as string | number | null]));
  return { table, rowId, fields, sourceUrls: sourceUrls(db, table, rowId) };
}

export function captureDossierSnapshot(db: DossierDatabase, companyId: string): DossierSnapshot {
  const records: SnapshotRecord[] = [];
  for (const table of DIRECT_TABLES) {
    const rows = table === "company"
      ? db.prepare("SELECT * FROM company WHERE id=?").all(companyId)
      : db.prepare(`SELECT * FROM ${table} WHERE company_id=?`).all(companyId);
    for (const row of rows as Array<Record<string, unknown>>) records.push(recordFromRow(db, table, row));
  }
  const processes = db.prepare(`
    SELECT ps.* FROM process_step ps JOIN business_line bl ON bl.id=ps.business_line_id
    WHERE bl.company_id=?
  `).all(companyId) as Array<Record<string, unknown>>;
  for (const row of processes) records.push(recordFromRow(db, "process_step", row));
  const positions = db.prepare("SELECT * FROM position WHERE company_id=?").all(companyId) as Array<Record<string, unknown>>;
  for (const row of positions) records.push(recordFromRow(db, "position", row));
  const personIds = positions.map(row => String(row.person_id));
  for (const personId of [...new Set(personIds)]) {
    const row = db.prepare("SELECT * FROM person WHERE id=?").get(personId) as Record<string, unknown> | undefined;
    if (row) records.push(recordFromRow(db, "person", row));
  }
  const company = db.prepare("SELECT industry_id FROM company WHERE id=?").get(companyId) as {industry_id:string|null} | undefined;
  if (company?.industry_id) {
    const industry = db.prepare("SELECT * FROM industry WHERE id=?").get(company.industry_id) as Record<string, unknown> | undefined;
    if (industry) records.push(recordFromRow(db, "industry", industry));
    const terms = db.prepare("SELECT * FROM industry_term WHERE industry_id=?").all(company.industry_id) as Array<Record<string, unknown>>;
    for (const row of terms) records.push(recordFromRow(db, "industry_term", row));
  }
  records.sort((left, right) => `${left.table}:${left.rowId}`.localeCompare(`${right.table}:${right.rowId}`, "en"));
  return { companyId, records };
}

export function diffDossierSnapshots(before: DossierSnapshot | null, after: DossierSnapshot): SnapshotChange[] {
  if (!before) return [];
  const previous = new Map(before.records.map(row => [`${row.table}:${row.rowId}`, row]));
  const current = new Map(after.records.map(row => [`${row.table}:${row.rowId}`, row]));
  const changes: SnapshotChange[] = [];
  for (const [key, row] of current) {
    const old = previous.get(key);
    if (!old) {
      changes.push({ kind: "added", table: row.table, rowId: row.rowId, field: "*", before: null, after: "新增", sourceUrls: row.sourceUrls });
      continue;
    }
    const fields = new Set([...Object.keys(old.fields), ...Object.keys(row.fields)]);
    for (const field of [...fields].sort()) {
      if (old.fields[field] === row.fields[field]) continue;
      changes.push({
        kind: "changed", table: row.table, rowId: row.rowId, field,
        before: old.fields[field] ?? null, after: row.fields[field] ?? null,
        sourceUrls: row.sourceUrls,
      });
    }
  }
  for (const [key, row] of previous) {
    if (current.has(key)) continue;
    changes.push({ kind: "removed", table: row.table, rowId: row.rowId, field: "*", before: "移除", after: null, sourceUrls: row.sourceUrls });
  }
  return changes.sort((a, b) => `${a.table}:${a.rowId}:${a.field}`.localeCompare(`${b.table}:${b.rowId}:${b.field}`, "en"));
}

function parseSnapshot(snapshot: string): DossierSnapshot {
  return JSON.parse(snapshot) as DossierSnapshot;
}

export function createDossierRun(
  db: DossierDatabase,
  companyId: string,
  ranAt: string,
): { runId: string; snapshot: DossierSnapshot; changes: SnapshotChange[] } {
  const previous = db.prepare(`
    SELECT snapshot FROM dossier_run WHERE company_id=? ORDER BY ran_at DESC, id DESC LIMIT 1
  `).get(companyId) as {snapshot:string} | undefined;
  const snapshot = captureDossierSnapshot(db, companyId);
  const changes = diffDossierSnapshots(previous ? parseSnapshot(previous.snapshot) : null, snapshot);
  const runId = stableId("run", companyId, ranAt);
  db.prepare(`
    INSERT INTO dossier_run (id, company_id, ran_at, snapshot) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot
  `).run(runId, companyId, ranAt, JSON.stringify(snapshot));
  return { runId, snapshot, changes };
}
