import { stableId } from "./id";
import type { DossierDatabase, IngestResult } from "./repository";
import type { EvidencePointer, RelationshipCollection } from "./types";

export function ingestRelationshipCollection(db: DossierDatabase, collection: RelationshipCollection): IngestResult {
  const validate = (item: string | EvidencePointer | undefined, field: string) => {
    if (typeof item !== "object" || item.sourceId !== collection.source.id || !item.excerpt.trim()) {
      throw new Error(`relationship.${field} 缺少来源摘录`);
    }
  };
  for (const item of collection.relationships) {
    validate(item.evidence.company_id, "company_id");
    validate(item.evidence.counterparty, "counterparty");
    validate(item.evidence.kind, "kind");
  }
  return db.transaction(() => {
    const company = db.prepare("SELECT 1 FROM company WHERE id=?").get(collection.company.record.id);
    if (!company) throw new Error(`写入同行或厂商关系前必须先建档客户：${collection.company.record.id}`);
    db.prepare(`INSERT INTO source (id, url, type, published_at, fingerprint, page_or_excerpt) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET page_or_excerpt=excluded.page_or_excerpt`)
      .run(collection.source.id, collection.source.url, collection.source.type, collection.source.publishedAt,
        collection.source.fingerprint, collection.source.pageOrExcerpt);
    let facts = 0;
    for (const item of collection.relationships) {
      const row = item.record;
      db.prepare(`
        INSERT INTO relationship (id, company_id, counterparty, kind, amount, period_start, period_end)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET counterparty=excluded.counterparty, kind=excluded.kind,
          amount=excluded.amount, period_start=excluded.period_start, period_end=excluded.period_end
      `).run(row.id, row.companyId, row.counterparty, row.kind, row.amount, row.periodStart || null, row.periodEnd || null);
      for (const field of ["company_id", "counterparty", "kind"]) {
        db.prepare(`INSERT INTO fact VALUES (?, ?, 'relationship', ?, ?)
          ON CONFLICT(source_id, "table", row_id, field) DO NOTHING`)
          .run(stableId("fact", collection.source.id, "relationship", row.id, field), collection.source.id, row.id, field);
        facts += 1;
      }
    }
    return { sourceId: collection.source.id, companyId: collection.company.record.id, jobPostings: 0, orgUnits: 0, systems: 0, facts };
  })();
}
