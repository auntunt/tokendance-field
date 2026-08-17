import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = path => readFile(new URL(path, import.meta.url), "utf8");

test("preserves the TokenDance Field judgment gates", async () => {
  // 门的定义已从 signal-console.tsx 拆到 lib/field-core.ts（换本体不许碰的那一半）。
  // 行为断言在 tests/discipline.test.mjs；这里只守住"门还在内核里、不在 UI 里"。
  const kernel = await source("../lib/field-core.ts");
  for (const gate of ["原始证据", "本地边界", "认识状态", "证伪 / 反例", "来源 / 时效", "专家签署"]) assert.ok(kernel.includes(gate), `missing ${gate}`);
  assert.match(kernel, /executable: states\.every\(Boolean\)/);
  assert.match(kernel, /执行质量不足，不归因/);
  const consoleSource = await source("../app/signal-console.tsx");
  assert.match(consoleSource, /gate\.executable/);
});

test("model output can never sign off a judgment", async () => {
  // 模型是批评者，不是签署人：采纳建议必须强制清空签署。
  const consoleSource = await source("../app/signal-console.tsx");
  const adopt = consoleSource.slice(consoleSource.indexOf("function adoptModelAnalysis"));
  assert.match(adopt, /signedOff: false/);
  const panel = await source("../app/console/constraint-panel.tsx");
  assert.match(panel, /signedOff: false/);
});

test("pipeline writes are quarantined as hypothesis + related", async () => {
  const consoleSource = await source("../app/signal-console.tsx");
  const accept = consoleSource.slice(consoleSource.indexOf("function acceptCandidates"));
  assert.match(accept, /epistemicState: "hypothesis"/);
  assert.match(accept, /sourceType: "related"/);
  assert.match(accept, /origin: candidate\.origin \|\| "pipeline"/);
  // 抽取器自己不许填约束门字段——抽取逻辑现在在 lib/extractor.ts。
  const extract = await source("../lib/extractor.ts");
  assert.doesNotMatch(extract, /signedOff|validUntil|falsifier/);
  const route = await source("../app/api/extract/route.ts");
  assert.doesNotMatch(route, /signedOff|validUntil|falsifier/);
});

