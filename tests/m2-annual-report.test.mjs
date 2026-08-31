import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./build-dossier.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = buildDossier();
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { collectAnnualReport } = require(`${outDir}/collectors/annual-report.js`);
const { ingestAnnualReportCollection, initializeDossierSchema } = require(`${outDir}/dossier/repository.js`);

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
    ["数字成本", "数字施工", "数字设计", "海外"],
  );
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
    WHERE f."table" IN ('industry', 'industry_term', 'business_line', 'financial_snapshot', 'person', 'position')
      AND (s.id IS NULL OR s.url NOT LIKE '%#page=%' OR length(s.page_or_excerpt) = 0)
  `).all();
  assert.deepEqual(orphan, []);
  assert.equal(db.prepare("SELECT count(*) AS count FROM financial_snapshot").get().count, 3);
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
