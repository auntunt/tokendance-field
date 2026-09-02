import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ClaimAssessment, InvestigationClaim, InvestigationDossier, InvestigationLens,
  InvestigationPass, InvestigationSource, InvestigationStatus, ResearchPassStatus,
  SourceCheckStatus, InvestigationSubjectType,
} from "./types";
import type { ResearchFinding, ResearchProviderId } from "../research/types";

type Db = InstanceType<typeof Database>;

type InvestigationRow = {
  id: string; question: string; entity_name: string; status: InvestigationStatus;
  provider: ResearchProviderId; subject_type?: InvestigationSubjectType; created_at: string; updated_at: string;
};
type PassRow = {
  id: string; investigation_id: string; lens: InvestigationLens["id"]; title: string;
  description: string; status: ResearchPassStatus; summary: string; open_questions_json: string;
  error: string | null; started_at: string | null; completed_at: string | null;
};
type SourceRow = {
  id: string; investigation_id: string; url: string; domain: string; title: string;
  cited_by_passes_json: string; check_status: SourceCheckStatus; fetched_at: string | null; error: string | null;
};
type ClaimRow = {
  id: string; investigation_id: string; pass_id: string; title: string; evidence: string;
  dimension: string; assessment: ClaimAssessment; source_ids_json: string; relations_json: string;
};
type SourceCheck = { verified: number; cited: number; failed: number };

const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
  try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 18);
const sourceIdFor = (investigationId: string, url: string) => `is-${hash(`${investigationId}|${url}`)}`;

