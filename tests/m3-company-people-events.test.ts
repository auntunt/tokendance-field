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
const { collectCorporateRegistry } = require(`${outDir}/collectors/corporate-registry.js`);
const { collectOfficialWebsite } = require(`${outDir}/collectors/official-website.js`);
const { collectInvestorInteraction } = require(`${outDir}/collectors/investor-interaction.js`);
const { mergeCompanyPeopleEvents } = require(`${outDir}/dossier/m3.js`);
const { ingestCompanyPeopleEvents } = require(`${outDir}/dossier/m3-repository.js`);
const { initializeDossierSchema } = require(`${outDir}/dossier/repository.js`);

const registryFixture = readFileSync(resolve(root, "tests/fixtures/corporate-registry/glodon.csv"), "utf8");
const websiteFixture = readFileSync(resolve(root, "tests/fixtures/official-website/glodon-2025-ciftis.txt"), "utf8");
const interactionFixture = readFileSync(resolve(root, "tests/fixtures/investor-interaction/glodon-2025-h1.txt"), "utf8");

function collected() {
  const common = { companyId: "002410.SZ", companyName: "广联达科技股份有限公司" };
  return mergeCompanyPeopleEvents([
    collectCorporateRegistry({
      ...common,
      url: "http://static.cninfo.com.cn/finalpage/2026-03-24/1225024978.PDF#page=6",
      content: registryFixture,
      publishedAt: "2026-03-24",
    }),
    collectOfficialWebsite({
      ...common,
      url: "https://www.glodon.com/news/1511.html",
      content: websiteFixture,
      listing: "深交所 002410",
    }),
    collectInvestorInteraction({
      ...common,
      url: "https://static.cninfo.com.cn/finalpage/2025-08-26/1224565561.PDF#page=168",
      content: interactionFixture,
      publishedAt: "2025-08-26",
    }),
  ]);
}

test("工商 CSV、官网和互动平台分别产出主体、人物与事件", () => {
  const result = collected();
  assert.equal(result.company.record.name, "广联达科技股份有限公司");
  assert.equal(result.company.record.listing, "深交所 002410");
  assert.deepEqual(new Set(result.sources.map(source => source.type)), new Set(["filing", "official"]));
  assert.ok(result.people.some(item => item.record.name === "袁正刚" && item.record.bio === "法定代表人"));
  assert.ok(result.people.some(item => item.record.name === "刘刚" && item.record.bio === "副总裁"));
  assert.ok(result.events.some(item => item.record.occurredAt === "2025-09-16" && /GCCP7\.0/.test(item.record.summary)));
  assert.ok(result.events.some(item => item.record.occurredAt === "2025-05-21" && /互动易云访谈/.test(item.record.summary)));
});

test("M3 写入后每个非空字段都有各自来源", () => {
  const db = new Database(":memory:");
  initializeDossierSchema(db);
  const result = ingestCompanyPeopleEvents(db, collected());
  assert.ok(result.facts > 20);
  const missing = db.prepare(`
    SELECT f."table", f.row_id, f.field
    FROM fact f LEFT JOIN source s ON s.id=f.source_id
    WHERE f."table" IN ('company', 'person', 'position', 'event') AND s.id IS NULL
  `).all();
  assert.deepEqual(missing, []);
  assert.equal(db.prepare("SELECT count(*) AS count FROM event").get().count, 2);
  assert.equal(db.prepare("SELECT count(*) AS count FROM person").get().count, 2);
  db.close();
});

test("引用不存在的来源时整批拒绝写入", () => {
  const db = new Database(":memory:");
  initializeDossierSchema(db);
  const result = collected();
  result.events[0].evidence.summary.sourceId = "missing";
  assert.throws(() => ingestCompanyPeopleEvents(db, result), /缺少有效 Source/);
  assert.equal(db.prepare("SELECT count(*) AS count FROM source").get().count, 0);
  db.close();
});

test("M3 对照冻结 M0 第 1/6 章可观察字段命中率不低于 80%", () => {
  const result = collected();
  const legalRepresentative = result.positions.find(item => item.record.title === "法定代表人");
  const legalPerson = result.people.find(item => item.record.id === legalRepresentative?.record.personId);
  const officialEvent = result.events.find(item => item.record.occurredAt === "2025-09-16");
  const checks = [
    result.company.record.name === "广联达科技股份有限公司",
    result.company.record.listing === "深交所 002410",
    legalPerson?.record.name === "袁正刚",
    legalRepresentative?.record.title === "法定代表人",
    officialEvent?.record.occurredAt === "2025-09-16",
    /AI应用行动指南/.test(officialEvent?.record.summary ?? ""),
    /GCCP7\.0/.test(officialEvent?.record.summary ?? ""),
  ];
  const hits = checks.filter(Boolean).length;
  const rate = hits / checks.length;
  assert.ok(rate >= 0.8, `字段命中率 ${(rate * 100).toFixed(1)}%`);
});
