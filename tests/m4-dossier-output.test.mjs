import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { buildDossier } from "./build-dossier.mjs";

const outDir = buildDossier();
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { initializeDossierSchema } = require(`${outDir}/dossier/repository.js`);
const { generateOpportunities, persistOpportunities } = require(`${outDir}/generate/opportunities.js`);
const { generateEntryPrep } = require(`${outDir}/generate/entry-prep.js`);
const { createDossierRun } = require(`${outDir}/dossier/snapshot.js`);
const { entryPrepCharacterCount, renderDossierHtml } = require(`${outDir}/dossier/html.js`);

function seed() {
  const db = new Database(":memory:");
  initializeDossierSchema(db);
  const sources = [
    ["s-p13", "http://static.cninfo.com.cn/finalpage/2026-03-24/1225024978.PDF#page=13"],
    ["s-p14", "http://static.cninfo.com.cn/finalpage/2026-03-24/1225024978.PDF#page=14"],
    ["s-p15", "http://static.cninfo.com.cn/finalpage/2026-03-24/1225024978.PDF#page=15"],
  ];
  for (const [id, url] of sources) {
    db.prepare("INSERT INTO source VALUES (?, ?, 'filing', '2026-03-24', ?, ?)").run(id, url, `fp-${id}`, `广联达真实年报摘录 ${id}`);
  }
  let fact = 0;
  const addFact = (sourceId, table, rowId, field = "name") => {
    fact += 1;
    db.prepare('INSERT INTO fact VALUES (?, ?, ?, ?, ?)').run(`f-${fact}`, sourceId, table, rowId, field);
  };
  db.prepare("INSERT INTO industry VALUES ('construction', '建筑产业数字化', '行业标准、工程数据、云与算力', '建设方、设计院、施工企业', '续费率、渗透率、项目成本', '住建部门、交易所')").run();
  db.prepare("INSERT INTO company VALUES ('002410.SZ', '广联达科技股份有限公司', 'construction', '', '深交所 002410')").run();
  addFact("s-p13", "company", "002410.SZ");
  db.prepare("INSERT INTO industry_term VALUES ('term-bim', 'construction', 'BIM', '用可计算的三维模型承载工程数据', '')").run();
  addFact("s-p13", "industry_term", "term-bim");
  const lines = [
    ["G-BL1", "数字成本", "G-PS1", 1, "图纸/模型 → 算量 → 组价 → 投标/清标/评标", "数字成本产品线", "图纸、清单、定额与材料价跨源核验耗时", "s-p14"],
    ["G-BL2", "数字施工", "G-PS2", 1, "项目立项 → 人机料采集 → 进度/安全/成本分析 → 项目决策", "数字施工产品线", "人机料数据分散，安全隐患闭环慢", "s-p15"],
    ["G-BL4", "平台与生态", "G-PS4", 1, "数据接入/转换 → 统一标准 → 组件复用 → 产品/伙伴应用", "技术平台", "模型、提示与评测难统一", "s-p13"],
    ["G-BL5", "客户经营", "G-PS5", 1, "客户细分 → 方案/合同 → 交付/服务 → 使用 → 续费/扩品", "客群 / 销售运营", "跨产品机会与服务问题难统一", "s-p14"],
  ];
  for (const [lineId, name, stepId, seq, step, owner, pain, sourceId] of lines) {
    db.prepare("INSERT INTO business_line VALUES (?, '002410.SZ', ?, NULL)").run(lineId, name);
    db.prepare("INSERT INTO process_step VALUES (?, ?, ?, ?, ?, ?)").run(stepId, lineId, seq, step, owner, pain);
    addFact(sourceId, "business_line", lineId);
    addFact(sourceId, "process_step", stepId);
  }
  const systems = [
    ["G-SYS1", "产业平台", "AECOS", "自研", "数据接入、统一标准、组件复用", "s-p13"],
    ["G-SYS2", "AI 平台", "AecGPT", "自研", "算量、组价、清标、评标、客户服务", "s-p13"],
    ["G-SYS3", "数据平台", "业务中台 / 数据中台", "自研", "数据连接和主数据", "s-p13"],
    ["G-SYS4", "项目管理与安全", "PMSmart / AI 安全", "自研", "人机料、进度、安全、项目决策与隐患闭环", "s-p15"],
    ["G-SYS5", "ERP / CRM", "具体产品未披露", "待确认", "客户、合同、续费、扩品", "s-p14"],
  ];
  for (const [id, category, product, vendor, covers, sourceId] of systems) {
    db.prepare("INSERT INTO system_in_use VALUES (?, '002410.SZ', ?, ?, ?, ?, NULL)").run(id, category, product, vendor, covers);
    addFact(sourceId, "system_in_use", id);
  }
  db.prepare("INSERT INTO org_unit VALUES ('G-ORG1', '002410.SZ', '董事会 / 董事长', NULL, NULL)").run();
  addFact("s-p14", "org_unit", "G-ORG1");
  db.prepare("INSERT INTO person VALUES ('G-P1', '袁正刚', '董事长，负责战略与经营授权', 'decider')").run();
  db.prepare("INSERT INTO position VALUES ('G-POS1', '002410.SZ', 'G-P1', '董事长', '战略与经营授权', NULL, NULL)").run();
  addFact("s-p14", "person", "G-P1");
  addFact("s-p14", "position", "G-POS1");
  for (const [year, revenue, profit, rnd] of [[2023, 6524575067.70, 115837537.09, 1963000000], [2024, 6202873989.82, 250424298.94, 1805325661.16], [2025, 6068493454.08, 405114040.23, 1624692445.77]]) {
    const id = `G-FIN-${year}`;
    db.prepare("INSERT INTO financial_snapshot VALUES (?, '002410.SZ', ?, ?, ?, ?, NULL, '')").run(id, year, revenue, profit, rnd);
    addFact("s-p14", "financial_snapshot", id);
  }
  db.prepare("INSERT INTO event VALUES ('G-E1', '002410.SZ', '2025-09-16', 'strategy', '发布 GCCP7.0 与建筑企业 AI 应用行动指南')").run();
  addFact("s-p14", "event", "G-E1");
  return { db, addFact };
}

