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
const { collectSearchCandidates } = require(`${outDir}/collectors/search-results.js`);
const { collectVendorCase } = require(`${outDir}/collectors/vendor-case.js`);
const { collectPeerCase, renderPeerBenchmarkTable } = require(`${outDir}/collectors/peer-case.js`);
const { ingestRelationshipCollection } = require(`${outDir}/dossier/m5-repository.js`);

const fixture = path => readFileSync(resolve(root, path), "utf8");

function peers() {
  return [
    collectPeerCase({
      companyId: "002410.SZ", companyName: "广联达科技股份有限公司", peerName: "Autodesk",
      url: "https://construction.autodesk.com/workflows/artificial-intelligence-construction/",
      content: fixture("tests/fixtures/peer-case/autodesk-forma-ai.txt"), publishedAt: "2026-09-01",
    }),
    collectPeerCase({
      companyId: "002410.SZ", companyName: "广联达科技股份有限公司", peerName: "Procore",
      url: "https://support.procore.com/products/online/user-guide/project-level/assist",
      content: fixture("tests/fixtures/peer-case/procore-assist.txt"), publishedAt: "2026-09-01",
    }),
  ];
}

test("搜索结果只形成带 URL 的候选，不直接写客户事实", () => {
  const result = collectSearchCandidates(fixture("tests/fixtures/search-results/glodon-peers.json"));
  assert.equal(result.candidates.length, 3);
  assert.ok(result.candidates.every(item => item.url.startsWith("https://")));
  assert.ok(result.candidates.some(item => item.url.includes("autodesk.com")));
  assert.equal("relationships" in result, false);
});

test("厂商案例必须同时出现客户与厂商才形成 IT 厂商关系", () => {
  const result = collectVendorCase({
    companyId: "600861.SH", companyName: "FESCO", vendorName: "蓝凌",
    url: "https://landray.com.cn/activity/96114",
    content: fixture("tests/fixtures/vendor-case/landray-fesco.txt"), publishedAt: "2026-02-11",
  });
  assert.equal(result.relationships[0].record.kind, "it_vendor");
  assert.equal(result.relationships[0].record.counterparty, "蓝凌");
  assert.throws(() => collectVendorCase({
    companyId: "x", companyName: "不存在的客户", vendorName: "蓝凌", url: "https://landray.com.cn/activity/96114",
    content: fixture("tests/fixtures/vendor-case/landray-fesco.txt"), publishedAt: "2026-02-11",
  }), /没有同时出现/);
});

test("已打开的案例页写 Relationship/Fact，搜索摘要不参与写入", () => {
  const db = new Database(":memory:");
  initializeDossierSchema(db);
  db.prepare("INSERT INTO company (id, name) VALUES (?, ?)").run("002410.SZ", "广联达科技股份有限公司");
  db.prepare("INSERT INTO company (id, name) VALUES (?, ?)").run("600861.SH", "FESCO");
  for (const peer of peers()) ingestRelationshipCollection(db, peer.relationship);
  const vendor = collectVendorCase({
    companyId: "600861.SH", companyName: "FESCO", vendorName: "蓝凌", url: "https://landray.com.cn/activity/96114",
    content: fixture("tests/fixtures/vendor-case/landray-fesco.txt"), publishedAt: "2026-02-11",
  });
  ingestRelationshipCollection(db, vendor);
  assert.equal(db.prepare("SELECT count(*) AS count FROM relationship").get().count, 3);
  assert.equal(db.prepare("SELECT count(*) AS count FROM fact WHERE \"table\"='relationship'").get().count, 9);
  assert.equal(db.prepare("SELECT count(*) AS count FROM source").get().count, 3);
  db.close();
});

test("同行或厂商页面不能凭空创建尚未建档的客户", () => {
  const db = new Database(":memory:");
  initializeDossierSchema(db);
  const peer = peers()[0];
  assert.throws(() => ingestRelationshipCollection(db, peer.relationship), /必须先建档客户/);
  assert.equal(db.prepare("SELECT count(*) AS count FROM company").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM source").get().count, 0);
  db.close();
});

test("M5 对照 M0 第 8 章的 Autodesk 与 Procore 无遗漏", () => {
  const benchmarks = peers().map(item => item.benchmark);
  const names = new Set(benchmarks.map(item => item.peer));
  assert.deepEqual(names, new Set(["Autodesk", "Procore"]));
  assert.match(benchmarks.find(item => item.peer === "Autodesk").products, /Autodesk Assistant/);
  assert.match(benchmarks.find(item => item.peer === "Autodesk").products, /Construction IQ/);
  assert.match(benchmarks.find(item => item.peer === "Procore").products, /Procore Assist/);
  const html = renderPeerBenchmarkTable(benchmarks);
  assert.match(html, /construction\.autodesk\.com/);
  assert.match(html, /support\.procore\.com/);
});
