import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { renderDossierHtml } from "@/lib/dossier/html";
import { captureDossierSnapshot, diffDossierSnapshots, type DossierSnapshot } from "@/lib/dossier/snapshot";
import { generateEntryPrep } from "@/lib/generate/entry-prep";
import { generateOpportunities } from "@/lib/generate/opportunities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ companyId: string }> },
): Promise<Response> {
  const { companyId: encodedCompanyId } = await context.params;
  const companyId = decodeURIComponent(encodedCompanyId);
  const databasePath = resolve(process.env.DOSSIER_DB_PATH ?? "data/dossier.db");
  if (!existsSync(databasePath)) {
    return Response.json({ error: "档案数据库尚未生成", databasePath }, { status: 503 });
  }
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const exists = db.prepare("SELECT 1 FROM company WHERE id=?").get(companyId);
    if (!exists) return Response.json({ error: "找不到客户", companyId }, { status: 404 });
    const opportunities = generateOpportunities(db, companyId);
    const prep = generateEntryPrep(db, companyId, opportunities);
    const previous = db.prepare(`
      SELECT snapshot FROM dossier_run WHERE company_id=? ORDER BY ran_at DESC, id DESC LIMIT 1
    `).get(companyId) as { snapshot: string } | undefined;
    const current = captureDossierSnapshot(db, companyId);
    const changes = diffDossierSnapshots(
      previous ? JSON.parse(previous.snapshot) as DossierSnapshot : null,
      current,
    );
    return new Response(renderDossierHtml(db, companyId, opportunities, prep, changes), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: "档案生成失败", message }, { status: 500 });
  } finally {
    db.close();
  }
}
