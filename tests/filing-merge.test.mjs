// 守一个真出过的事故：`--only 301236` 把 13 家公司的产物覆盖成 1 家。
//
// 原来 scripts/fetch-filings.mjs 是 writeFileSync(outFile, { companies: 本次结果 })。
// 全量跑看不出问题，单跑一家就把另外 12 家静默抹掉——不报错、不留痕，
// 只有下次 build-report 覆盖率暴跌才会发现。这类测试比抽取测试更值钱，
// 因为抽错了看得见，抹掉了看不见。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, ".report-build");
execFileSync(resolve(root, "node_modules/.bin/tsc"), [
  "lib/fde-dimensions.ts", "lib/filing-merge.ts",
  "--outDir", ".report-build", "--module", "commonjs", "--moduleResolution", "node10",
  "--target", "es2022", "--strict", "--skipLibCheck",
], { cwd: root, stdio: "inherit" });
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "package.json"), '{"type":"commonjs"}');
const require = createRequire(import.meta.url);
const merge = require(`${outDir}/filing-merge.js`);

const sourced = (value, grade) => ({ value, grade, source: "s", sourceUrl: "u", fetchedAt: "2026-08-01", quote: value });
const filing = name => ({ title: `${name} 年报`, date: "2026-04-24", url: `https://example.test/${name}` });

const previous = {
  fetchedAt: "2026-08-01",
  companies: [
    { id: "a", name: "甲", filing: filing("a"), facts: { shareholders: { controller: sourced("张三", "statutory") } } },
    { id: "b", name: "乙", filing: filing("b"), facts: { team: { headcount: sourced("100 人", "statutory") } } },
    { id: "c", name: "丙", filing: filing("c"), facts: { fde: { fdeNaming: sourced("未提及", "statutory") } } },
  ],
  failures: [{ id: "z", name: "丁", why: "抓不到" }],
};

test("单家重跑不会抹掉其他公司", () => {
  const incoming = [{ id: "a", name: "甲", filing: filing("a2"), facts: { shareholders: { majorHolders: sourced("名单", "independent") } } }];
  const out = merge.mergeFilingFacts(previous, incoming, [], "2026-08-09", ["a"]);
  assert.equal(out.companies.length, 3, "只跑了甲，乙丙必须还在");
  assert.deepEqual(out.companies.map(c => c.id), ["a", "b", "c"], "公司顺序要稳定，否则 diff 全是假变更");
  assert.equal(out.companies.find(c => c.id === "b").facts.team.headcount.value, "100 人");
});

test("同一维度里两条来源路线的字段互不覆盖", () => {
  // 年报给 controller（statutory），东方财富接口给 majorHolders（independent），
  // 都往 shareholders 维度写。整块替换会让两条路线互删。
  const incoming = [{ id: "a", name: "甲", filing: filing("a2"), facts: { shareholders: { majorHolders: sourced("十大流通股东名单", "independent") } } }];
  const out = merge.mergeFilingFacts(previous, incoming, [], "2026-08-09", ["a"]);
  const s = out.companies.find(c => c.id === "a").facts.shareholders;
  assert.equal(s.controller.value, "张三", "年报抽的实控人被股东数据覆盖掉了");
  assert.equal(s.controller.grade, "statutory");
  assert.equal(s.majorHolders.grade, "independent");
  assert.equal(Object.keys(s).length, 2);
});

test("同字段重跑取新值", () => {
  const incoming = [{ id: "a", name: "甲", filing: filing("a2"), facts: { shareholders: { controller: sourced("李四", "statutory") } } }];
  const out = merge.mergeFilingFacts(previous, incoming, [], "2026-08-09", ["a"]);
  assert.equal(out.companies.find(c => c.id === "a").facts.shareholders.controller.value, "李四");
});

test("新公司追加在末尾", () => {
  const incoming = [{ id: "d", name: "戊", filing: filing("d"), facts: { team: { headcount: sourced("9 人", "statutory") } } }];
  const out = merge.mergeFilingFacts(previous, incoming, [], "2026-08-09", ["d"]);
  assert.deepEqual(out.companies.map(c => c.id), ["a", "b", "c", "d"]);
});

test("keepFiling 的补充来源不改写已有的法定披露出处", () => {
  // 只拿到东方财富股东数据、年报没抓到时，出处不能变成东方财富——
  // 那些 statutory 事实实际来自年报，出处错配比缺出处更糟。
  const incoming = [{
    id: "a", name: "甲", keepFiling: true,
    filing: { title: "东方财富 F10", date: "2026-07-07", url: "https://eastmoney.test" },
    facts: { shareholders: { majorHolders: sourced("名单", "independent") } },
  }];
  const out = merge.mergeFilingFacts(previous, incoming, [], "2026-08-09", ["a"]);
  // 不写死字面量：filing() 是按 id 造的（"a 年报"），写成中文名会假失败
  assert.equal(out.companies.find(c => c.id === "a").filing.title, filing("a").title);
  // 但字段自己的 sourceUrl 还是接口，这才是这条事实真正的出处
  assert.equal(out.companies.find(c => c.id === "a").facts.shareholders.majorHolders.sourceUrl, "u");
});

