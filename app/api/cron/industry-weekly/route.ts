import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fetchIndustryWeeklyFeed } from "@/lib/collectors/industry-weekly";
import { ingestIndustryWeekly } from "@/lib/dossier/m6-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function weekRange(now = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const fromDate = new Date(now);
  fromDate.setUTCDate(fromDate.getUTCDate() - 6);
  return { from: fromDate.toISOString().slice(0, 10), to };
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "未授权" }, { status: 401 });
  }
  const industryId = process.env.INDUSTRY_WEEKLY_INDUSTRY_ID?.trim();
  const feedUrls = (process.env.INDUSTRY_WEEKLY_FEED_URLS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!industryId || feedUrls.length === 0) {
    return Response.json({ error: "缺少行业周报配置" }, { status: 503 });
  }
  const databasePath = resolve(process.env.DOSSIER_DB_PATH ?? "data/dossier.db");
  if (!existsSync(databasePath)) {
    return Response.json({ error: "档案数据库尚未生成", databasePath }, { status: 503 });
  }
  const db = new Database(databasePath);
  try {
    const industry = db.prepare("SELECT 1 FROM industry WHERE id=?").get(industryId);
    if (!industry) return Response.json({ error: "找不到已建档行业", industryId }, { status: 409 });
    let inserted = 0;
    let existing = 0;
    for (const feedUrl of feedUrls) {
      const result = ingestIndustryWeekly(db, await fetchIndustryWeeklyFeed(industryId, feedUrl));
      inserted += result.inserted;
      existing += result.existing;
    }
    const range = weekRange();
    return Response.json({
      ok: true,
      industryId,
      sources: feedUrls.length,
      inserted,
      existing,
      reportUrl: `/industry-weekly/${encodeURIComponent(industryId)}?from=${range.from}&to=${range.to}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: "行业周报生成失败", message }, { status: 502 });
  } finally {
    db.close();
  }
}
