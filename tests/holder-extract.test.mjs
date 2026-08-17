// 股东抽取层的测试。语料是东方财富接口真实返回的响应体
// （tests/fixtures/eastmoney-holders-301236.json，100 行 = 10 个报告期 × 10 名股东），
// 不是我编的样例——编的数据只能证明代码匹配自己写的字符串。
//
// 这里守的是五件事，坏掉任何一件报告就不可信了：
//   1. 定级只能是 independent。这是东方财富的二手结构化数据，不是法定披露原文，
//      标成 statutory 等于把别人加工过的数字当成公告原文，是本项目最严重的错。
//   2. 每条事实都带能回接口响应里 grep 到的 quote，且 quote 里能看出报告期和接口名。
//   3. 口径写进 value：名单是「十大流通股东」不是「十大股东」，
//      比例是 HOLD_RATIO＝占总股本不是占流通股。项目已因口径标错出过三次事故。
//   4. 报告期只取最新一期。不分组的话 100 行里有 10 个 HOLDER_RANK=1，
//      看起来像十个并列第一大股东，实际是十个季度混在一起——这是真踩过的坑。
//   5. 同输入同输出，否则定期重跑的「变更页」会满是假变更。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, ".report-build");
execFileSync(resolve(root, "node_modules/.bin/tsc"), [
  "lib/fde-dimensions.ts", "lib/holder-sources.ts", "lib/holder-extract.ts", "lib/filing-merge.ts",
  "--outDir", ".report-build", "--module", "commonjs", "--moduleResolution", "node10",
  "--target", "es2022", "--strict", "--skipLibCheck",
], { cwd: root, stdio: "inherit" });
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "package.json"), '{"type":"commonjs"}');
const require = createRequire(import.meta.url);
const sources = require(`${outDir}/holder-sources.js`);
const holders = require(`${outDir}/holder-extract.js`);
const merge = require(`${outDir}/filing-merge.js`);

const RAW = JSON.parse(readFileSync(resolve(root, "tests/fixtures/eastmoney-holders-301236.json"), "utf8"));
const ROWS = sources.rowsOfResponse(RAW);
const SECU = "301236.SZ";
const facts = holders.extractHolderFacts(ROWS, SECU);
const get = key => facts.find(item => item.key === key);

test("真实响应体里就是 100 行、10 个报告期混在一起", () => {
  // 这条不是测代码，是把坑钉在测试里：将来有人看到 100 行以为是 100 名股东时，
  // 这条测试的存在能告诉他为什么必须按 END_DATE 分组。
  assert.equal(ROWS.length, 100);
  const dates = new Set(ROWS.map(row => holders.dateOf(row)));
  assert.equal(dates.size, 10);
  const rank1 = ROWS.filter(row => Number(row.HOLDER_RANK) === 1);
  assert.equal(rank1.length, 10, "十个报告期各有一个 rank 1，直接遍历会看成十个第一大股东");
});

test("只取最新报告期，且该期名次 1..10 唯一", () => {
  const period = holders.latestPeriod(ROWS);
  assert.equal(period.endDate, "2026-07-07");
  assert.equal(period.rows.length, 10);
  const ranks = period.rows.map(row => Number(row.HOLDER_RANK));
  assert.deepEqual(ranks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "必须按名次排好且不重号");
});

test("名次与持股比例一一对应：第 2 名是刘天文 5.018%", () => {
  // 这是用户在接口上人工核对过的锚点。名次和比例错位是这类表最典型的坏法
  // （年报 PDF 路线就是因为行列错位才整块放弃的），所以钉一个已知值。
  const period = holders.latestPeriod(ROWS);
  const second = period.rows[1];
  assert.equal(second.HOLDER_NAME, "刘天文");
  assert.equal(String(second.HOLD_RATIO), "5.018");
  assert.match(get("majorHolders").value, /2\. 刘天文 5\.018%/);
});

test("定级是 independent，绝不是 statutory", () => {
  for (const item of facts) {
    const sourced = holders.toSourced(item, "东方财富 F10", "https://example.test/x", "2026-08-09");
    assert.equal(sourced.grade, "independent",
      "东方财富是二手结构化数据，不是巨潮/SEC 原文，不能按法定披露记");
    assert.notEqual(sourced.grade, "statutory");
  }
});