test("低定级不许覆盖高定级：statutory 不被 independent 顶掉", () => {
  // 真出过的事故：年报路线给科大讯飞 shareholders.majorHolders 写了 statutory 的
  // 「无控股主体」，东方财富路线随后用 independent 的十大流通股东名单顶掉它。
  // 合并前 54 条 statutory，合并后 50 条——静默丢了 4 条最高可信度事实，不报错。
  const incoming = [{
    id: "a", name: "甲", filing: filing("a2"),
    facts: { shareholders: { controller: sourced("十大流通股东名单", "independent") } },
  }];
  const out = merge.mergeFilingFacts(previous, incoming, [], "2026-08-09", ["a"]);
  const controller = out.companies.find(c => c.id === "a").facts.shareholders.controller;
  assert.equal(controller.value, "张三", "statutory 的实控人被 independent 顶掉了");
  assert.equal(controller.grade, "statutory");
});

test("同定级仍然按「新的赢」，降级保护不该冻住正常更新", () => {
  // 保护只针对降级。同一条路线重跑拿到新值时必须能更新，
  // 否则年报出了新一期也刷不进去，产物会永远停在第一次抓取。
  const incoming = [{
    id: "a", name: "甲", filing: filing("a2"),
    facts: { shareholders: { controller: sourced("李四", "statutory") } },
  }];
  const out = merge.mergeFilingFacts(previous, incoming, [], "2026-08-09", ["a"]);
  assert.equal(out.companies.find(c => c.id === "a").facts.shareholders.controller.value, "李四");
});

test("升级是允许的：independent 可以被 statutory 顶替", () => {
  const prev = {
    ...previous,
    companies: [{ id: "a", name: "甲", filing: filing("a"),
      facts: { shareholders: { controller: sourced("接口给的", "independent") } } }],
  };
  const incoming = [{
    id: "a", name: "甲", filing: filing("a2"),
    facts: { shareholders: { controller: sourced("年报给的", "statutory") } },
  }];
  const out = merge.mergeFilingFacts(prev, incoming, [], "2026-08-09", ["a"]);
  const controller = out.companies.find(c => c.id === "a").facts.shareholders.controller;
  assert.equal(controller.value, "年报给的");
  assert.equal(controller.grade, "statutory");
});

test("没跑过的旧失败记录保留，跑过的以本次为准", () => {
  const out = merge.mergeFilingFacts(previous, [], [{ id: "b", name: "乙", why: "这次超时" }], "2026-08-09", ["b"]);
  const ids = out.failures.map(f => f.id);
  assert.ok(ids.includes("z"), "丁这次没跑，它抓不到仍然是事实，不该消失");
  assert.equal(out.failures.filter(f => f.id === "b").length, 1);
});

test("跑过并成功的公司，旧失败记录要消失", () => {
  const prev = { ...previous, failures: [{ id: "a", name: "甲", why: "上次抓不到" }] };
  const incoming = [{ id: "a", name: "甲", filing: filing("a2"), facts: { team: { headcount: sourced("5 人", "statutory") } } }];
  const out = merge.mergeFilingFacts(prev, incoming, [], "2026-08-09", ["a"]);
  assert.deepEqual(out.failures, [], "上次失败这次成功，旧记录必须清掉");
});

test("单跑一家不会把整份产物的时间戳往前拨", () => {
  const out = merge.mergeFilingFacts({ ...previous, fetchedAt: "2026-08-20" }, [], [], "2026-08-09", ["a"]);
  assert.equal(out.fetchedAt, "2026-08-20", "取较新的那个，否则报告显示的数据新鲜度会失真");
});

test("首次落盘（无历史产物）也能工作", () => {
  const incoming = [{ id: "a", name: "甲", filing: filing("a"), facts: {} }];
  const out = merge.mergeFilingFacts(merge.EMPTY_FILING_FACTS, incoming, [], "2026-08-09", ["a"]);
  assert.equal(out.companies.length, 1);
  assert.equal(out.fetchedAt, "2026-08-09");
});

test("合并是确定的：字段顺序不随输入顺序漂", () => {
  const one = [{ id: "a", name: "甲", filing: filing("a"), facts: { shareholders: { majorHolders: sourced("m", "independent"), capTable: sourced("c", "independent") } } }];
  const two = [{ id: "a", name: "甲", filing: filing("a"), facts: { shareholders: { capTable: sourced("c", "independent"), majorHolders: sourced("m", "independent") } } }];
  const a = merge.mergeFilingFacts(previous, one, [], "2026-08-09", ["a"]);
  const b = merge.mergeFilingFacts(previous, two, [], "2026-08-09", ["a"]);
  assert.equal(JSON.stringify(a), JSON.stringify(b), "序列化后必须逐字相同，否则 git diff 全是顺序噪音");
});

test("countByGrade 分定级计数", () => {
  const out = merge.mergeFilingFacts(previous, [
    { id: "a", name: "甲", filing: filing("a"), facts: { shareholders: { majorHolders: sourced("m", "independent"), capTable: sourced("c", "independent") } } },
  ], [], "2026-08-09", ["a"]);
  assert.equal(merge.countByGrade(out, "independent"), 2);
  assert.equal(merge.countByGrade(out, "statutory"), 3);
});
