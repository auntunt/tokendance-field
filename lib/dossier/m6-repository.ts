import { stableId } from "./id";
import type { DossierDatabase } from "./repository";
import type { EvidencePointer, IndustryWeeklyCollection } from "./types";

const ACCEPTANCE_WEEKS = 4;
const ACCEPTANCE_SELECTIONS_PER_WEEK = 3;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;

export interface IndustryWeeklyAcceptanceWeek {
  from: string;
  to: string;
  selected: number;
  passed: boolean;
  current: boolean;
}

export interface IndustryWeeklyAcceptance {
  accepted: boolean;
  acceptedAtWeek: string | null;
  maxConsecutiveWeeks: number;
  requiredWeeks: number;
  requiredSelectionsPerWeek: number;
  recentWeeks: IndustryWeeklyAcceptanceWeek[];
}

function dateKeyInShanghai(value: Date): string {
  return new Date(value.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftDateKey(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mondayOfDateKey(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  const day = date.getUTCDay() || 7;
  return shiftDateKey(value, 1 - day);
}

function weekOfTimestamp(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : mondayOfDateKey(dateKeyInShanghai(date));
}

export function ensureIndustryWeeklySchema(db: DossierDatabase): void {
  const columns = db.prepare("PRAGMA table_info(industry_update)").all() as Array<{ name: string }>;
  if (columns.length > 0 && !columns.some(column => column.name === "promoted_at")) {
    db.exec("ALTER TABLE industry_update ADD COLUMN promoted_at TEXT");
  }
}

export function getIndustryWeeklyAcceptance(
  db: DossierDatabase,
  industryId: string,
  now = new Date(),
): IndustryWeeklyAcceptance {
  ensureIndustryWeeklySchema(db);
  const counts = new Map<string, number>();
  const rows = db.prepare(`
    SELECT promoted_at FROM industry_update
    WHERE industry_id=? AND promoted_to_event_id IS NOT NULL AND promoted_at IS NOT NULL
  `).all(industryId) as Array<{ promoted_at: string }>;
  for (const row of rows) {
    const week = weekOfTimestamp(row.promoted_at);
    if (week) counts.set(week, (counts.get(week) ?? 0) + 1);
  }

  const currentWeek = mondayOfDateKey(dateKeyInShanghai(now));
  const earliestWeek = [...counts.keys()].sort()[0] ?? currentWeek;
  let streak = 0;
  let maxConsecutiveWeeks = 0;
  let acceptedAtWeek: string | null = null;
  for (let week = earliestWeek; week <= currentWeek; week = shiftDateKey(week, 7)) {
    if ((counts.get(week) ?? 0) >= ACCEPTANCE_SELECTIONS_PER_WEEK) {
      streak += 1;
      if (streak > maxConsecutiveWeeks) maxConsecutiveWeeks = streak;
      if (!acceptedAtWeek && streak >= ACCEPTANCE_WEEKS) acceptedAtWeek = week;
    } else {
      streak = 0;
    }
  }

  const recentWeeks = Array.from({ length: ACCEPTANCE_WEEKS }, (_, index) => {
    const from = shiftDateKey(currentWeek, (index - ACCEPTANCE_WEEKS + 1) * 7);
    const selected = counts.get(from) ?? 0;
    return {
      from,
      to: shiftDateKey(from, 6),
      selected,
      passed: selected >= ACCEPTANCE_SELECTIONS_PER_WEEK,
      current: from === currentWeek,
    };
  });

  return {
    accepted: acceptedAtWeek !== null,
    acceptedAtWeek,
    maxConsecutiveWeeks,
    requiredWeeks: ACCEPTANCE_WEEKS,
    requiredSelectionsPerWeek: ACCEPTANCE_SELECTIONS_PER_WEEK,
    recentWeeks,
  };
}

function pointer(value: unknown): EvidencePointer {
  if (typeof value !== "object" || value === null || !("sourceId" in value) || !("excerpt" in value)) throw new Error("行业周报字段缺少来源");
  const candidate = value as Partial<EvidencePointer>;
  if (typeof candidate.sourceId !== "string" || typeof candidate.excerpt !== "string") throw new Error("行业周报字段来源格式无效");
  return candidate as EvidencePointer;
}

export function ingestIndustryWeekly(db: DossierDatabase, collection: IndustryWeeklyCollection): { inserted: number; existing: number } {
  ensureIndustryWeeklySchema(db);
  const sourceIds = new Set(collection.sources.map(source => source.id));
  for (const item of collection.updates) {
    for (const field of ["industry_id", "found_at", "kind", ...(item.record.companyId ? ["company_id"] : []), "summary"]) {
      const evidence = pointer(item.evidence[field]);
      if (!sourceIds.has(evidence.sourceId) || !evidence.excerpt.trim()) throw new Error(`industry_update.${field} 来源无效`);
    }
  }
  return db.transaction(() => {
    for (const source of collection.sources) {
      db.prepare(`INSERT INTO source (id, url, type, published_at, fingerprint, page_or_excerpt) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET page_or_excerpt=excluded.page_or_excerpt`)
        .run(source.id, source.url, source.type, source.publishedAt, source.fingerprint, source.pageOrExcerpt);
    }
    let inserted = 0;
    let existing = 0;
    for (const item of collection.updates) {
      const row = item.record;
      if (row.companyId) {
        const company = db.prepare("SELECT industry_id FROM company WHERE id=?").get(row.companyId) as { industry_id: string | null } | undefined;
        if (!company || company.industry_id !== row.industryId) {
          throw new Error(`行业周报目标客户不属于该行业：${row.companyId}`);
        }
      }
      const result = db.prepare(`
        INSERT INTO industry_update (id, industry_id, found_at, kind, company_id, summary, promoted_to_event_id)
        VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO NOTHING
      `).run(row.id, row.industryId, row.foundAt, row.kind, row.companyId || null, row.summary);
      if (result.changes) inserted += 1; else existing += 1;
      for (const field of ["industry_id", "found_at", "kind", ...(row.companyId ? ["company_id"] : []), "summary"]) {
        const evidence = pointer(item.evidence[field]);
        db.prepare(`INSERT INTO fact VALUES (?, ?, 'industry_update', ?, ?)
          ON CONFLICT(source_id, "table", row_id, field) DO NOTHING`)
          .run(stableId("fact", evidence.sourceId, "industry_update", row.id, field), evidence.sourceId, row.id, field);
      }
    }
    return { inserted, existing };
  })();
}

export function promoteIndustryUpdateToEvent(
  db: DossierDatabase,
  updateId: string,
  companyId?: string,
  promotedAt = new Date().toISOString(),
): string {
  ensureIndustryWeeklySchema(db);
  if (Number.isNaN(new Date(promotedAt).getTime())) throw new Error("选择时间格式无效");
  return db.transaction(() => {
    const update = db.prepare("SELECT * FROM industry_update WHERE id=?").get(updateId) as {
      id:string; industry_id:string; company_id:string|null; found_at:string; kind:string; summary:string;
      promoted_to_event_id:string|null; promoted_at:string|null;
    } | undefined;
    if (!update) throw new Error(`找不到行业周报条目：${updateId}`);
    if (update.promoted_to_event_id) {
      if (!update.promoted_at) {
        db.prepare("UPDATE industry_update SET promoted_at=? WHERE id=?").run(promotedAt, update.id);
      }
      return update.promoted_to_event_id;
    }
    const targetCompanyId = companyId || update.company_id;
    if (!targetCompanyId) throw new Error("写入 Event 前必须选择客户");
    const company = db.prepare("SELECT industry_id FROM company WHERE id=?").get(targetCompanyId) as { industry_id: string | null } | undefined;
    if (!company) throw new Error(`找不到客户：${targetCompanyId}`);
    if (company.industry_id !== update.industry_id) throw new Error("只能把行业周报条目写入同行业客户");
    const eventId = stableId("event", targetCompanyId, update.found_at, update.summary);
    const eventKind = update.kind === "procurement" ? "procurement" : update.kind === "target_action" ? "strategy" : "statement";
    db.prepare(`INSERT INTO event VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET summary=excluded.summary`).run(eventId, targetCompanyId, update.found_at, eventKind, update.summary);
    const sources = db.prepare(`SELECT DISTINCT source_id FROM fact WHERE "table"='industry_update' AND row_id=?`).all(update.id) as Array<{source_id:string}>;
    for (const source of sources) {
      for (const field of ["company_id", "occurred_at", "kind", "summary"]) {
        db.prepare(`INSERT INTO fact VALUES (?, ?, 'event', ?, ?)
          ON CONFLICT(source_id, "table", row_id, field) DO NOTHING`)
          .run(stableId("fact", source.source_id, "event", eventId, field), source.source_id, eventId, field);
      }
    }
    db.prepare("UPDATE industry_update SET promoted_to_event_id=?, promoted_at=? WHERE id=?")
      .run(eventId, promotedAt, update.id);
    return eventId;
  })();
}
