import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ClaimValidation, ClaimValidationStatus, ResearchProviderId } from "./types";

type Db = InstanceType<typeof Database>;

type SourceInput = {
  url: string;
  domain: string;
  title: string;
  grade: string;
  contentHash: string;
  contentText: string;
  fetchedAt: string;
};

type ClaimInput = {
  title: string;
  evidence: string;
  entityName: string;
  dimension: string;
  edges?: unknown;
};

function hash(value: string, size = 24) {
  return createHash("sha256").update(value).digest("hex").slice(0, size);
}

function normalized(value: unknown) {
  return String(value || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "").slice(0, 260);
}

function claimKey(input: ClaimInput) {
  const edges = Array.isArray(input.edges) ? input.edges as Array<Record<string, unknown>> : [];
  const edgeKeys = edges.map(edge => [normalized(edge.from), normalized(edge.relation), normalized(edge.to), normalized(edge.direction)].join("|")).filter(Boolean).sort();
  if (edgeKeys.length) return `${normalized(input.entityName)}|edge|${edgeKeys.join(";")}`;
  return `${normalized(input.entityName)}|text|${normalized(input.title)}|${normalized(input.evidence).slice(0, 96)}`;
}

export function ensureResearchSchema(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_runs (
      id TEXT PRIMARY KEY NOT NULL,
      fragment TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      dimensions_json TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      sources_count INTEGER NOT NULL DEFAULT 0,
      claims_count INTEGER NOT NULL DEFAULT 0,
      corroborated_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS research_sources (
      id TEXT PRIMARY KEY NOT NULL,
      url TEXT NOT NULL UNIQUE,
      domain TEXT NOT NULL,
      title TEXT NOT NULL,
      grade TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content_text TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS research_run_sources (
      run_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      search_query TEXT NOT NULL,
      dimension TEXT NOT NULL,
      rank INTEGER NOT NULL,
      provider TEXT NOT NULL,
      PRIMARY KEY (run_id, source_id, search_query)
    );
    CREATE TABLE IF NOT EXISTS research_claims (
      id TEXT PRIMARY KEY NOT NULL,
      claim_hash TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      evidence TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      dimension TEXT NOT NULL,
      edges_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 1,
      validation_status TEXT NOT NULL DEFAULT 'single-source',
      source_count INTEGER NOT NULL DEFAULT 1,
      independent_source_count INTEGER NOT NULL DEFAULT 0,
      distinct_content_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS research_claim_sources (
      claim_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      PRIMARY KEY (claim_id, source_id, run_id)
    );
    CREATE TABLE IF NOT EXISTS research_query_links (
      id TEXT PRIMARY KEY NOT NULL,
      from_run_id TEXT NOT NULL,
      to_run_id TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      shared_dimensions_json TEXT NOT NULL,
      shared_sources INTEGER NOT NULL DEFAULT 0,
      shared_claims INTEGER NOT NULL DEFAULT 0,
      strength INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(from_run_id, to_run_id)
    );
    CREATE INDEX IF NOT EXISTS research_runs_entity_idx ON research_runs(entity_name, completed_at);
    CREATE INDEX IF NOT EXISTS research_sources_domain_idx ON research_sources(domain);
    CREATE INDEX IF NOT EXISTS research_claims_entity_idx ON research_claims(entity_name, dimension);
    CREATE INDEX IF NOT EXISTS research_claim_sources_run_idx ON research_claim_sources(run_id);
    CREATE INDEX IF NOT EXISTS research_links_run_idx ON research_query_links(from_run_id, to_run_id);
  `);
}

export function beginResearchRun(db: Db, input: {
  id: string;
  fragment: string;
  entityName: string;
  dimensions: string[];
  provider: ResearchProviderId;
  startedAt: string;
}) {
  ensureResearchSchema(db);
  db.prepare(`
    INSERT INTO research_runs (id,fragment,entity_name,dimensions_json,provider,status,started_at)
    VALUES (?,?,?,?,?,'running',?)
    ON CONFLICT(id) DO UPDATE SET status='running', error=NULL
  `).run(input.id, input.fragment, input.entityName, JSON.stringify(input.dimensions), input.provider, input.startedAt);
}

export function recordResearchSource(db: Db, input: SourceInput) {
  ensureResearchSchema(db);
  const id = `src-${hash(input.url)}`;
  db.prepare(`
    INSERT INTO research_sources (id,url,domain,title,grade,content_hash,content_text,first_seen_at,last_seen_at,seen_count)
    VALUES (?,?,?,?,?,?,?,?,?,1)
    ON CONFLICT(url) DO UPDATE SET
      domain=excluded.domain,
      title=CASE WHEN length(excluded.title) > length(research_sources.title) THEN excluded.title ELSE research_sources.title END,
      grade=excluded.grade,
      content_hash=excluded.content_hash,
      content_text=excluded.content_text,
      last_seen_at=excluded.last_seen_at,
      seen_count=research_sources.seen_count + 1
  `).run(id, input.url, input.domain, input.title.slice(0, 300), input.grade, input.contentHash, input.contentText.slice(0, 120_000), input.fetchedAt, input.fetchedAt);
  const row = db.prepare("SELECT id FROM research_sources WHERE url=?").get(input.url) as { id: string };
  return row.id;
}

export function linkRunSource(db: Db, input: {
  runId: string;
  sourceId: string;
  searchQuery: string;
  dimension: string;
  rank: number;
  provider: ResearchProviderId;
}) {
  db.prepare(`
    INSERT OR IGNORE INTO research_run_sources (run_id,source_id,search_query,dimension,rank,provider)
    VALUES (?,?,?,?,?,?)
  `).run(input.runId, input.sourceId, input.searchQuery, input.dimension, input.rank, input.provider);
}

function updateClaimValidation(db: Db, claimId: string): ClaimValidation {
  const rows = db.prepare(`
    SELECT DISTINCT s.id, s.domain, s.grade, s.content_hash
    FROM research_claim_sources cs
    JOIN research_sources s ON s.id = cs.source_id
    WHERE cs.claim_id=?
  `).all(claimId) as Array<{ id: string; domain: string; grade: string; content_hash: string }>;
  const independent = rows.filter(row => row.grade === "statutory" || row.grade === "independent");
  const independentPairs = new Set(independent.map(row => `${row.domain}|${row.content_hash}`));
  const independentContents = new Set(independent.map(row => row.content_hash));
  const allContents = new Set(rows.map(row => row.content_hash));

  let status: ClaimValidationStatus = "single-source";
  if (independentPairs.size >= 2 && independentContents.size >= 2) status = "corroborated";
  else if (rows.length >= 2 && allContents.size === 1) status = "repeated-copy";

  const validation: ClaimValidation = {
    claimId,
    status,
    sourceCount: rows.length,
    independentSourceCount: independentPairs.size,
    distinctContentCount: allContents.size,
  };
  db.prepare(`
    UPDATE research_claims SET validation_status=?,source_count=?,independent_source_count=?,distinct_content_count=? WHERE id=?
  `).run(validation.status, validation.sourceCount, validation.independentSourceCount, validation.distinctContentCount, claimId);
  return validation;
}

export function recordResearchClaim(db: Db, input: ClaimInput & { runId: string; sourceId: string; seenAt: string }) {
  ensureResearchSchema(db);
  const key = claimKey(input);
  const claimHash = hash(key, 32);
  const id = `clm-${claimHash.slice(0, 24)}`;
  db.prepare(`
    INSERT INTO research_claims (id,claim_hash,title,evidence,entity_name,dimension,edges_json,first_seen_at,last_seen_at,seen_count)
    VALUES (?,?,?,?,?,?,?,?,?,1)
    ON CONFLICT(claim_hash) DO UPDATE SET
      title=CASE WHEN length(excluded.title) > length(research_claims.title) THEN excluded.title ELSE research_claims.title END,
      evidence=CASE WHEN length(excluded.evidence) > length(research_claims.evidence) THEN excluded.evidence ELSE research_claims.evidence END,
      last_seen_at=excluded.last_seen_at,
      seen_count=research_claims.seen_count + 1
  `).run(id, claimHash, input.title.slice(0, 300), input.evidence.slice(0, 6000), input.entityName.slice(0, 300), input.dimension.slice(0, 80), JSON.stringify(input.edges || []), input.seenAt, input.seenAt);
  const row = db.prepare("SELECT id FROM research_claims WHERE claim_hash=?").get(claimHash) as { id: string };
  db.prepare("INSERT OR IGNORE INTO research_claim_sources (claim_id,source_id,run_id) VALUES (?,?,?)").run(row.id, input.sourceId, input.runId);
  return updateClaimValidation(db, row.id);
}

export function validationForClaim(db: Db, claimId: string): ClaimValidation {
  const row = db.prepare(`
    SELECT id,validation_status,source_count,independent_source_count,distinct_content_count FROM research_claims WHERE id=?
  `).get(claimId) as { id: string; validation_status: ClaimValidationStatus; source_count: number; independent_source_count: number; distinct_content_count: number } | undefined;
  if (!row) return { claimId, status: "single-source", sourceCount: 0, independentSourceCount: 0, distinctContentCount: 0 };
  return { claimId: row.id, status: row.validation_status, sourceCount: row.source_count, independentSourceCount: row.independent_source_count, distinctContentCount: row.distinct_content_count };
}

function overlapCount(db: Db, table: "research_run_sources" | "research_claim_sources", left: string, right: string) {
  const column = table === "research_run_sources" ? "source_id" : "claim_id";
  const row = db.prepare(`
    SELECT count(DISTINCT a.${column}) AS count
    FROM ${table} a JOIN ${table} b ON a.${column}=b.${column}
    WHERE a.run_id=? AND b.run_id=?
  `).get(left, right) as { count: number };
  return Number(row.count || 0);
}

function createQueryLinks(db: Db, runId: string, completedAt: string) {
  const current = db.prepare("SELECT entity_name,dimensions_json FROM research_runs WHERE id=?").get(runId) as { entity_name: string; dimensions_json: string };
  const currentDimensions = new Set<string>(JSON.parse(current.dimensions_json || "[]") as string[]);
  const previous = db.prepare("SELECT id,entity_name,dimensions_json FROM research_runs WHERE id<>? AND status='done' ORDER BY completed_at DESC LIMIT 80").all(runId) as Array<{ id: string; entity_name: string; dimensions_json: string }>;

  for (const other of previous) {
    const otherDimensions = new Set<string>(JSON.parse(other.dimensions_json || "[]") as string[]);
    const sharedDimensions = [...currentDimensions].filter(item => otherDimensions.has(item));
    const sharedSources = overlapCount(db, "research_run_sources", runId, other.id);
    const sharedClaims = overlapCount(db, "research_claim_sources", runId, other.id);
    const sameEntity = normalized(current.entity_name) === normalized(other.entity_name);
    const strength = Math.min(100, (sameEntity ? 42 : 0) + sharedDimensions.length * 9 + sharedSources * 14 + sharedClaims * 20);
    if (strength < 20) continue;
    const id = `ql-${hash(`${runId}|${other.id}`)}`;
    db.prepare(`
      INSERT OR REPLACE INTO research_query_links
      (id,from_run_id,to_run_id,entity_name,shared_dimensions_json,shared_sources,shared_claims,strength,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(id, runId, other.id, sameEntity ? current.entity_name : "跨主体", JSON.stringify(sharedDimensions), sharedSources, sharedClaims, strength, completedAt);
  }
}

export function completeResearchRun(db: Db, runId: string, status: "done" | "error", completedAt: string, error = "") {
  ensureResearchSchema(db);
  const sources = (db.prepare("SELECT count(DISTINCT source_id) AS count FROM research_run_sources WHERE run_id=?").get(runId) as { count: number }).count;
  const claims = (db.prepare("SELECT count(DISTINCT claim_id) AS count FROM research_claim_sources WHERE run_id=?").get(runId) as { count: number }).count;
  const corroborated = (db.prepare(`
    SELECT count(DISTINCT cs.claim_id) AS count FROM research_claim_sources cs
    JOIN research_claims c ON c.id=cs.claim_id
    WHERE cs.run_id=? AND c.validation_status='corroborated'
  `).get(runId) as { count: number }).count;
  db.prepare(`
    UPDATE research_runs SET status=?,completed_at=?,sources_count=?,claims_count=?,corroborated_count=?,error=? WHERE id=?
  `).run(status, completedAt, sources, claims, corroborated, error.slice(0, 1000) || null, runId);
  if (status === "done") createQueryLinks(db, runId, completedAt);
  return { sources, claims, corroborated };
}

export function researchOverview(db: Db) {
  ensureResearchSchema(db);
  const stat = (sql: string) => Number((db.prepare(sql).get() as { count: number }).count || 0);
  const stats = {
    runs: stat("SELECT count(*) AS count FROM research_runs"),
    sources: stat("SELECT count(*) AS count FROM research_sources"),
    claims: stat("SELECT count(*) AS count FROM research_claims"),
    corroborated: stat("SELECT count(*) AS count FROM research_claims WHERE validation_status='corroborated'"),
    linkedQueries: stat("SELECT count(*) AS count FROM research_query_links"),
  };
  const recentRuns = db.prepare(`
    SELECT id,fragment,entity_name,dimensions_json,provider,status,started_at,completed_at,sources_count,claims_count,corroborated_count
    FROM research_runs ORDER BY started_at DESC LIMIT 8
  `).all();
  const recentSources = db.prepare(`
    SELECT id,url,domain,title,grade,last_seen_at,seen_count FROM research_sources ORDER BY last_seen_at DESC LIMIT 8
  `).all();
  const links = db.prepare(`
    SELECT l.id,l.from_run_id,l.to_run_id,l.entity_name,l.shared_dimensions_json,l.shared_sources,l.shared_claims,l.strength,l.created_at,
      a.fragment AS from_fragment,b.fragment AS to_fragment
    FROM research_query_links l
    JOIN research_runs a ON a.id=l.from_run_id
    JOIN research_runs b ON b.id=l.to_run_id
    ORDER BY l.created_at DESC,l.strength DESC LIMIT 10
  `).all();
  return { stats, recentRuns, recentSources, links };
}
