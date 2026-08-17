// FDE 查询包的持久层。包数据最初来自 lib/fde-company-index.json，
// 之后每次调度查询都会把结果写回 SQLite——这样查询包会随查询自动更新，
// 而不是永远停留在镜像构建那一刻。
import rawIndex from "./fde-company-index.json";

type Db = InstanceType<typeof import("better-sqlite3")>;
type RawEntry = {
  id: string;
  name: string;
  legalName?: string | null;
  ticker?: string | null;
  listing?: string | null;
  city?: string | null;
  sector?: string | null;
  relevance?: string | null;
  watchlist?: boolean | null;
  updatedAt?: string | null;
  facts?: Record<string, string>;
};
type RawFile = { generatedAt: string; source: string; count: number; entries: RawEntry[] };

const INDEX = (rawIndex as unknown as RawFile).entries ?? [];
const INDEX_VERSION = `${(rawIndex as unknown as RawFile).generatedAt}:${INDEX.length}`;

export type PresetRecord = {
  id: string;
  name: string;
  legalName: string | null;
  ticker: string | null;
  listing: string;
  city: string;
  sector: string;
  relevance: string;
  watchlist: boolean;
  hasFdeFacts: boolean;
  query: string;
  dimensions: string[];
  updatedAt: string;
  lastSearchedAt: string | null;
  candidatesCount: number;
  latestCandidates: Array<{ title: string; source: string; url?: string }>;
  status: string;
};

function hasFdeFacts(entry: RawEntry): boolean {
  const facts = entry.facts || {};
  return Object.keys(facts).some(key => key.startsWith("fde") || key === "onsiteModel" || key === "orgPlacement" || key === "jdEvidence");
}

export function ensureFdePresets(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fde_presets (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      legal_name TEXT,
      ticker TEXT,
      listing TEXT NOT NULL,
      city TEXT NOT NULL,
      sector TEXT NOT NULL,
      relevance TEXT NOT NULL,
      watchlist INTEGER NOT NULL DEFAULT 0,
      has_fde_facts INTEGER NOT NULL DEFAULT 0,
      query TEXT NOT NULL,
      dimensions TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_searched_at TEXT,
      candidates_count INTEGER NOT NULL DEFAULT 0,
      latest_candidates_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS fde_presets_search_idx ON fde_presets(last_searched_at, watchlist, id);
    CREATE TABLE IF NOT EXISTS fde_preset_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);

  const current = db.prepare("SELECT value FROM fde_preset_meta WHERE key='index_version'").get() as { value?: string } | undefined;
  if (current?.value === INDEX_VERSION) return;

  const upsert = db.prepare(`
    INSERT INTO fde_presets (id,name,legal_name,ticker,listing,city,sector,relevance,watchlist,has_fde_facts,query,dimensions,updated_at)
    VALUES (@id,@name,@legal_name,@ticker,@listing,@city,@sector,@relevance,@watchlist,@has_fde_facts,@query,@dimensions,@updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, legal_name=excluded.legal_name, ticker=excluded.ticker,
      listing=excluded.listing, city=excluded.city, sector=excluded.sector,
      relevance=excluded.relevance, watchlist=excluded.watchlist,
      has_fde_facts=excluded.has_fde_facts, query=excluded.query,
      dimensions=excluded.dimensions, updated_at=excluded.updated_at
  `);
  const tx = db.transaction(() => {
    for (const entry of INDEX) {
      const fde = hasFdeFacts(entry);
      upsert.run({
        id: entry.id,
        name: entry.name,
        legal_name: entry.legalName || null,
        ticker: entry.ticker || null,
        listing: entry.listing || "private",
        city: entry.city || "未标注",
        sector: entry.sector || "未归类",
        relevance: entry.relevance || "unclear",
        watchlist: entry.watchlist ? 1 : 0,
        has_fde_facts: fde ? 1 : 0,
        query: fde ? `${entry.name} 前置部署 交付 客户` : `${entry.name} FDE 前置部署 交付`,
        dimensions: JSON.stringify(fde ? ["fde", "business", "funding"] : ["business", "fde", "funding"]),
        updated_at: entry.updatedAt || (rawIndex as unknown as RawFile).generatedAt,
      });
    }
    db.prepare("INSERT INTO fde_preset_meta(key,value) VALUES('index_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(INDEX_VERSION);
  });
  tx();
}

function mapRow(row: Record<string, unknown>): PresetRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    legalName: row.legal_name ? String(row.legal_name) : null,
    ticker: row.ticker ? String(row.ticker) : null,
    listing: String(row.listing),
    city: String(row.city),
    sector: String(row.sector),
    relevance: String(row.relevance),
    watchlist: Boolean(row.watchlist),
    hasFdeFacts: Boolean(row.has_fde_facts),
    query: String(row.query),
    dimensions: JSON.parse(String(row.dimensions || "[]")) as string[],
    updatedAt: String(row.updated_at || ""),
    lastSearchedAt: row.last_searched_at ? String(row.last_searched_at) : null,
    candidatesCount: Number(row.candidates_count || 0),
    latestCandidates: JSON.parse(String(row.latest_candidates_json || "[]")) as Array<{ title: string; source: string; url?: string }>,
    status: String(row.status || "pending"),
  };
}

export function listFdePresets(db: Db, scope: string, limit: number, query: string): { generatedAt: string; total: number; presets: PresetRecord[] } {
  ensureFdePresets(db);
  const all = db.prepare("SELECT * FROM fde_presets").all() as Array<Record<string, unknown>>;
  const generatedAt = (rawIndex as unknown as RawFile).generatedAt;

  let rows = all;
  if (scope === "watchlist") rows = rows.filter(row => Boolean(row.watchlist));
  if (scope === "fde") rows = rows.filter(row => Boolean(row.has_fde_facts));
  if (scope === "focus") rows = rows.filter(row => Boolean(row.watchlist) || Boolean(row.has_fde_facts) || row.relevance === "adjacent");
  const q = query.trim().toLowerCase();
  if (q) rows = rows.filter(row => `${row.name} ${row.legal_name || ""} ${row.sector} ${row.city}`.toLowerCase().includes(q));

  const ORDER: Record<string, number> = { practitioner: 0, adjacent: 1, vendor: 2, unclear: 3 };
  rows = rows.slice().sort((a, b) => {
    const watch = Number(Boolean(b.watchlist)) - Number(Boolean(a.watchlist));
    if (watch) return watch;
    const rel = (ORDER[String(a.relevance)] ?? 9) - (ORDER[String(b.relevance)] ?? 9);
    if (rel) return rel;
    return String(a.name).localeCompare(String(b.name), "zh-CN");
  });

  return { generatedAt, total: rows.length, presets: rows.slice(0, limit).map(mapRow) };
}

/** 下一批该查谁：最久没查的优先，重点公司优先。 */
export function nextPresetBatch(db: Db, limit: number): PresetRecord[] {
  ensureFdePresets(db);
  const rows = db.prepare(`
    SELECT * FROM fde_presets
    ORDER BY (last_searched_at IS NULL) DESC, last_searched_at ASC, watchlist DESC, id ASC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

export function recordPresetSearch(db: Db, id: string, count: number, latest: Array<{ title: string; source: string; url?: string }>, status = "ok") {
  db.prepare(`
    UPDATE fde_presets
    SET last_searched_at=?, candidates_count=candidates_count+?, latest_candidates_json=?, status=?
    WHERE id=?
  `).run(new Date().toISOString(), count, JSON.stringify(latest.slice(0, 5)), status, id);
}

export function presetVersion() {
  return INDEX_VERSION;
}
