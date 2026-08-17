// FDE 当前查询包。数据持久化在 SQLite：初始种子来自 lib/fde-company-index.json，
// 定时调度器每次查询后写回 last_searched_at / candidates_count / latest_candidates。
export const dynamic = "force-dynamic";

import { getDb, ensureWorkspaceSchema } from "../../../../db";
import { listFdePresets } from "../../../../lib/fde-presets";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope") || "focus";
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 50));
    const q = url.searchParams.get("q") || "";

    ensureWorkspaceSchema();
    const db = getDb();
    const data = listFdePresets(db, scope, limit, q);

    return Response.json({
      generatedAt: data.generatedAt,
      source: "reports/history（初始冻结）+ SQLite 调度更新",
      scope,
      total: data.total,
      returned: data.presets.length,
      presets: data.presets.map(item => ({
        id: item.id,
        name: item.name,
        legalName: item.legalName,
        ticker: item.ticker,
        listing: item.listing,
        city: item.city,
        sector: item.sector,
        relevance: item.relevance,
        watchlist: item.watchlist,
        hasFdeFacts: item.hasFdeFacts,
        query: item.query,
        dimensions: item.dimensions,
        updatedAt: item.updatedAt,
        lastSearchedAt: item.lastSearchedAt,
        candidatesCount: item.candidatesCount,
        latestCandidates: item.latestCandidates,
        status: item.status,
      })),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "查询包读取失败" }, { status: 500 });
  }
}
