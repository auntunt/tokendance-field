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
