// 防止策略文件和定时器“各自存在但没有接上”。这里锁住启动、入库预演和配置三条线。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = path => readFile(new URL(path, import.meta.url), "utf8");

test("服务启动时绝不拉起旧的按公司定时补数", async () => {
  const instrumentation = await source("../instrumentation.ts");
  assert.doesNotMatch(instrumentation, /import\("\.\/lib\/scheduler"\)/);
  assert.doesNotMatch(instrumentation, /startScheduler\(/);
  assert.match(instrumentation, /不再自动导入或启动/);
});

test("调度器写入前必须经过质量筛选，但不得删除过期信号", async () => {
  const scheduler = await source("../lib/scheduler.ts");
  assert.match(scheduler, /selectSchedulerCandidates\(candidates, signals/);
  assert.doesNotMatch(scheduler, /pruneExpiredSchedulerSignals|cleanup\.pruned/);
  assert.match(scheduler, /setInterval/);
});

test("旧按公司调度器默认关闭，保留的手动模块仍有容量限制", async () => {
  const env = await source("../.env.example");
  assert.match(env, /FDE_SCHEDULER_ENABLED=false/);
  assert.match(env, /FDE_SCHEDULER_INTERVAL_HOURS=6/);
  assert.match(env, /FDE_SCHEDULER_MAX_ADDED_SIGNALS=4/);
  assert.match(env, /FDE_SCHEDULER_MAX_ADDED_EDGES=6/);
  assert.match(env, /FDE_SCHEDULER_MAX_GRAPH_EDGES=48/);
});

test("Docker 生产环境只由 GitHub Actions 每周触发一次行业周报", async () => {
  const workflow = await source("../.github/workflows/industry-weekly.yml");
  assert.match(workflow, /cron: ["']0 1 \* \* 1["']/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /\/api\/cron\/industry-weekly/);
  assert.match(workflow, /Authorization: Bearer \$\{FIELD_CRON_SECRET\}/);
  assert.doesNotMatch(workflow, /scheduler\/run|FDE_SCHEDULER/);
});

test("Pull Request 跑关键检查，完整回归与生产镜像只在主分支或手动运行", async () => {
  const workflow = await source("../.github/workflows/ci.yml");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm audit --audit-level=high/);
  assert.match(workflow, /npm run production:check/);
  assert.match(workflow, /full-regression:[\s\S]*github\.event_name == 'push'[\s\S]*npm run test:full/);
  assert.match(workflow, /production-image:[\s\S]*github\.event_name == 'push'/);
  assert.match(workflow, /Dockerfile\.prod/);
  assert.match(workflow, /platforms: linux\/amd64/);
});
