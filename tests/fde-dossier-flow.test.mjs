import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { buildDossier } from "./build-dossier.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = buildDossier();
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { initializeDossierSchema, ingestAnnualReportCollection } = require(`${outDir}/dossier/repository.js`);
const { collectAnnualReport } = require(`${outDir}/collectors/annual-report.js`);
const { collectCorporateRegistry } = require(`${outDir}/collectors/corporate-registry.js`);
const { collectOfficialWebsite } = require(`${outDir}/collectors/official-website.js`);
const { collectInvestorInteraction } = require(`${outDir}/collectors/investor-interaction.js`);
const { mergeCompanyPeopleEvents } = require(`${outDir}/dossier/m3.js`);
const { ingestCompanyPeopleEvents } = require(`${outDir}/dossier/m3-repository.js`);
const { collectPeerCase } = require(`${outDir}/collectors/peer-case.js`);
const { ingestRelationshipCollection } = require(`${outDir}/dossier/m5-repository.js`);
const { collectIndustryWeeklyFeed } = require(`${outDir}/collectors/industry-weekly.js`);
const { ingestIndustryWeekly, promoteIndustryUpdateToEvent } = require(`${outDir}/dossier/m6-repository.js`);
const { generateDossier } = require(`${outDir}/dossier/generate.js`);
const { findMissingSourceFields } = require(`${outDir}/dossier/source-coverage.js`);

const fixture = path => readFileSync(resolve(root, path), "utf8");
const companyId = "002410.SZ";
const companyName = "广联达科技股份有限公司";
const industryId = "construction-digitalization";

function ingestRealFixtures(db) {
  ingestAnnualReportCollection(db, collectAnnualReport({
    companyId,
    companyName,
    industryId,
    industryName: "建筑产业数字化",
    url: "http://static.cninfo.com.cn/finalpage/2026-03-24/1225024978.PDF",
    content: fixture("tests/fixtures/annual-report/glodon-2025-pages.txt"),
    reportYear: 2025,
    publishedAt: "2026-03-24",
  }));
  const common = { companyId, companyName };
  ingestCompanyPeopleEvents(db, mergeCompanyPeopleEvents([
    collectCorporateRegistry({
      ...common,
      url: "http://static.cninfo.com.cn/finalpage/2026-03-24/1225024978.PDF#page=6",
      content: fixture("tests/fixtures/corporate-registry/glodon.csv"),
      publishedAt: "2026-03-24",
    }),
    collectOfficialWebsite({
      ...common,
      url: "https://www.glodon.com/news/1511.html",
      content: fixture("tests/fixtures/official-website/glodon-2025-ciftis.txt"),
      listing: "深交所 002410",
    }),
    collectInvestorInteraction({
      ...common,
      url: "https://static.cninfo.com.cn/finalpage/2025-08-26/1224565561.PDF#page=168",
      content: fixture("tests/fixtures/investor-interaction/glodon-2025-h1.txt"),
      publishedAt: "2025-08-26",
    }),
  ]));
  for (const peer of [
    ["Autodesk", "https://construction.autodesk.com/workflows/artificial-intelligence-construction/", "tests/fixtures/peer-case/autodesk-forma-ai.txt"],
    ["Procore", "https://support.procore.com/products/online/user-guide/project-level/assist", "tests/fixtures/peer-case/procore-assist.txt"],
  ]) {
    const collected = collectPeerCase({
      companyId,
      companyName,
      peerName: peer[0],
      url: peer[1],
      content: fixture(peer[2]),
      publishedAt: "2026-09-01",
    });
    ingestRelationshipCollection(db, collected.relationship);
  }
}

test("真实 fixture 从年报、官网、对标到周报回写形成完整的两次档案", () => {
  const started = performance.now();
  const db = new Database(":memory:");
  initializeDossierSchema(db);
  ingestRealFixtures(db);

  const first = generateDossier(db, companyId, "2026-09-01T01:00:00Z");
  assert.deepEqual(first.changes, []);
  assert.deepEqual(findMissingSourceFields(db, companyId), []);
  for (let chapter = 1; chapter <= 10; chapter += 1) assert.match(first.html, new RegExp(`id="chapter-${chapter}"`));
  assert.match(first.html, /Autodesk/);
  assert.match(first.html, /Procore/);
  assert.match(first.html, /有引用定位的算量\/组价\/清标助手/);

  const weekly = collectIndustryWeeklyFeed(industryId, fixture("tests/fixtures/industry-weekly/glodon-news-july-august-2026.json"));
  const selected = { sources: [weekly.sources[0]], updates: [weekly.updates[0]] };
  ingestIndustryWeekly(db, selected);
  const eventId = promoteIndustryUpdateToEvent(db, selected.updates[0].record.id);
  const second = generateDossier(db, companyId, "2026-09-08T01:00:00Z");
  assert.ok(second.changes.some(change => change.table === "event" && change.rowId === eventId));
  assert.match(second.html, /id="chapter-0"/);
  assert.match(second.html, /CADCG 2026/);
  assert.deepEqual(findMissingSourceFields(db, companyId), []);
  assert.equal(db.prepare("SELECT count(*) AS count FROM dossier_run").get().count, 2);
  assert.ok(performance.now() - started < 15 * 60 * 1000, "本地完整链路超过 15 分钟");
  db.close();
});