export function ensureInvestigationSchema(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS investigations (
      id TEXT PRIMARY KEY NOT NULL,
      question TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      subject_type TEXT NOT NULL DEFAULT 'company',
      status TEXT NOT NULL,
      provider TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS investigation_passes (
      id TEXT PRIMARY KEY NOT NULL,
      investigation_id TEXT NOT NULL,
      lens TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      open_questions_json TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY(investigation_id) REFERENCES investigations(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS investigation_sources (
      id TEXT PRIMARY KEY NOT NULL,
      investigation_id TEXT NOT NULL,
      url TEXT NOT NULL,
      domain TEXT NOT NULL,
      title TEXT NOT NULL,
      cited_by_passes_json TEXT NOT NULL DEFAULT '[]',
      check_status TEXT NOT NULL DEFAULT 'cited',
      content_text TEXT,
      content_hash TEXT,
      fetched_at TEXT,
      error TEXT,
      UNIQUE(investigation_id, url),
      FOREIGN KEY(investigation_id) REFERENCES investigations(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS investigation_claims (
      id TEXT PRIMARY KEY NOT NULL,
      investigation_id TEXT NOT NULL,
      pass_id TEXT NOT NULL,
      title TEXT NOT NULL,
      evidence TEXT NOT NULL,
      dimension TEXT NOT NULL,
      assessment TEXT NOT NULL DEFAULT 'lead',
      source_ids_json TEXT NOT NULL DEFAULT '[]',
      relations_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY(investigation_id) REFERENCES investigations(id) ON DELETE CASCADE,
      FOREIGN KEY(pass_id) REFERENCES investigation_passes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS investigations_updated_idx ON investigations(updated_at DESC);
    CREATE INDEX IF NOT EXISTS investigation_passes_investigation_idx ON investigation_passes(investigation_id);
    CREATE INDEX IF NOT EXISTS investigation_sources_investigation_idx ON investigation_sources(investigation_id, check_status);
    CREATE INDEX IF NOT EXISTS investigation_claims_investigation_idx ON investigation_claims(investigation_id, pass_id);
  `);
  // 早期档案默认归入公司；之后创建的行业/人员档案会明确标注。
  const columns = new Set((db.prepare("PRAGMA table_info(investigations)").all() as Array<{ name: string }>).map(row => row.name));
  if (!columns.has("subject_type")) db.exec("ALTER TABLE investigations ADD COLUMN subject_type TEXT NOT NULL DEFAULT 'company'");
}

export function createInvestigation(db: Db, input: {
  question: string; entityName: string; subjectType: InvestigationSubjectType; provider: ResearchProviderId; lenses: Array<Pick<InvestigationLens, "id" | "title" | "description">>;
}) {
  ensureInvestigationSchema(db);
  const id = `inv-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const insert = db.transaction(() => {
    db.prepare("INSERT INTO investigations (id, question, entity_name, subject_type, status, provider, created_at, updated_at) VALUES (?, ?, ?, ?, 'researching', ?, ?, ?)")
      .run(id, input.question, input.entityName, input.subjectType, input.provider, now, now);
    const pass = db.prepare("INSERT INTO investigation_passes (id, investigation_id, lens, title, description, status, summary, open_questions_json) VALUES (?, ?, ?, ?, ?, 'queued', '', '[]')");
    for (const lens of input.lenses) pass.run(`pass-${randomUUID().slice(0, 12)}`, id, lens.id, lens.title, lens.description);
  });
  insert();
  return id;
}

export function setPassStatus(db: Db, passId: string, status: ResearchPassStatus, error?: string) {
  const now = new Date().toISOString();
  db.prepare(`UPDATE investigation_passes
    SET status = ?, started_at = CASE WHEN ? = 'researching' THEN ? ELSE started_at END,
        completed_at = CASE WHEN ? IN ('ready', 'failed') THEN ? ELSE completed_at END,
        error = ?
    WHERE id = ?`).run(status, status, now, status, now, error || null, passId);
}

export function savePassMemo(db: Db, input: {
  investigationId: string; passId: string; summary: string; openQuestions: string[]; findings: ResearchFinding[];
}) {
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.prepare("UPDATE investigation_passes SET status = 'ready', summary = ?, open_questions_json = ?, completed_at = ?, error = NULL WHERE id = ?")
      .run(input.summary, JSON.stringify(input.openQuestions), now, input.passId);
    const sourceIds = new Map<string, string>();
    for (const finding of input.findings) {
      const id = sourceIdFor(input.investigationId, finding.sourceUrl);
      const existing = db.prepare("SELECT cited_by_passes_json FROM investigation_sources WHERE id = ?").get(id) as { cited_by_passes_json?: string } | undefined;
      const citedBy = parseJson<string[]>(existing?.cited_by_passes_json, []);
      if (!citedBy.includes(input.passId)) citedBy.push(input.passId);
      db.prepare(`INSERT INTO investigation_sources
        (id, investigation_id, url, domain, title, cited_by_passes_json, check_status)
        VALUES (?, ?, ?, ?, ?, ?, 'cited')
        ON CONFLICT(investigation_id, url) DO UPDATE SET title = excluded.title, cited_by_passes_json = excluded.cited_by_passes_json`
      ).run(id, input.investigationId, finding.sourceUrl, new URL(finding.sourceUrl).hostname, finding.sourceTitle || new URL(finding.sourceUrl).hostname, JSON.stringify(citedBy));
      sourceIds.set(finding.sourceUrl, id);
    }
    const claim = db.prepare(`INSERT INTO investigation_claims
      (id, investigation_id, pass_id, title, evidence, dimension, assessment, source_ids_json, relations_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'lead', ?, ?, ?)`);
    for (const finding of input.findings) {
      claim.run(`claim-${randomUUID().slice(0, 12)}`, input.investigationId, input.passId, finding.title, finding.evidence, finding.dimension,
        JSON.stringify([sourceIds.get(finding.sourceUrl)].filter(Boolean)), JSON.stringify(finding.edges), now);
    }
    db.prepare("UPDATE investigations SET updated_at = ? WHERE id = ?").run(now, input.investigationId);
  });
  transaction();
}

export function setInvestigationStatus(db: Db, id: string, status: InvestigationStatus) {
  db.prepare("UPDATE investigations SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
}

export function nextUnverifiedSources(db: Db, investigationId: string, limit = 8) {
  return db.prepare(`SELECT * FROM investigation_sources WHERE investigation_id = ? AND check_status = 'cited' ORDER BY rowid LIMIT ?`).all(investigationId, limit) as SourceRow[];
}

export function setSourceCheck(db: Db, sourceId: string, input: { status: SourceCheckStatus; contentText?: string; contentHash?: string; error?: string }) {
  db.prepare(`UPDATE investigation_sources SET check_status = ?, content_text = COALESCE(?, content_text), content_hash = COALESCE(?, content_hash),
    fetched_at = CASE WHEN ? = 'verified' THEN ? ELSE fetched_at END, error = ? WHERE id = ?`)
    .run(input.status, input.contentText || null, input.contentHash || null, input.status, new Date().toISOString(), input.error || null, sourceId);
}

function sourceCheckSummary(db: Db, sourceIds: string[]): SourceCheck {
  if (!sourceIds.length) return { verified: 0, cited: 0, failed: 0 };
  const rows = db.prepare(`SELECT check_status FROM investigation_sources WHERE id IN (${sourceIds.map(() => "?").join(",")})`).all(...sourceIds) as Array<{ check_status: SourceCheckStatus }>;
  return rows.reduce<SourceCheck>((summary, row) => {
    if (row.check_status === "verified") summary.verified++;
    else if (row.check_status === "failed") summary.failed++;
    else summary.cited++;
    return summary;
  }, { verified: 0, cited: 0, failed: 0 });
}

function claimAssessment(check: SourceCheck): ClaimAssessment {
  if (check.verified >= 2) return "supported";
  if (check.failed > 0 && check.verified === 0) return "contested";
  return "lead";
}

export function readInvestigation(db: Db, id: string): InvestigationDossier | null {
  ensureInvestigationSchema(db);
  const investigation = db.prepare("SELECT * FROM investigations WHERE id = ?").get(id) as InvestigationRow | undefined;
  if (!investigation) return null;
  const passes = db.prepare("SELECT * FROM investigation_passes WHERE investigation_id = ? ORDER BY rowid").all(id) as PassRow[];
  const sources = db.prepare("SELECT * FROM investigation_sources WHERE investigation_id = ? ORDER BY rowid").all(id) as SourceRow[];
  const claims = db.prepare("SELECT * FROM investigation_claims WHERE investigation_id = ? ORDER BY rowid").all(id) as ClaimRow[];
  const mappedPasses: InvestigationPass[] = passes.map(row => ({
    id: row.id, lens: row.lens, title: row.title, description: row.description, status: row.status,
    summary: row.summary, openQuestions: parseJson(row.open_questions_json, []), error: row.error || undefined,
    startedAt: row.started_at || undefined, completedAt: row.completed_at || undefined,
  }));
  const mappedSources: InvestigationSource[] = sources.map(row => ({
    id: row.id, url: row.url, domain: row.domain, title: row.title,
    citedByPasses: parseJson(row.cited_by_passes_json, []), checkStatus: row.check_status,
    fetchedAt: row.fetched_at || undefined, error: row.error || undefined,
  }));
  const mappedClaims: InvestigationClaim[] = claims.map(row => {
    const sourceIds = parseJson<string[]>(row.source_ids_json, []);
    const check = sourceCheckSummary(db, sourceIds);
    return {
      id: row.id, passId: row.pass_id, title: row.title, evidence: row.evidence, dimension: row.dimension,
      assessment: claimAssessment(check), sourceIds, sourceCheckSummary: check,
      relations: parseJson(row.relations_json, []),
    };
  });
  const openQuestions = [...new Set(mappedPasses.flatMap(pass => pass.openQuestions))].slice(0, 10);
  return {
    id: investigation.id, question: investigation.question, entityName: investigation.entity_name, status: investigation.status,
    subjectType: investigation.subject_type || "company", provider: investigation.provider, createdAt: investigation.created_at, updatedAt: investigation.updated_at,
    passes: mappedPasses, claims: mappedClaims, sources: mappedSources, openQuestions,
  };
}

export function latestInvestigations(db: Db, limit = 12) {
  ensureInvestigationSchema(db);
  return db.prepare("SELECT id, question, entity_name, status, provider, created_at, updated_at FROM investigations ORDER BY updated_at DESC LIMIT ?").all(limit) as InvestigationRow[];
}
