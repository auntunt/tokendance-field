// 名单种子的行为测试。
//
// 这个文件的唯一风险是**从记忆里写事实**：名单是我手写的，没有抓取过程，
// 所以任何数字、任何「他们有多少 FDE」写进去都会以最高可信度出现在报告里，
// 且没有出处可被反驳。下面的断言把这条红线变成可执行的。
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildKernel } from "./build-kernel.ts";

const outDir = buildKernel();
const require = createRequire(import.meta.url);
const roster = require(`${outDir}/fde-roster.js`);
const profileLib = require(`${outDir}/company-profile.js`);
const importer = require(`${outDir}/corpus-import.js`);
const dims = require(`${outDir}/fde-dimensions.js`);

const FETCHED = "2026-08-09";
const sourcePath = fileURLToPath(new URL("../lib/fde-roster.ts", import.meta.url));

test("名单覆盖美股 / A股 / 港股 / 未上市四类，缺一类就说明覆盖范围没做到", () => {
  const listings = new Set(roster.ROSTER.map(item => item.listing));
  for (const wanted of ["us", "cn-a", "hk", "private"]) {
    assert.ok(listings.has(wanted), `名单里没有 ${profileLib.LISTING_LABEL[wanted]}`);
  }
});

test("每条都要有抓取入口和可反驳的入选理由", () => {
  for (const entry of roster.ROSTER) {
    assert.ok(entry.fetch && entry.fetch.length >= 2, `${entry.name} 抓取入口不足，无人化就落不了地`);
    assert.ok(entry.hypothesis && entry.hypothesis.length >= 10, `${entry.name} 没写为什么入选`);
    assert.equal(entry.basis, "hypothesis", `${entry.name} 的依据必须标成待核实猜测`);
  }
});

test("上市公司必须有代码或明确留空，且未上市的不许编代码", () => {
  for (const entry of roster.ROSTER) {
    if (entry.listing === "private") {
      assert.equal(entry.ticker, undefined, `${entry.name} 未上市却带了股票代码`);
    }
  }
  const listed = roster.ROSTER.filter(item => item.listing !== "private");
  assert.ok(listed.every(item => item.ticker), "上市公司条目应带代码，抓取器要靠它去交易所取披露");
});

test("名单转成的档案里一格事实都没有——facts 必须为空", () => {
  const profiles = importer.importRoster(roster.ROSTER, FETCHED);
  assert.equal(profiles.length, roster.ROSTER.length);
  for (const profile of profiles) {
    const cover = profileLib.coverageOf(profile);
    assert.equal(cover.filled, 0, `${profile.name} 的名单条目带了事实，那是凭记忆写的，没有出处`);
    assert.deepEqual(profile.facts, {}, `${profile.name} 的 facts 不为空`);
  }
});

test("名单里的相关度只能是猜测，档案里一律先记待判定", () => {
  const profiles = importer.importRoster(roster.ROSTER, FETCHED);
  for (const profile of profiles) {
    assert.equal(profile.relevance, "unclear", `${profile.name} 未经核实就被定级了`);
    assert.match(profile.relevanceReason, /待核实/, `${profile.name} 的理由没标明这是未核实的`);
  }
});

test("源码里不许出现具体数字型断言——那种句子只可能是凭记忆编的", () => {
  // 只查 hypothesis / name 这类会进报告的文本字段，不查 ticker 和注释。
  for (const entry of roster.ROSTER) {
    assert.doesNotMatch(entry.hypothesis, /\d+\s*(名|人|个|亿|万|%|％)/, `${entry.name} 的入选理由里带了具体数字：「${entry.hypothesis}」。数字必须来自抓取，不能来自记忆`);
  }
});

test("源码里不许出现 Sourced 结构——名单文件没有资格产出带出处的事实", async () => {
  const text = await readFile(sourcePath, "utf8");
  const body = text.split("\n").filter(line => !line.trim().startsWith("//") && !line.trim().startsWith("*")).join("\n");
  for (const word of ["grade:", "fetchedAt", "statutory", "facts"]) {
    assert.doesNotMatch(body, new RegExp(word), `名单文件出现 ${word}，说明它在自己造事实`);
  }
});

test("和现有 207 家合并后 id 不冲突", () => {
  const rosterProfiles = importer.importRoster(roster.ROSTER, FETCHED);
  const fake207 = Array.from({ length: 207 }, (_, index) => importer.importCompany({ id: index + 1, name: `旧 ${index + 1}` }, FETCHED));
  const ids = [...fake207, ...rosterProfiles].map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, "id 冲突会让合并时互相覆盖");
});

test("名单规模够启动，且维度清单能容纳它——两边字段对得上", () => {
  assert.ok(roster.ROSTER.length >= 20, `名单太短，现在 ${roster.ROSTER.length} 家`);
  const profiles = importer.importRoster(roster.ROSTER, FETCHED);
  const cover = profileLib.coverageOf(profiles[0]);
  assert.equal(cover.total, dims.ALL_FIELDS.length);
});
