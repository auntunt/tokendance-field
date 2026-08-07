import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const databasePath = process.env.DATABASE_PATH || "./data/tokendance-field.sqlite";
type FieldDatabase = InstanceType<typeof Database>;

declare global {
  var tokendanceFieldDb: FieldDatabase | undefined;
}

export function getDb() {
  if (!globalThis.tokendanceFieldDb) {
    mkdirSync(dirname(databasePath), { recursive: true });
    const db = new Database(databasePath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    globalThis.tokendanceFieldDb = db;
  }
  return globalThis.tokendanceFieldDb;
}

export function ensureWorkspaceSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      weights_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evidence_records (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      evidence TEXT NOT NULL,
      source TEXT NOT NULL,
      source_url TEXT,
      created_at TEXT NOT NULL,
      dimensions_json TEXT NOT NULL,
      topics_json TEXT NOT NULL,
      candidate_score INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      starred INTEGER NOT NULL DEFAULT 0,
      ai_analysis_json TEXT,
      created_by TEXT NOT NULL,
      edges_json TEXT,
      origin TEXT
    );
    CREATE TABLE IF NOT EXISTS feedback_records (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      signal_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      weight_change TEXT NOT NULL,
      created_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS judgment_constraints (
      signal_id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      epistemic_state TEXT NOT NULL,
      falsifier TEXT NOT NULL,
      counter_evidence TEXT NOT NULL,
      source_type TEXT NOT NULL,
      valid_until TEXT,
      probability INTEGER NOT NULL,
      signed_off INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outcome_evaluations (
      feedback_id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      execution_quality INTEGER NOT NULL,
      predicted_probability INTEGER NOT NULL,
      brier_score INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      signal_count INTEGER NOT NULL,
      feedback_count INTEGER NOT NULL,
      note TEXT NOT NULL,
      created_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS person_records (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      employer TEXT NOT NULL,
      department TEXT NOT NULL,
      title TEXT NOT NULL,
      our_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS evidence_workspace_idx ON evidence_records(workspace_id);
    CREATE INDEX IF NOT EXISTS person_workspace_idx ON person_records(workspace_id);
    CREATE INDEX IF NOT EXISTS person_employer_idx ON person_records(workspace_id, employer);
    CREATE INDEX IF NOT EXISTS feedback_workspace_idx ON feedback_records(workspace_id);
    CREATE INDEX IF NOT EXISTS constraints_workspace_idx ON judgment_constraints(workspace_id);
    CREATE INDEX IF NOT EXISTS evaluations_workspace_idx ON outcome_evaluations(workspace_id);
    CREATE INDEX IF NOT EXISTS snapshots_workspace_idx ON snapshots(workspace_id);
  `);
  // 关系图字段是后加的：已存在的库要补列，否则关系边在重载后会丢。
  const columns = new Set((db.prepare("PRAGMA table_info(evidence_records)").all() as Array<{ name: string }>).map(row => row.name));
  if (!columns.has("edges_json")) db.exec("ALTER TABLE evidence_records ADD COLUMN edges_json TEXT");
  if (!columns.has("origin")) db.exec("ALTER TABLE evidence_records ADD COLUMN origin TEXT");
  // 人际来源出处同样是后加的：sourceType 为 internal 时它参与门 5 判定，丢了会让已过闸的私有情报退回。
  const constraintColumns = new Set((db.prepare("PRAGMA table_info(judgment_constraints)").all() as Array<{ name: string }>).map(row => row.name));
  if (!constraintColumns.has("human_source")) db.exec("ALTER TABLE judgment_constraints ADD COLUMN human_source TEXT");
}
