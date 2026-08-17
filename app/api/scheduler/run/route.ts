import { runSchedulerBatch, schedulerStatus } from "../../../../lib/scheduler";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(6, Number(url.searchParams.get("limit")) || 3));
  void runSchedulerBatch(limit);
  return Response.json({ started: true, limit, status: schedulerStatus() });
}