test("每条事实都有 quote，且 quote 能定位到报告期和接口", () => {
  // 两条：majorHolders（名单+集中度）与 institutional（机构席位）。
  // 曾经是三条，capTable 被去掉了——接口给不出「股权结构变动」，见 holder-extract 的注释。
  assert.ok(facts.length >= 2, "至少要抽出名单和机构持仓两条");
  for (const item of facts) {
    assert.ok(item.quote.trim().length > 0, `${item.key} 缺 quote —— 没 quote 就不该是事实`);
    assert.match(item.quote, /RPT_F10_EH_FREEHOLDERS/, `${item.key} 的 quote 没写清来自哪个接口`);
    assert.match(item.quote, /END_DATE=2026-07-07/, `${item.key} 的 quote 没写清哪个报告期`);
    assert.match(item.quote, /HOLDER_RANK=\d+, HOLDER_NAME=/, `${item.key} 的 quote 不是原始字段值拼的`);
  }
});

test("quote 里的字段值逐字来自接口响应，不是重新格式化过的", () => {
  // 拆开逐段回原始行里核对。只要有一段的数字被四舍五入或改了单位，
  // 复核的人就会以为我们算错了。
  const period = holders.latestPeriod(ROWS);
  const byName = new Map(period.rows.map(row => [String(row.HOLDER_NAME), row]));
  // 名单 10 行 + 集中度段落重复的 10 行 = 20 段。段数不写死意图更清楚：
  // 每一段都必须能在原始响应里找到对应持有人，重复出现不是问题，改写才是。
  const segments = get("majorHolders").quote.split("｜").filter(s => s.includes("HOLDER_NAME="));
  assert.ok(segments.length >= 10, `名单至少要有 10 段，实际 ${segments.length}`);
  for (const segment of segments) {
    const name = segment.match(/HOLDER_NAME=(.+?), FREE_HOLDNUM_RATIO=/)[1];
    const row = byName.get(name);
    assert.ok(row, `quote 里出现了响应体里没有的持有人：${name}`);
    assert.ok(segment.includes(`HOLD_RATIO=${String(row.HOLD_RATIO)}`), `${name} 的 HOLD_RATIO 被改写过`);
    assert.ok(segment.includes(`HOLDER_TYPE=${String(row.HOLDER_TYPE)}`), `${name} 的 HOLDER_TYPE 被改写过`);
  }
});

test("口径：value 里必须写明是流通股东榜，且明确不是十大股东", () => {
  // 三次事故都是这一类：把「十大流通股东」当「十大股东」发出去。
  // 限售股不计入流通盘，两张榜的名字和排序都不一样。
  for (const item of facts) {
    assert.match(item.value, /十大流通股东/, `${item.key} 没说明是流通股东口径`);
    assert.match(item.value, /不是十大股东/, `${item.key} 没显式排除「十大股东」的误读`);
  }
});

test("口径：value 里必须写明比例的分母是总股本，不是流通股", () => {
  // 同一行里 HOLD_RATIO 占总股本、FREE_HOLDNUM_RATIO 占流通股，
  // 实测这一期两者合计分别是 20.5972% 和 27.1373%——差 6 个百分点。
  // 不写清用的哪个，读者拿去跟年报持股比例对，必然对不上。
  for (const item of facts) {
    assert.match(item.value, /HOLD_RATIO/, `${item.key} 没写用的是哪个比例字段`);
    assert.match(item.value, /占总股本/, `${item.key} 没写比例的分母`);
    assert.match(item.value, /不是占流通股比例/, `${item.key} 没排除占流通股的误读`);
  }
});

test("口径：value 里必须带报告期日期", () => {
  // 股东名单每季度变，不带日期的名单等于没有名单。
  for (const item of facts) {
    assert.match(item.value, /2026-07-07/, `${item.key} 没带报告期`);
  }
});

test("合计数就是十行相加，不虚增精度", () => {
  const period = holders.latestPeriod(ROWS);
  const sum = period.rows.reduce((acc, row) => acc + Number(row.HOLD_RATIO), 0);
  const rounded = Math.round(sum * 10000) / 10000;
  // 集中度并进了 majorHolders 尾部，不再单占 capTable
  assert.match(get("majorHolders").value, new RegExp(`合计持股占总股本 ${String(rounded).replace(".", "\\.")}%`));
  // 浮点尾巴不许漏进产物：20.597200000000002 这种串出现在报告里会被当成 bug
  assert.ok(!get("majorHolders").value.includes("0000000"), "浮点尾巴漏进 value 了");
});

