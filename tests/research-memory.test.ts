import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const outDir = buildKernel();
const {
  beginResearchRun, completeResearchRun, linkRunSource, recordResearchClaim,
  recordResearchSource, researchOverview,
} = require(`${outDir}/research/repository.js`);

function source(db, url, contentHash, grade = "independent") {
  return recordResearchSource(db, {
    url,
    domain: new URL(url).hostname,
    title: `来源 ${url}`,
    grade,
    contentHash,
    contentText: `正文 ${contentHash}`,
    fetchedAt: "2026-08-26T08:00:00.000Z",
  });
}

function begin(db, id, fragment = "世纪互联 OCP") {
  beginResearchRun(db, {
    id,
    fragment,
    entityName: "世纪互联",
    dimensions: ["fde", "business"],
    provider: "xai",
    startedAt: "2026-08-26T08:00:00.000Z",
  });
}

test("不同独立来源、不同原文共同支撑同一关系时才算多源印证", () => {
  const db = new Database(":memory:");
  begin(db, "run-a");
  const first = source(db, "https://filing.example/a", "content-a", "statutory");
  const second = source(db, "https://press.example/b", "content-b", "independent");
  for (const [rank, sourceId] of [first, second].entries()) {
    linkRunSource(db, { runId: "run-a", sourceId, searchQuery: "世纪互联 OCP", dimension: "fde", rank: rank + 1, provider: "xai" });
  }
  const claim = {
    runId: "run-a", seenAt: "2026-08-26T08:05:00.000Z", title: "世纪互联参与 OCP 设计",
    evidence: "两份不同原文描述了同一关系", entityName: "世纪互联", dimension: "fde",
    edges: [{ from: "世纪互联", to: "OCP", relation: "license", direction: "forward" }],
  };
  assert.equal(recordResearchClaim(db, { ...claim, sourceId: first }).status, "single-source");
  const validation = recordResearchClaim(db, { ...claim, sourceId: second });
  assert.equal(validation.status, "corroborated");
  assert.equal(validation.independentSourceCount, 2);
  assert.equal(validation.distinctContentCount, 2);
  db.close();
});

test("两个域名发布同一正文只算同稿转载，不提高可信度", () => {
  const db = new Database(":memory:");
  begin(db, "run-copy");
  const first = source(db, "https://site-a.example/release", "same-wire-copy");
  const second = source(db, "https://site-b.example/repost", "same-wire-copy");
  const claim = {
    runId: "run-copy", seenAt: "2026-08-26T08:05:00.000Z", title: "同一篇通稿",
    evidence: "正文逐字一致", entityName: "世纪互联", dimension: "business", edges: [],
  };
  recordResearchClaim(db, { ...claim, sourceId: first });
  const validation = recordResearchClaim(db, { ...claim, sourceId: second });
  assert.equal(validation.status, "repeated-copy");
  assert.equal(validation.sourceCount, 2);
  assert.equal(validation.distinctContentCount, 1);
  db.close();
});

test("重复与相关查询通过共同实体、维度、来源和主张建立联系", () => {
  const db = new Database(":memory:");
  const shared = source(db, "https://source.example/ocp", "ocp-source");

  begin(db, "run-old", "世纪互联 OCP");
  linkRunSource(db, { runId: "run-old", sourceId: shared, searchQuery: "世纪互联 OCP", dimension: "fde", rank: 1, provider: "xai" });
  recordResearchClaim(db, { runId: "run-old", sourceId: shared, seenAt: "2026-08-26T08:05:00.000Z", title: "OCP 项目", evidence: "同一主张", entityName: "世纪互联", dimension: "fde", edges: [] });
  completeResearchRun(db, "run-old", "done", "2026-08-26T08:06:00.000Z");

  begin(db, "run-new", "世纪互联最近的数据中心设计");
  linkRunSource(db, { runId: "run-new", sourceId: shared, searchQuery: "世纪互联 数据中心", dimension: "fde", rank: 1, provider: "xai" });
  recordResearchClaim(db, { runId: "run-new", sourceId: shared, seenAt: "2026-08-26T09:05:00.000Z", title: "OCP 项目", evidence: "同一主张", entityName: "世纪互联", dimension: "fde", edges: [] });
  completeResearchRun(db, "run-new", "done", "2026-08-26T09:06:00.000Z");

  const overview = researchOverview(db);
  assert.equal(overview.stats.linkedQueries, 1);
  assert.equal(overview.links[0].from_run_id, "run-new");
  assert.ok(overview.links[0].strength >= 80);
  assert.equal(overview.links[0].shared_sources, 1);
  assert.equal(overview.links[0].shared_claims, 1);
  db.close();
});
