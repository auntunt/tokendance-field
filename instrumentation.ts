// M6 只允许 Vercel Cron 每周按行业生成周报。
// 旧的按公司调度器保留在原模块中，但生产服务不再自动导入或启动它。
export async function register() {
  return Promise.resolve();
}