test("口径：绝不产出 capTable——单期横截面答不了「股权结构变动」", () => {
  // 这是真出过的事故。capTable 的标签是「股权结构变动」，
  // 而接口只能给某一期的横截面。曾经把集中度塞进这一格，
  // 结果把年报里 statutory 的「控股股东报告期内未发生变更」顶掉了，
  // statutory 从 54 掉到 50——那句才是真的在回答「变动」。
  assert.equal(facts.find(f => f.key === "capTable"), undefined,
    "capTable 问的是变动，这条路线只有横截面，不许占这一格");
  // 集中度本身没丢，只是搬了家
  assert.match(get("majorHolders").value, /集中度（横截面，非变动）/);
});

test("刻意不抽增减持：接口的变动字段自相矛盾", () => {
  // 实测这一期 rank 6 香港中央结算 HOLD_NUM_CHANGE 为负却标「增加」，
  // rank 10 反过来。三个变动字段谁准无法从接口自身判定，抽出来就是编数据。
  const period = holders.latestPeriod(ROWS);
  const contradictory = period.rows.filter(row => {
    const n = Number(row.HOLD_NUM_CHANGE);
    if (!Number.isFinite(n) || n === 0) return false;
    return (n > 0 && row.HOLDNUM_CHANGE_NAME === "减少") || (n < 0 && row.HOLDNUM_CHANGE_NAME === "增加");
  });
  assert.ok(contradictory.length > 0, "固定语料里本来就有自相矛盾的行，没了说明换了语料");
  // 查的是「变动数字有没有漏进 value」，不能简单 grep「增减持」三个字——
  // value 里本来就有一句「不含增减持变动」的说明，那句是对的，不该被判违规。
  const changeValues = new Set();
  for (const row of period.rows) {
    for (const key of ["HOLD_NUM_CHANGE", "XZCHANGE", "HOLDNUM_CHANGE_NAME"]) {
      const raw = row[key];
      if (raw === null || raw === undefined || raw === "") continue;
      if (String(raw).replace("-", "").length >= 4) changeValues.add(String(raw));
    }
  }
  assert.ok(changeValues.size > 0, "固定语料里本来就有变动字段，没了说明换了语料");
  for (const item of facts) {
    for (const leaked of changeValues) {
      assert.ok(!item.value.includes(leaked), `${item.key} 把不可信的变动数据 ${leaked} 写进了 value`);
      assert.ok(!item.quote.includes(`=${leaked}`), `${item.key} 的 quote 里出现了变动字段值 ${leaked}`);
    }
  }
});

test("不由持股比例反推实际控制人", () => {
  // 持股第一 ≠ 实际控制人。科大讯飞流通榜第一是中国移动通信有限公司，
  // 而年报里的实控人是刘庆峰。controller 只能由年报原文填。
  assert.equal(get("controller"), undefined, "股东接口没有控制关系字段，不许推断 controller");
});

test("同一份响应抽两次结果完全一样", () => {
  const a = holders.extractHolderFacts(ROWS, SECU);
  const b = holders.extractHolderFacts(sources.rowsOfResponse(RAW), SECU);
  assert.deepEqual(a, b);
  // 日期解析不许经过 new Date()：那会带进时区，同一份缓存在不同机器上跑出不同日期
  assert.equal(holders.dateOf({ END_DATE: "2026-07-07 00:00:00" }), "2026-07-07");
});

test("垃圾输入不产出事实，也不炸", () => {
  assert.deepEqual(holders.extractHolderFacts([], SECU), []);
  assert.equal(holders.periodOf([]), null);
  assert.deepEqual(holders.extractHolderFacts([{ HOLDER_NAME: "某某" }], SECU), [], "没有 END_DATE 就没有报告期，不该产出事实");
  assert.deepEqual(sources.rowsOfResponse(null), []);
  assert.deepEqual(sources.rowsOfResponse({ result: { data: "not-an-array" } }), []);
});

test("接口 URL 与 ticker 规范化", () => {
  const url = sources.holderApiUrl(SECU);
  assert.match(url, /RPT_F10_EH_FREEHOLDERS/);
  assert.match(url, /301236\.SZ/);
  assert.equal(sources.toSecucode(" 301236.sz "), "301236.SZ");
  assert.equal(sources.toSecucode("PLTR"), null, "美股 ticker 不能拼进 A 股接口");
});
