import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promoteIndustryUpdateToEvent } from "@/lib/dossier/m6-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const data = await request.formData();
  const updateId = String(data.get("updateId") ?? "").trim();
  const companyId = String(data.get("companyId") ?? "").trim() || undefined;
  const returnTo = String(data.get("returnTo") ?? "/");
  if (!updateId) return Response.json({ error: "缺少周报条目" }, { status: 400 });
  const databasePath = resolve(/* turbopackIgnore: true */ process.env.DOSSIER_DB_PATH ?? "data/dossier.db");
  if (!existsSync(/* turbopackIgnore: true */ databasePath)) return Response.json({ error: "档案数据库尚未生成" }, { status: 503 });
  const db = new Database(databasePath);
  try {
    promoteIndustryUpdateToEvent(db, updateId, companyId);
    const target = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
    return Response.redirect(new URL(target, request.url), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: "写入 Event 失败", message }, { status: 400 });
  } finally {
    db.close();
  }
}
