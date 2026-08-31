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
const { initializeDossierSchema } = require(`${outDir}/dossier/repository.js`);
const { collectIndustryWeeklyFeed } = require(`${outDir}/collectors/industry-weekly.js`);
const { ingestIndustryWeekly, promoteIndustryUpdateToEvent } = require(`${outDir}/dossier/m6-repository.js`);
const { renderIndustryWeeklyHtml } = require(`${outDir}/dossier/industry-weekly-html.js`);
const { renderDossierHtml } = require(`${outDir}/dossier/html.js`);

const content = readFileSync(resolve(root, "tests/fixtures/industry-weekly/glodon-news-july-august-2026.json"), "utf8");

function database() {
  const db = new Database(":memory:");
  initializeDossierSchema(db);
  db.prepare("INSERT INTO industry (id, name) VALUES (?, ?)").run("construction", "建筑与工程数字化");
  db.prepare("INSERT INTO company (id, name, industry_id, listing) VALUES (?, ?, ?, ?)")
    .run("002410.SZ", "广联达科技股份有限公司", "construction", "A股");
  return db;
}

function batch(collection, start, size = 3) {
  const updates = collection.updates.slice(start, start + size);
  const sourceIds = new Set(updates.flatMap(item => Object.values(item.evidence).map(evidence => evidence.sourceId)));
  return { updates, sources: collection.sources.filter(source => sourceIds.has(source.id)) };
}

test("行业列表页采集结果每条都有类型、来源链接和原文片段", () => {
  const collection = collectIndustryWeeklyFeed("construction", content);
  assert.equal(collection.updates.length, 12);
  assert.ok(collection.sources.every(source => source.url.startsWith("https://")));
  assert.ok(collection.sources.every(source => source.pageOrExcerpt.length > 10));
  assert.ok(collection.updates.every(item => item.record.kind === "target_action"));
  assert.ok(collection.updates.every(item => item.evidence.summary.sourceId));
});

test("四批历史回放每批选择三条，重复列表不会重复上周条目", () => {
  const db = database();
  const collection = collectIndustryWeeklyFeed("construction", content);
  for (let index = 0; index < 4; index += 1) {
    const current = batch(collection, index * 3);
    assert.deepEqual(ingestIndustryWeekly(db, current), { inserted: 3, existing: 0 });
    for (const item of current.updates) promoteIndustryUpdateToEvent(db, item.record.id);
  }
  assert.equal(db.prepare("SELECT count(*) AS count FROM industry_update").get().count, 12);
  assert.equal(db.prepare("SELECT count(*) AS count FROM event").get().count, 12);
  assert.deepEqual(ingestIndustryWeekly(db, collection), { inserted: 0, existing: 12 });
  assert.equal(db.prepare("SELECT count(*) AS count FROM industry_update").get().count, 12);
  db.close();
});

test("勾选条目写入 Event，并在下一次客户档案第 6 章出现", () => {
  const db = database();
  const collection = collectIndustryWeeklyFeed("construction", content);
  const selected = batch(collection, 0, 1);
  ingestIndustryWeekly(db, selected);
  const eventId = promoteIndustryUpdateToEvent(db, selected.updates[0].record.id);
  const event = db.prepare("SELECT * FROM event WHERE id=?").get(eventId);
  assert.match(event.summary, /AI×BIM/);
  const html = renderDossierHtml(db, "002410.SZ", [], { stakeholders: [], questions: [], risks: [] }, []);
  assert.match(html, /chapter-6/);
  assert.match(html, /AI×BIM/);
  assert.match(html, /https:\/\/www\.glodon\.com\/News\//);
  db.close();
});

test("一页行业周报展示日期、类型、状态和可点击来源", () => {
  const db = database();
  const collection = collectIndustryWeeklyFeed("construction", content);
  ingestIndustryWeekly(db, collection);
  promoteIndustryUpdateToEvent(db, collection.updates[0].record.id);
  const html = renderIndustryWeeklyHtml(db, "construction", "2026-07-01", "2026-08-31");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /target_action/);
  assert.match(html, /已写入/);
  assert.match(html, /写入 Event/);
  assert.match(html, /href="https:\/\/www\.glodon\.com/);
  db.close();
});
