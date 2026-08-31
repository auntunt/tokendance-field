import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { generateDossier } from "@/lib/dossier/generate";

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
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    const exists = db.prepare("SELECT 1 FROM company WHERE id=?").get(companyId);
    if (!exists) return Response.json({ error: "找不到客户", companyId }, { status: 404 });
    const dossier = generateDossier(db, companyId);
    return new Response(dossier.html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: "档案生成失败", message }, { status: 500 });
  } finally {
    db.close();
  }
}
