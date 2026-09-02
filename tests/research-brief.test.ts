import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { buildKernel } from "./build-kernel.ts";

const require = createRequire(import.meta.url);
const outDir = buildKernel();
const { buildResearchBrief } = require(`${outDir}/research/brief.js`) as typeof import("../lib/research/brief.ts");

test("情报简报只把跨独立来源印证的主张列为可暂用结论", () => {
  const brief = buildResearchBrief({
    candidates: [
      { title: "已印证", evidence: "A", source: "公告", dimension: "business", validation: "corroborated" },
      { title: "待核", evidence: "B", source: "新闻", dimension: "fde", validation: "single-source" },
      { title: "转载", evidence: "C", source: "转载站", duplicate: true, validation: "repeated-copy" },
    ],
    failedPages: [{ url: "https://example.test/a", reason: "超时" }],
  });

  assert.equal(brief.verdict, "corroborated");
  assert.deepEqual(brief.usable.map(item => item.title), ["已印证"]);
  assert.deepEqual(brief.needsValidation.map(item => item.title), ["待核"]);
  assert.equal(brief.repeatedCopies, 1);
  assert.ok(brief.evidenceGaps.some(item => item.includes("未完成抽取")));
  assert.ok(brief.nextActions.some(item => item.includes("流程负责人")));
});