test("机会地图仅生成同时具有流程与系统来源的六个可追溯机会", () => {
  const { db } = seed();
  const opportunities = generateOpportunities(db, "002410.SZ");
  assert.equal(opportunities.length, 6);
  assert.ok(opportunities.every(row => row.processStepId && row.systemInUseId
    && row.processSourceIds.length > 0 && row.systemSourceIds.length > 0));
  persistOpportunities(db, opportunities);
  for (const opportunity of opportunities) {
    const basis = db.prepare(`SELECT field FROM fact WHERE "table"='opportunity' AND row_id=? AND field LIKE 'system_in_use:%'`).all(opportunity.id);
    assert.ok(basis.some(row => row.field === `system_in_use:${opportunity.systemInUseId}`));
  }
  db.close();
});

test("M4 机会与 M0 手写结果重合不低于 60%，问题清单至少五条当时就该问", () => {
  const { db } = seed();
  const opportunities = generateOpportunities(db, "002410.SZ");
  const prep = generateEntryPrep(db, "002410.SZ", opportunities);
  const expectedScenarios = new Set([
    "有引用定位的算量/组价/清标助手",
    "AecGPT 评测与发布管理，按场景跟踪准确率/成本",
    "基于产品文档、规则库和案例的可追溯助手",
    "项目风险解释、原因定位与行动建议",
    "客户计划助手与下一最佳行动",
    "隐患识别后的规则校验、解释与闭环助手",
  ]);
  const overlap = opportunities.filter(row => expectedScenarios.has(row.aiScenario)).length / expectedScenarios.size;
  assert.ok(overlap >= 0.6, `机会地图重合率 ${(overlap * 100).toFixed(1)}%`);
  const m0Questions = new Set([
    "七领域哪项已有周活、准确率、续费？", "AECOS 与数据中台如何分工？", "成本业务先改善续费还是客单价？",
    "输出能否定位图纸、清单和价格？", "外部模型和算力供应商是谁？", "评测是否分地区、专业、规则版本？",
    "人工纠错是否回流？", "ERP/CRM 接口与负责人是谁？", "试点验收看时间、收入还是风险？",
  ]);
  assert.ok(prep.questions.filter(item => m0Questions.has(item.question)).length >= 5);
  assert.ok(prep.questions.length <= 10);
  assert.ok(prep.questions.every(item => item.basisIds.length > 0));
  assert.ok(entryPrepCharacterCount(prep) <= 400);
  db.close();
});

test("DossierRun 只报告真实字段变化，相同数据重跑为空", () => {
  const { db, addFact } = seed();
  const opportunities = generateOpportunities(db, "002410.SZ");
  persistOpportunities(db, opportunities);
  const first = createDossierRun(db, "002410.SZ", "2026-09-01T08:00:00+08:00");
  assert.deepEqual(first.changes, []);
  const same = createDossierRun(db, "002410.SZ", "2026-09-08T08:00:00+08:00");
  assert.deepEqual(same.changes, []);
  db.prepare("INSERT INTO event VALUES ('G-E2', '002410.SZ', '2026-09-09', 'statement', '新增产业 AI 产品进展')").run();
  addFact("s-p13", "event", "G-E2");
  const changed = createDossierRun(db, "002410.SZ", "2026-09-15T08:00:00+08:00");
  assert.equal(changed.changes.length, 1);
  assert.equal(changed.changes[0].kind, "added");
  assert.equal(changed.changes[0].rowId, "G-E2");
  assert.ok(changed.changes[0].sourceUrls[0].includes("#page=13"));
  db.close();
});

test("生成可独立打开的 0–10 章 HTML 档案并保留来源链接", () => {
  const { db, addFact } = seed();
  const opportunities = generateOpportunities(db, "002410.SZ");
  persistOpportunities(db, opportunities);
  createDossierRun(db, "002410.SZ", "2026-09-01T08:00:00+08:00");
  db.prepare("INSERT INTO event VALUES ('G-E2', '002410.SZ', '2026-09-09', 'statement', '新增产业 AI 产品进展')").run();
  addFact("s-p13", "event", "G-E2");
  const run = createDossierRun(db, "002410.SZ", "2026-09-15T08:00:00+08:00");
  const prep = generateEntryPrep(db, "002410.SZ", opportunities);
  const html = renderDossierHtml(db, "002410.SZ", opportunities, prep, run.changes);
  for (let chapter = 0; chapter <= 10; chapter += 1) assert.match(html, new RegExp(`id="chapter-${chapter}"`));
  assert.match(html, /G-PS1 \/ G-SYS2/);
  assert.match(html, /#page=13/);
  assert.doesNotMatch(html, /undefined|null/);
  const directory = mkdtempSync(join(tmpdir(), "fde-dossier-"));
  const path = join(directory, "广联达.html");
  writeFileSync(path, html, "utf8");
  assert.match(readFileSync(path, "utf8"), /^<!doctype html>/);
  db.close();
});
