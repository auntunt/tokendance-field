import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./build-dossier.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = buildDossier();
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { collectAnnualReport } = require(`${outDir}/collectors/annual-report.js`);
const { ingestAnnualReportCollection, initializeDossierSchema } = require(`${outDir}/dossier/repository.js`);
const { generateOpportunities } = require(`${outDir}/generate/opportunities.js`);
const { generateEntryPrep } = require(`${outDir}/generate/entry-prep.js`);
const { generateDossier } = require(`${outDir}/dossier/generate.js`);
const { findMissingSourceFields } = require(`${outDir}/dossier/source-coverage.js`);

const fixture = readFileSync(resolve(root, "tests/fixtures/annual-report/glodon-2025-pages.txt"), "utf8");

function collection() {
  return collectAnnualReport({
    companyId: "002410.SZ",
    companyName: "广联达",
    industryId: "construction-digitalization",
    industryName: "建筑产业数字化",
    url: "http://static.cninfo.com.cn/finalpage/2026-03-24/1225024978.PDF",
    content: fixture,
    reportYear: 2025,
    publishedAt: "2026-03-24",
  });
}

test("真实年报摘录按 PDF 页码抽取行业术语、业务线、财务和高管", () => {
  const result = collection();
  assert.ok(result.sources.every(source => /#page=\d+$/.test(source.url)));
  assert.deepEqual(
    result.businessLines.map(item => item.record.name),
    ["数字成本", "数字施工", "数字设计", "海外", "平台与生态"],
  );
  assert.deepEqual(result.processSteps.map(item => item.record.name), [
    "图纸/模型 → 算量 → 组价 → 投标/清标/评标",
    "数据接入/转换 → 统一标准 → 组件复用 → 产品/伙伴应用",
    "项目立项 → 人机料采集 → 进度/安全/成本分析 → 项目决策",
    "多专业设计 → 构件协同 → 算量/成本校核 → BIM 交付",
  ]);
  assert.deepEqual(result.systems.map(item => item.record.product), [
    "AECOS",
    "AecGPT",
    "项目综合决策 / 物料管理 / 劳务管理 / 安全管理 / 智能塔机",
  ]);
  const terms = new Set(result.industryTerms.map(item => item.record.term));
  for (const term of ["BIM", "工程算量", "清标 / 评标", "CDE / GDE / ECS", "AecGPT", "STL 组织"]) {
    assert.ok(terms.has(term), `缺少术语 ${term}`);
  }
  const financial2025 = result.financialSnapshots.find(item => item.record.year === "2025");
  assert.equal(financial2025.record.revenue, "6068493454.08");
  assert.equal(financial2025.record.netProfit, "405114040.23");
  assert.equal(financial2025.record.rndExpense, "1624692445.77");
  assert.deepEqual(
    result.positions.slice(0, 3).map(item => [
      result.people.find(person => person.record.id === item.record.personId)?.record.name,
      item.record.title,
    ]),
    [["袁正刚", "董事长、总裁"], ["刘谦", "董事、高级副总裁"], ["云浪生", "董事、高级副总裁"]],
  );
});

test("年报每个写入字段通过 Fact 指向具体 PDF 页", () => {
  const db = new Database(":memory:");
  initializeDossierSchema(db);
  const result = ingestAnnualReportCollection(db, collection());
  assert.ok(result.facts > 30);
  const orphan = db.prepare(`
    SELECT f."table", f.row_id, f.field
    FROM fact f LEFT JOIN source s ON s.id = f.source_id
    WHERE f."table" IN ('industry', 'industry_term', 'business_line', 'process_step', 'system_in_use', 'financial_snapshot', 'person', 'position')
      AND (s.id IS NULL OR s.url NOT LIKE '%#page=%' OR length(s.page_or_excerpt) = 0)
  `).all();
  assert.deepEqual(orphan, []);
  assert.equal(db.prepare("SELECT count(*) AS count FROM financial_snapshot").get().count, 3);
  assert.equal(db.prepare("SELECT count(*) AS count FROM process_step").get().count, 4);
  assert.equal(db.prepare("SELECT count(*) AS count FROM system_in_use").get().count, 3);
  db.close();
});

test("页码证据缺失时拒绝整份年报写入", () => {
  const db = new Database(":memory:");
  initializeDossierSchema(db);
  const result = collection();
  result.financialSnapshots[0].evidence.revenue.sourceId = "missing-page";
  assert.throws(() => ingestAnnualReportCollection(db, result), /缺少页码 Source/);
  assert.equal(db.prepare("SELECT count(*) AS count FROM source").get().count, 0);
  db.close();
});

test("M2 对照冻结 M0 第 2/3/7 章字段命中率不低于 80%", () => {
  const result = collection();
  const terms = new Set(result.industryTerms.map(item => item.record.term));
  const lines = new Set(result.businessLines.map(item => item.record.name));
  const financial = new Map(result.financialSnapshots.map(item => [item.record.year, item.record]));
  const expectedTerms = ["BIM", "工程算量", "清标 / 评标", "CDE / GDE / ECS", "AecGPT", "STL 组织"];
  const expectedLines = ["数字成本", "数字施工", "数字设计", "海外"];
  const expectedFinancial = [
    ["2023", "revenue", "6524575067.70"], ["2024", "revenue", "6202873989.82"], ["2025", "revenue", "6068493454.08"],
    ["2023", "netProfit", "115837537.09"], ["2024", "netProfit", "250424298.94"], ["2025", "netProfit", "405114040.23"],
    ["2023", "rndExpense", "1963000000"], ["2024", "rndExpense", "1805325661.16"], ["2025", "rndExpense", "1624692445.77"],
  ];
  const checks = [
    ...expectedTerms.map(term => terms.has(term)),
    ...expectedLines.map(line => lines.has(line)),
    ...expectedFinancial.map(([year, field, value]) => financial.get(year)?.[field] === value),
  ];
  const hits = checks.filter(Boolean).length;
  const rate = hits / checks.length;
  assert.equal(checks.length, 19);
  assert.equal(hits, 18, "唯一允许的缺口应是 2023 研发投入，需上一期年报补齐");
  assert.ok(rate >= 0.8, `字段命中率 ${(rate * 100).toFixed(1)}%`);
});

test("同一客户重跑年报后数值字段逐项一致", () => {
  const db = new Database(":memory:");
  initializeDossierSchema(db);
  ingestAnnualReportCollection(db, collection());
  const first = db.prepare("SELECT year, revenue, net_profit, rnd_expense, it_capex FROM financial_snapshot ORDER BY year").all();
  ingestAnnualReportCollection(db, collection());
  const second = db.prepare("SELECT year, revenue, net_profit, rnd_expense, it_capex FROM financial_snapshot ORDER BY year").all();
  assert.deepEqual(second, first);
  db.close();
});

test("真实年报入库后可直接生成至少四个有流程与系统来源的机会", () => {
  const db = new Database(":memory:");
  initializeDossierSchema(db);
  ingestAnnualReportCollection(db, collection());
  const opportunities = generateOpportunities(db, "002410.SZ");
  const scenarios = new Set(opportunities.map(item => item.aiScenario));
  assert.ok(opportunities.length >= 4);
  assert.ok(opportunities.every(item => item.processSourceIds.length > 0 && item.systemSourceIds.length > 0));
  for (const expected of [
    "有引用定位的算量/组价/清标助手",
    "AecGPT 评测与发布管理，按场景跟踪准确率/成本",
    "项目风险解释、原因定位与行动建议",
    "隐患识别后的规则校验、解释与闭环助手",
  ]) assert.ok(scenarios.has(expected), `缺少真实链路机会：${expected}`);
  assert.ok(opportunities.length / 6 >= 0.6, `真实链路机会重合率 ${(opportunities.length / 6 * 100).toFixed(1)}%`);
  const prep = generateEntryPrep(db, "002410.SZ", opportunities);
  assert.ok(prep.questions.length >= 5);
  assert.ok(prep.questions.every(item => item.basisIds.length > 0));
  db.close();
});

test("真实年报从入库到可打开档案的每个非空字段都有精确来源", () => {
  const db = new Database(":memory:");
  initializeDossierSchema(db);
  ingestAnnualReportCollection(db, collection());
  const dossier = generateDossier(db, "002410.SZ", "2026-09-01T00:00:00Z");
  assert.deepEqual(findMissingSourceFields(db, "002410.SZ"), []);
  assert.match(dossier.html, /^<!doctype html>/);
  assert.match(dossier.html, /class="sourced"/);
  assert.match(dossier.html, /#page=13/);
  assert.equal(db.prepare("SELECT count(*) AS count FROM dossier_run").get().count, 1);
  db.close();
});
