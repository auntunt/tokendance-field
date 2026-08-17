// 查询任务轮询端点。POST /api/query 创建任务后立刻返回 jobId，
// 前端每 2–3 秒轮询一次；单次响应很短，不会被任何反向代理超时杀掉。
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id")?.trim();
  if (!id) return Response.json({ error: "缺少任务 id" }, { status: 400 });

  const jobs = globalThis.tokendanceQueryJobs;
  const job = jobs?.get(id);
  if (!job) return Response.json({ error: "任务不存在或已过期，请重新查询" }, { status: 404 });

  return Response.json({
    id: job.id,
    status: job.status,
    progressText: job.progressText,
    currentQuery: job.currentQuery,
    completedTasks: job.completedTasks,
    totalTasks: job.totalTasks,
    urlsFetched: job.urlsFetched,
    elapsedSeconds: Math.max(0, Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000)),
    result: job.result,
    error: job.error,
  });
}
