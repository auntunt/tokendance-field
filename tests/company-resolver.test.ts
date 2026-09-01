// 模糊商业信息查询：线索抽取、本地召回、大模型回退边界。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.ts";

const require = createRequire(import.meta.url);
const outDir = buildKernel();
const { extractClues, recallCompanies, resolveCompany, buildSearchQueries } = require(`${outDir}/company-resolver.js`);
const { extractEntityName } = require(`${outDir}/query-intake.js`);

test("把一句话里的地址、业务、上市、控股线索分别切出来", () => {
  const clues = extractClues("广联达控股、今年上市了，在中关村孵化器23号楼，做的是工程绘图相关");
  const kinds = clues.map(c => c.kind);
  assert.ok(kinds.includes("ownership"));
  assert.ok(kinds.includes("listing"));
  assert.ok(kinds.includes("address"));
  assert.ok(kinds.includes("business"));
});

test("本地召回会优先找线索命中项，而不是只按名字硬凑", () => {
  const fragment = "食方科技，创始人在广联达干过，做食物智能计算";
  const name = extractEntityName(fragment);
  const clues = extractClues(fragment, name);
  const candidates = recallCompanies(name, clues);
  assert.ok(candidates.length > 0, "线索必须能召回至少一个本地候选");
  assert.ok(candidates.some(c => c.name.includes("食方科技")));
  // 所有返回的候选都要有可解释的理由，不能只有分数。
  for (const candidate of candidates) assert.ok(candidate.reason.length > 0);
});

test("精确查询不调模型，直接锁定名单公司", async () => {
  const result = await resolveCompany("科大讯飞的FDE", "科大讯飞", null);
  assert.equal(result.llmUsed, false);
  assert.equal(result.mode, "exact");
  assert.equal(result.candidates[0]?.name, "科大讯飞");
});

test("大模型不可用时回退到本地召回，不抛错", async () => {
  const result = await resolveCompany("只飞，广联达控股，今年上市，中关村孵化器23号楼，工程绘图", "只飞", null);
  assert.equal(result.llmUsed, false);
  assert.ok(Array.isArray(result.candidates));
  assert.ok(result.clues.some(c => c.kind === "business"));
});

test("搜索词会组合高区分度线索", () => {
  const queries = buildSearchQueries("中关村孵化器23号楼 工程绘图", "只飞", []);
  assert.ok(queries.length > 0);
  assert.ok(queries.some(q => q.includes("工程绘图")));
});
