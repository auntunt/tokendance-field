// 防止策略文件和定时器“各自存在但没有接上”。这里锁住启动、入库预演和配置三条线。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = path => readFile(new URL(path, import.meta.url), "utf8");

test("服务启动时按环境变量拉起定时补数", async () => {
  const instrumentation = await source("../instrumentation.ts");
  assert.match(instrumentation, /startScheduler/);
  assert.match(instrumentation, /FDE_SCHEDULER_INTERVAL_HOURS/);
});

test("调度器写入前必须经过质量筛选，但不得删除过期信号", async () => {
  const scheduler = await source("../lib/scheduler.ts");
  assert.match(scheduler, /selectSchedulerCandidates\(candidates, signals/);
  assert.doesNotMatch(scheduler, /pruneExpiredSchedulerSignals|cleanup\.pruned/);
  assert.match(scheduler, /setInterval/);
});

test("默认配置同时限制每批信号、每批关系和整图关系数", async () => {
  const env = await source("../.env.example");
  assert.match(env, /FDE_SCHEDULER_ENABLED=true/);
  assert.match(env, /FDE_SCHEDULER_INTERVAL_HOURS=6/);
  assert.match(env, /FDE_SCHEDULER_MAX_ADDED_SIGNALS=4/);
  assert.match(env, /FDE_SCHEDULER_MAX_ADDED_EDGES=6/);
  assert.match(env, /FDE_SCHEDULER_MAX_GRAPH_EDGES=48/);
});
