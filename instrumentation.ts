// Next.js 服务启动时拉起 FDE 查询包调度器。
// 只在 Node.js 运行时启用，构建期和 Edge 不启动。
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("./lib/scheduler");
    startScheduler(Number(process.env.FDE_SCHEDULER_INTERVAL_HOURS) || 6);
  }
}
