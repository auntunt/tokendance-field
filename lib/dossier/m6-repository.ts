import { stableId } from "./id";
import type { DossierDatabase } from "./repository";
import type { EvidencePointer, IndustryWeeklyCollection } from "./types";

function pointer(value: unknown): EvidencePointer {
  if (typeof value !== "object" || value === null || !("sourceId" in value) || !("excerpt" in value)) throw new Error("行业周报字段缺少来源");
  const candidate = value as Partial<EvidencePointer>;
  if (typeof candidate.sourceId !== "string" || typeof candidate.excerpt !== "string") throw new Error("行业周报字段来源格式无效");
  return candidate as EvidencePointer;
}

export function ingestIndustryWeekly(db: DossierDatabase, collection: IndustryWeeklyCollection): { inserted: number; existing: number } {
  const sourceIds = new Set(collection.sources.map(source => source.id));
  for (const item of collection.updates) {
    for (const field of ["industry_id", "found_at", "kind", "summary"]) {
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

export function promoteIndustryUpdateToEvent(db: DossierDatabase, updateId: string, companyId?: string): string {
  return db.transaction(() => {
    const update = db.prepare("SELECT * FROM industry_update WHERE id=?").get(updateId) as {
      id:string; company_id:string|null; found_at:string; kind:string; summary:string; promoted_to_event_id:string|null;
    } | undefined;
    if (!update) throw new Error(`找不到行业周报条目：${updateId}`);
    if (update.promoted_to_event_id) return update.promoted_to_event_id;
    const targetCompanyId = companyId || update.company_id;
    if (!targetCompanyId) throw new Error("写入 Event 前必须选择客户");
    const company = db.prepare("SELECT 1 FROM company WHERE id=?").get(targetCompanyId);
    if (!company) throw new Error(`找不到客户：${targetCompanyId}`);
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
    db.prepare("UPDATE industry_update SET promoted_to_event_id=? WHERE id=?").run(eventId, update.id);
    return eventId;
  })();
}
