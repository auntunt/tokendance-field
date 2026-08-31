import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { renderIndustryWeeklyHtml } from "@/lib/dossier/industry-weekly-html";
import { ensureIndustryWeeklySchema } from "@/lib/dossier/m6-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validDate(value: string | null, fallback: string): string {
  return value && /^20\d{2}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ industryId: string }> },
): Promise<Response> {
  const { industryId: encodedIndustryId } = await context.params;
  const industryId = decodeURIComponent(encodedIndustryId);
  const now = new Date();
  const defaultTo = now.toISOString().slice(0, 10);
  now.setUTCDate(now.getUTCDate() - 6);
  const url = new URL(request.url);
  const from = validDate(url.searchParams.get("from"), now.toISOString().slice(0, 10));
  const to = validDate(url.searchParams.get("to"), defaultTo);
  const databasePath = resolve(process.env.DOSSIER_DB_PATH ?? "data/dossier.db");
  if (!existsSync(databasePath)) return Response.json({ error: "档案数据库尚未生成" }, { status: 503 });
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    ensureIndustryWeeklySchema(db);
    return new Response(renderIndustryWeeklyHtml(db, industryId, from, to), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: "行业周报生成失败", message }, { status: 404 });
  } finally {
    db.close();
  }
}