test("collector refuses internal addresses and non-http schemes", async () => {
  // SSRF：采集器接受用户给的 URL，必须挡住内网和 file://。
  const collect = await source("../app/api/collect/route.ts");
  assert.match(collect, /function ssrfGuard/);
  assert.match(collect, /只允许 http\/https 协议/);
  assert.match(collect, /不允许请求内部地址/);
  // 直接查源码里的字面量，别再套一层正则转义——私有段写的是 `127\.` 这种形式。
  for (const segment of ["127\\.", "10\\.", "192\\.168\\.", "169\\.254\\.", "::1", "172\\."]) {
    assert.ok(collect.includes(segment), `PRIVATE_IP 缺少 ${segment}`);
  }
  assert.match(collect, /host === "localhost"/);
  // 抓取要有大小和时间上限，不能被一个巨型页面拖死。
  assert.match(collect, /MAX_BYTES/);
  assert.match(collect, /setTimeout\(\(\) => controller\.abort\(\)/);
});

test("collector deduplicates by canonical url and logs every attempt", async () => {
  const collect = await source("../app/api/collect/route.ts");
  assert.match(collect, /CREATE TABLE IF NOT EXISTS collection_log/);
  assert.match(collect, /url_hash/);
  assert.match(collect, /status='ok'/);
  assert.match(collect, /duplicate: true/);
  // 失败也要落日志，否则重试时看不出是哪一步断的。
  assert.match(collect, /"error", msg\.slice/);
  // 采集器同样不许碰约束门。
  assert.doesNotMatch(collect, /signedOff|validUntil|falsifier/);
});

test("sandbox output is permanently tagged as simulation, server-side", async () => {
  // Phase 5 的全部纪律就这一条：推演不能自己变成情报。
  const simulate = await source("../app/api/simulate/route.ts");
  assert.match(simulate, /origin: "simulation" as const/);
  assert.match(simulate, /\[推演\]/);
  assert.match(simulate, /mode: "simulate"/);
  // 打标在服务端，不信任前端也不信任模型。
  assert.match(simulate, /服务端强制打标/);
  assert.doesNotMatch(simulate, /signedOff|validUntil|falsifier/);
  // 推演走的仍是同一个隔离路径：hypothesis + related。
  // 断言查的是"沙盘挂在 acceptCandidates 上"，不是它在导航里叫什么——
  // 之前绑的是 view === "沙盘推演" 这个字面量，改个菜单名就假报警，而纪律根本没动。
  const consoleSource = await source("../app/signal-console.tsx");
  assert.match(consoleSource, /<Sandbox onAccept=\{acceptCandidates\} \/>/);
});

test("版图不许把「没查过」画成「没有关系」", async () => {
  // 这张热力图唯一会撒的谎就是这个：把没查过的格子涂成和"查过没有"一样的冷色，
  // 于是一张几乎全空的图看起来像一份结论。三态必须是三种画法，
  // 且图例第一行就得把空格子的含义写明。
  const view = await source("../app/console/market-map.tsx");
  assert.match(view, /没查过（不是「没有关系」）/);
  // unchecked 的格子留空，不写 0——写 0 等于宣称"查过，结果是零"。
  assert.match(view, /if \(cell\.state === "unchecked"\) return "";/);
  assert.match(view, /disabled=\{cell\.state === "unchecked"\}/);

  // 热度的定义留在内核侧，且只数独立第三方来源的去重材料。
  // 行为断言在 tests/market-map.test.mjs，这里只守住"定义没有溜进 UI"。
  const map = await source("../lib/market-map.ts");
  assert.match(map, /sourceType === "independent"/);
  assert.match(map, /distinctMaterials\(independent\)/);

  // 归一化必须和后端判重共用一份。两份规则一旦分叉，
  // 前端会说"两个来源"而后端说"同一份转载"，且两边都自称事实。
  assert.match(map, /from "\.\/normalize-text"/);
  const dedup = await source("../lib/dedup.ts");
  assert.match(dedup, /export \{ normalizeCorpus \} from "\.\/normalize-text"/);
  assert.doesNotMatch(dedup, /CJK_ADJACENT_SPACE = new RegExp/, "判重层不许再抄一份归一化规则");

  // 版图是"把已入库情报换个看法"，不是新的一道门。
  assert.doesNotMatch(map, /signedOff:\s*true/);
  assert.doesNotMatch(view, /signedOff/);
  // 口径不同的数字不许合计。
  assert.match(view, /这里不合计/);
});

test("relation edges and origin survive a reload", async () => {
  const [database, workspace] = await Promise.all([source("../db/index.ts"), source("../app/api/workspace/route.ts")]);
  assert.match(database, /edges_json/);
  assert.match(database, /ADD COLUMN edges_json/);
  assert.match(database, /ADD COLUMN origin/);
  assert.match(workspace, /edges_json,origin/);
  assert.match(workspace, /edges: safeJson\(row\.edges_json/);
});

test("人际出处与人物名册活过重载", async () => {
  // humanSource 参与门 5 判定，丢了会让已过闸的私有情报无声退回。
  const [database, workspace] = await Promise.all([source("../db/index.ts"), source("../app/api/workspace/route.ts")]);
  assert.match(database, /ADD COLUMN human_source/);
  assert.match(workspace, /human_source/);
  assert.match(workspace, /humanSource: constraint\.human_source/);
  // 名册是独立表：人物是事实清单，不混进过闸的情报里。
  assert.match(database, /CREATE TABLE IF NOT EXISTS person_records/);
  assert.match(workspace, /INSERT INTO person_records/);
  assert.match(workspace, /people: personRows\.map/);
  // 名册字段必须与 PII 白名单一致——多一个承载私生活的列都不行。
  const schema = database.slice(database.indexOf("person_records"), database.indexOf("person_records") + 400);
  for (const banned of ["phone", "address", "wechat", "family", "birthday", "salary"]) {
    assert.doesNotMatch(schema, new RegExp(banned, "i"), `person_records 不得有 ${banned} 列`);
  }
});

test("self-host build is private and persists all state in SQLite", async () => {
  const [database, workspace, proxy, compose, dockerfile] = await Promise.all([
    source("../db/index.ts"), source("../app/api/workspace/route.ts"), source("../proxy.ts"), source("../docker-compose.prod.yml"), source("../Dockerfile.prod"),
  ]);
  for (const table of ["workspaces", "evidence_records", "feedback_records", "judgment_constraints", "outcome_evaluations", "snapshots"]) assert.match(database, new RegExp(table));
  assert.match(database, /journal_mode = WAL/);
  assert.match(workspace, /db\.transaction/);
  assert.match(proxy, /FIELD_ACCESS_PASSWORD/);
  assert.match(compose, /127\.0\.0\.1:8021:8800/);
  assert.match(compose, /tokendance_field_data/);
  assert.match(dockerfile, /node:22-bookworm-slim/);
});

test("model credentials can be supplied per session or by server environment", async () => {
  const analyze = await source("../app/api/analyze/route.ts");
  assert.match(analyze, /body\.apiKey/);
  assert.match(analyze, /process\.env/);
  assert.match(analyze, /store: false/);
});

test("analyze reports why it failed instead of a bare 500", async () => {
  // 回归：推理类模型要 30s 以上，之前没有超时也没有分层错误，
  // 连接被掐断只得到一个没信息的 500，看起来像是密钥或网关坏了。
  const analyze = await source("../app/api/analyze/route.ts");
  assert.match(analyze, /AbortSignal\.timeout/);
  assert.match(analyze, /ANALYZE_TIMEOUT_MS/);
  // 三条 fetch 分支都要挂上超时信号，漏一条就等于没设。
  assert.equal(analyze.match(/signal: abort/g)?.length, 3, "三个 provider 分支都要带 signal");
  assert.match(analyze, /TimeoutError/);
  assert.match(analyze, /status: 504/);
  // 解析失败要分层报 502 并带上游原文，不能笼统 500。
  assert.match(analyze, /模型服务返回的不是 JSON/);
  assert.match(analyze, /模型返回了空正文/);
  assert.match(analyze, /模型正文里没有可读取的 JSON/);
  // 推理模型把正文放 reasoning_content，要兜住。
  assert.match(analyze, /reasoning_content/);
  // 批评器仍然不许签署。
  assert.doesNotMatch(analyze, /signedOff/);
});
