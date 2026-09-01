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
const { markdownChapterRange, measureFieldHitRate } = require(`${outDir}/dossier/coverage.js`);
const { collectJobPostings } = require(`${outDir}/collectors/job-posting.js`);
const { collectProcurement } = require(`${outDir}/collectors/procurement.js`);
const {
  ingestJobPostingCollection,
  ingestProcurementCollection,
  initializeDossierSchema,
} = require(`${outDir}/dossier/repository.js`);

const jobFixture = readFileSync(resolve(root, "tests/fixtures/job-posting/zhaopin-vnet.txt"), "utf8");
const procurementFixture = readFileSync(resolve(root, "tests/fixtures/procurement/ccgp-data-platform-award.txt"), "utf8");

function jobCollection() {
  return collectJobPostings({
    companyId: "VNET",
    companyName: "世纪互联",
    url: "https://www.zhaopin.com/companydetail/CZ145287090.htm",
    content: jobFixture,
    sourceType: "official",
  });
}

function procurementCollection() {
  return collectProcurement({
    companyId: "110000-data-center",
    companyName: "北京市大数据中心",
    url: "https://www.ccgp.gov.cn/cggg/dfgg/zbgg/202508/t20250815_25171560.htm",
    content: procurementFixture,
  });
}

test("招聘采集器从真实公开页摘录抽取职位、组织和技术关键词", () => {
  const collection = jobCollection();
  assert.equal(collection.source.publishedAt, "2026-07-03");
  assert.ok(collection.jobPostings.length >= 4);
  const idc = collection.jobPostings.find(item => item.record.title === "IDC运维工程师");
  assert.ok(idc);
  assert.equal(idc.record.orgUnit, "数据中心运维");
  assert.match(idc.record.techKeywords, /IDC/);
  assert.match(idc.record.systemKeywords, /服务器/);
  assert.ok(collection.orgUnits.some(item => item.record.name === "综合管理部"));
});

test("招投标采集器从政府采购公告抽取系统、供应商与采购单位", () => {
  const collection = procurementCollection();
  assert.equal(collection.source.type, "filing");
  assert.equal(collection.company.record.name, "北京市大数据中心");
  assert.equal(collection.systems.length, 1);
  const system = collection.systems[0].record;
  assert.equal(system.category, "数据平台");
  assert.equal(system.product, "北京市公共数据资源登记平台项目（软件部分）");
  assert.match(system.vendor, /首都信息发展股份有限公司/);
  assert.match(system.coversProcessStep, /平台软件开发服务/);
});

test("每个非空字段与 Source/Fact 在同一事务中写入", () => {
  const db = new Database(":memory:");
  initializeDossierSchema(db);
  const jobs = ingestJobPostingCollection(db, jobCollection());
  const procurement = ingestProcurementCollection(db, procurementCollection());
  assert.ok(jobs.jobPostings >= 4);
  assert.equal(procurement.systems, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM source").get().count, 2);

  const factKeys = new Set(db.prepare(`
    SELECT row_id, field FROM fact WHERE "table" = 'job_posting'
  `).all().map(row => `${row.row_id}:${row.field}`));
  const fields = ["org_unit", "title", "tech_keywords", "system_keywords", "posted_at"];
  for (const row of db.prepare("SELECT * FROM job_posting").all()) {
    for (const field of fields) {
      if (row[field]) assert.ok(factKeys.has(`${row.id}:${field}`), `${row.id}.${field} 没有 Fact`);
    }
  }
  db.close();
});

test("缺少字段摘录时整批拒绝写入", () => {
  const db = new Database(":memory:");
  initializeDossierSchema(db);
  const collection = jobCollection();
  delete collection.jobPostings[0].evidence.title;
  assert.throws(() => ingestJobPostingCollection(db, collection), /缺少来源摘录/);
  assert.equal(db.prepare("SELECT count(*) AS count FROM source").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM job_posting").get().count, 0);
  db.close();
});

test("M1 对照冻结 M0 第 4/5 章的实际产出字段命中率不低于 70%", () => {
  const jobs = jobCollection();
  const dossier = readFileSync(resolve(root, "examples/dossiers/世纪互联.md"), "utf8");
  const reference = markdownChapterRange(dossier, 4, 5);
  const signals = jobs.jobPostings.map(item => ({
    field: `JobPosting(${item.record.title}).org_unit`,
    value: item.record.orgUnit,
    referenceTerms: item.record.orgUnit === "数据中心运维"
      ? ["数据中心", "运维"]
      : [item.record.orgUnit],
  }));
  const report = measureFieldHitRate(reference, signals);
  assert.equal(report.total, 5);
  assert.equal(report.hits, 4);
  assert.deepEqual(
    report.fields.filter(item => !item.hit).map(item => item.value),
    ["综合管理部"],
  );
  assert.ok(report.rate >= 0.7, `字段命中率 ${(report.rate * 100).toFixed(1)}%`);
});
