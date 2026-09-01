// 定时补数必须先过这层：来源、时效、去重和容量任何一项不过，都不能写进关系图。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.ts";

const outDir = buildKernel();
const require = createRequire(import.meta.url);
const policy = require(`${outDir}/scheduler-policy.js`);
const NOW = new Date("2026-08-18T12:00:00.000Z");

function candidate(overrides = {}) {
  return {
    title: "甲公司与乙公司宣布新的战略合作",
    evidence: "甲公司与乙公司于 2026-08-10 正式宣布多年期战略合作，双方将共同提供企业人工智能产品与客户服务。",
    source: "甲公司官方公告",
    sourceUrl: "https://example.com/news/partnership-2026",
    _grade: "self",
    edges: [{ from: "甲公司", to: "乙公司", relation: "supply", direction: "forward" }],
    ...overrides,
  };
}

test("搜索结果页、无链接和未核实来源一律不自动入图", () => {
  const result = policy.selectSchedulerCandidates([
    candidate({ sourceUrl: "https://www.baidu.com/s?wd=甲公司" }),
    candidate({ sourceUrl: "" }),
    candidate({ sourceUrl: "https://example.net/report", _grade: "unverified" }),
  ], [], { now: NOW });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.weakSource, 2);
  assert.equal(result.rejected.unverifiedSource, 1);
});

test("没有明确日期或已经过时的材料不进入自动补数", () => {
  const result = policy.selectSchedulerCandidates([
    candidate({ evidence: "甲公司与乙公司宣布多年期战略合作，双方共同提供企业人工智能产品、数据平台、联合销售以及后续客户成功服务，但原文没有披露公告日期。" }),
    candidate({ evidence: "甲公司与乙公司于 2023-01-01 宣布战略合作，双方共同提供企业人工智能产品、数据平台、联合销售以及后续客户成功服务。", sourceUrl: "https://example.com/old" }),
  ], [], { now: NOW });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.staleOrUndated, 2);
});

test("同一关系换写法或调换竞争关系方向，都不会重复入图", () => {
  const existing = [{
    sourceUrl: "https://old.example.com/a",
    edges: [
      { from: "C3.ai", to: "Microsoft", relation: "supply", direction: "forward" },
      { from: "AWS", to: "Snowflake", relation: "compete", direction: "forward" },
    ],
  }];
  const result = policy.selectSchedulerCandidates([
    candidate({ sourceUrl: "https://example.com/c3", edges: [{ from: "C3 AI", to: "Microsoft", relation: "supply" }] }),
    candidate({ sourceUrl: "https://example.com/snow", edges: [{ from: "Snowflake", to: "AWS", relation: "compete" }] }),
  ], existing, { now: NOW });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.duplicateRelation, 2);
});

test("法定披露优先，并且每批和整张图都有硬上限", () => {
  const items = [
    candidate({ title: "普通来源的新合作关系", sourceUrl: "https://example.com/self", _grade: "self" }),
    candidate({ title: "法定披露中的新投资关系", sourceUrl: "https://www.sec.gov/Archives/new.htm", _grade: "statutory", edges: [{ from: "丙公司", to: "丁公司", relation: "equity" }] }),
    candidate({ title: "独立来源中的人员关系", sourceUrl: "https://gov.example.cn/new", _grade: "independent", edges: [{ from: "戊公司", to: "己公司", relation: "personnel" }] }),
  ];
  const result = policy.selectSchedulerCandidates(items, [], { now: NOW, maxAddedSignals: 2, maxAddedEdges: 2, maxGraphEdges: 2 });
  assert.deepEqual(result.accepted.map(item => item._grade), ["statutory", "independent"]);
  assert.equal(result.rejected.capacity, 1);
});
