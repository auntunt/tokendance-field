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
const { initializeDossierSchema } = require(`${outDir}/dossier/repository.js`);
const { collectIndustryWeeklyFeed } = require(`${outDir}/collectors/industry-weekly.js`);
const {
  ensureIndustryWeeklySchema,
  getIndustryWeeklyAcceptance,
  ingestIndustryWeekly,
  promoteIndustryUpdateToEvent,
} = require(`${outDir}/dossier/m6-repository.js`);
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

function batch(collection: any, start: number, size = 3): any {
  const updates = collection.updates.slice(start, start + size);
  const sourceIds = new Set(updates.flatMap(item => Object.values(item.evidence).map((evidence: any) => evidence.sourceId)));
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
  const weeks = ["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"];
  for (let index = 0; index < 4; index += 1) {
    const current = batch(collection, index * 3);
    assert.deepEqual(ingestIndustryWeekly(db, current), { inserted: 3, existing: 0 });
    for (const item of current.updates) {
      promoteIndustryUpdateToEvent(db, item.record.id, undefined, `${weeks[index]}T01:00:00.000Z`);
    }
  }
  assert.equal(db.prepare("SELECT count(*) AS count FROM industry_update").get().count, 12);
  assert.equal(db.prepare("SELECT count(*) AS count FROM event").get().count, 12);
  const acceptance = getIndustryWeeklyAcceptance(db, "construction", new Date("2026-08-01T01:00:00.000Z"));
  assert.equal(acceptance.accepted, true);
  assert.equal(acceptance.acceptedAtWeek, "2026-07-27");
  assert.equal(acceptance.maxConsecutiveWeeks, 4);
  assert.deepEqual(acceptance.recentWeeks.map(week => week.selected), [3, 3, 3, 3]);
  assert.deepEqual(ingestIndustryWeekly(db, collection), { inserted: 0, existing: 12 });
  assert.equal(db.prepare("SELECT count(*) AS count FROM industry_update").get().count, 12);
  db.close();
});

test("选择时间只在首次确认时记录，重复提交不改写验收周", () => {
  const db = database();
  const collection = collectIndustryWeeklyFeed("construction", content);
  const selected = batch(collection, 0, 1);
  ingestIndustryWeekly(db, selected);
  promoteIndustryUpdateToEvent(db, selected.updates[0].record.id, undefined, "2026-08-03T01:00:00.000Z");
  promoteIndustryUpdateToEvent(db, selected.updates[0].record.id, undefined, "2026-08-20T01:00:00.000Z");
  const row = db.prepare("SELECT promoted_at FROM industry_update WHERE id=?").get(selected.updates[0].record.id);
  assert.equal(row.promoted_at, "2026-08-03T01:00:00.000Z");
  db.close();
});

test("旧数据库会补上选择时间字段，但不会伪造历史选择时间", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE industry_update (id TEXT PRIMARY KEY, promoted_to_event_id TEXT)");
  ensureIndustryWeeklySchema(db);
  const columns = db.prepare("PRAGMA table_info(industry_update)").all().map(column => column.name);
  assert.ok(columns.includes("promoted_at"));
  assert.equal(db.prepare("SELECT count(*) AS count FROM industry_update WHERE promoted_at IS NOT NULL").get().count, 0);
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
  promoteIndustryUpdateToEvent(db, collection.updates[0].record.id, undefined, "2026-08-03T01:00:00.000Z");
  const html = renderIndustryWeeklyHtml(db, "construction", "2026-07-01", "2026-08-31", new Date("2026-08-03T02:00:00.000Z"));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /target_action/);
  assert.match(html, /已选为有用/);
  assert.match(html, /选为有用信息/);
  assert.match(html, /本页已选择 1 \/ 至少 3 条/);
  assert.match(html, /最长连续 0 \/ 4 周达标/);
  assert.match(html, /2026-08-03 — 2026-08-09（本周）/);
  assert.match(html, /href="https:\/\/www\.glodon\.com/);
  db.close();
});

test("没有预设目标客户的行业条目可由 FDE 在页面选择客户", () => {
  const db = database();
  const collection = collectIndustryWeeklyFeed("construction", content);
  const selected = batch(collection, 0, 1);
  selected.updates[0].record.companyId = "";
  delete selected.updates[0].evidence.company_id;
  ingestIndustryWeekly(db, selected);
  const html = renderIndustryWeeklyHtml(db, "construction", "2026-07-01", "2026-08-31", new Date("2026-08-03T02:00:00.000Z"));
  assert.match(html, /select name="companyId" required/);
  assert.match(html, /广联达科技股份有限公司/);
  const eventId = promoteIndustryUpdateToEvent(db, selected.updates[0].record.id, "002410.SZ", "2026-08-03T01:00:00.000Z");
  assert.equal(db.prepare("SELECT company_id FROM event WHERE id=?").get(eventId).company_id, "002410.SZ");
  db.close();
});

test("行业条目不能通过手工请求写入其他行业客户", () => {
  const db = database();
  db.prepare("INSERT INTO industry (id, name) VALUES (?, ?)").run("cloud", "云计算");
  db.prepare("INSERT INTO company (id, name, industry_id) VALUES (?, ?, ?)").run("cloud-company", "云客户", "cloud");
  const collection = collectIndustryWeeklyFeed("construction", content);
  const selected = batch(collection, 0, 1);
  selected.updates[0].record.companyId = "";
  delete selected.updates[0].evidence.company_id;
  ingestIndustryWeekly(db, selected);
  assert.throws(
    () => promoteIndustryUpdateToEvent(db, selected.updates[0].record.id, "cloud-company", "2026-08-03T01:00:00.000Z"),
    /同行业客户/,
  );
  db.close();
});
