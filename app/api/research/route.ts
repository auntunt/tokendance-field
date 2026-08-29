export const dynamic = "force-dynamic";

import { ensureWorkspaceSchema, getDb } from "../../../db";
import { getResearchProviderStatus } from "../../../lib/research/provider";
import { researchOverview } from "../../../lib/research/repository";

export async function GET() {
  try {
    ensureWorkspaceSchema();
    return Response.json({
      providers: getResearchProviderStatus(),
      ...researchOverview(getDb()),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "研究记忆读取失败" }, { status: 500 });
  }
}
