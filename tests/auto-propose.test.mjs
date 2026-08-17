// 自动提议的行为测试。这些断言是「机器把能算的算完，但不许伪造确定性」的可执行版本。
//
// 背景：实测 60 条真实情报 0 条过闸。查出来卡点是门 5 要的 validUntil
// 全项目没有任何自动来源。补上提议器之后，最容易走歪的方向有两个，这里各盯一条：
//   1. 提议器为了让东西过闸而编内容（填「未知」、编日期、把弱来源标成强来源）；
//   2. 提议器顺手把签字也预填了，那六道门就废了。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.mjs";

const outDir = buildKernel();
const require = createRequire(import.meta.url);
const propose = require(`${outDir}/auto-propose.js`);
const core = require(`${outDir}/field-core.js`);
const ontology = require(`${outDir}/ontology.js`);

const RULES = ontology.RELATIONS.map(item => ({ id: item.id, words: item.words }));
const NOW = new Date(2026, 7, 9); // 2026-08-09，固定住，否则断言随真实日期漂移

const DISCLOSURE = {
  title: "甲方受让乙方 35% 股权",
  evidence: "2026年3月18日，广东甲方新材料股份有限公司与乙方精密制造有限公司签署股权转让协议，受让后者 35% 股权，转让价款以经审计的净资产为基础确定。本次交易完成后，公司持股比例由 0% 变更为 35%。交易涉及华南地区产能整合。",
  source: "巨潮资讯网",
  sourceUrl: "https://www.cninfo.com.cn/new/disclosure/detail?stockCode=000001",
  suggestedRelation: "equity",
  edges: [{ from: "广东甲方新材料股份有限公司", to: "乙方精密制造有限公司", relation: "equity" }],
};

test("有效期一定被填上，且落在将来", () => {
  const { constraints } = propose.proposeConstraints(DISCLOSURE, NOW);
  assert.ok(constraints.validUntil, "validUntil 没被提议——这正是 60 条全卡住的原因");
  assert.match(constraints.validUntil, /^\d{4}-\d{2}-\d{2}$/);
  const signal = core.makeSignal({ ...DISCLOSURE, constraints }, core.initialWeights, RULES);
  assert.equal(core.isExpired(signal), false, "提议出来就已过期，等于没提议");
});

test("有效期按关系类型给不同半衰期：股权比竞争长", () => {
  const equity = propose.proposeConstraints({ ...DISCLOSURE, suggestedRelation: "equity" }, NOW);
  const compete = propose.proposeConstraints({ ...DISCLOSURE, suggestedRelation: "compete" }, NOW);
  assert.ok(equity.constraints.validUntil > compete.constraints.validUntil,
    `股权 ${equity.constraints.validUntil} 应晚于竞争 ${compete.constraints.validUntil}`);
});

test("语料很旧时也不给出已过期的有效期", () => {
  const stale = { ...DISCLOSURE, evidence: "2009年1月5日，双方签署协议，涉及全国范围的营业收入分成。".padEnd(60, "。") };
  const { constraints } = propose.proposeConstraints(stale, NOW);
  const signal = core.makeSignal({ ...stale, constraints }, core.initialWeights, RULES);
  assert.equal(core.isExpired(signal), false);
});

test("事实时点取语料里最晚的那个日期，且不取未来日期", () => {
  const text = "公司于2018年6月1日设立。2026年3月18日签署本次协议。计划2030年12月31日投产。";
  assert.equal(propose.latestDateIn(text, NOW), "2026-03-18");
  assert.equal(propose.latestDateIn("没有任何日期", NOW), null);
});

test("来源只给提示，绝不自动写进 sourceType", () => {
  // independent 不只过门 5，market-map 还按它筛可信来源。
  // 让提议器按 URL 自动标 independent，就是让管线自我认证强来源。
  assert.equal(propose.sourceHint(DISCLOSURE), "disclosure");
  assert.equal(propose.sourceHint({ ...DISCLOSURE, sourceUrl: "https://finance.sina.com.cn/a/b.html" }), "aggregator");
  assert.equal(propose.sourceHint({ ...DISCLOSURE, sourceUrl: "https://www.some-vendor-blog.example/post" }), "other");
  assert.equal(propose.sourceHint({ ...DISCLOSURE, sourceUrl: undefined }), "none");

  const { constraints } = propose.proposeConstraints(DISCLOSURE, NOW);
  assert.equal(constraints.sourceType, undefined,
    "提议器写了 sourceType——法定披露也不许自动标成独立第三方");
});

test("推不出来的字段留空，绝不填「未知」", () => {
  const bare = { title: "两家公司有合作", evidence: "据了解，两家公司在业务上存在合作关系，具体情况尚不清楚。", source: "某消息", edges: [] };
  const { constraints, left } = propose.proposeConstraints(bare, NOW);
  for (const [key, value] of Object.entries(constraints.scope)) {
    assert.equal(core.isPlaceholder(value) ? "空或占位" : "有内容",
      value ? "有内容" : "空或占位", `${key} 填了占位词：${value}`);
    if (value) assert.equal(core.isPlaceholder(value), false, `${key} 的值是占位词：${value}`);
  }
  assert.ok(left.length > 0, "什么都推不出来时却报告一项不缺");
});

test("我方能拿它做什么永远不自动填——那是关于我们自己的判断", () => {
  const { constraints, left } = propose.proposeConstraints(DISCLOSURE, NOW);
  assert.equal(constraints.scope.ourAccess, "");
  assert.ok(left.includes("我们能拿它做什么"));
});

test("提议永远不碰签字，也不碰证伪/反例", () => {
  const { constraints } = propose.proposeConstraints(DISCLOSURE, NOW);
  assert.notEqual(constraints.signedOff, true, "提议器预填了签字——六道门就废了");
  assert.equal(constraints.falsifier, undefined);
  assert.equal(constraints.counterEvidence, undefined);
});

/** 复刻 signal-console.tsx 里 acceptCandidates 的真实写入：
 *  提议器给的字段 + 管线一律隔离成 hypothesis / related。
 *  提议器自己不给 sourceType，所以门 5 的另一半来自这里。 */
function asIntakeWrites(input, now) {
  const { constraints } = propose.proposeConstraints(input, now);
  return core.makeSignal({
    ...input,
    constraints: { ...constraints, epistemicState: "hypothesis", sourceType: "related" },
  }, core.initialWeights, RULES);
}

test("走完自动提议后，门 5 过了——这是 60 条全卡住的那道门", () => {
  const signal = asIntakeWrites(DISCLOSURE, NOW);
  const state = core.gateState(signal);
  assert.equal(state.states[0], true, "原始证据没过——抽取器本该已经给足");
  assert.equal(state.states[4], true, "来源/时效没过——提议器的主要目的就是这道门");
});

test("提议过的情报仍然过不了闸：还差证伪/反例、我方用途、签字", () => {
  const signal = asIntakeWrites(DISCLOSURE, NOW);
  assert.equal(core.gateState(signal).executable, false, "自动提议把情报直接送过闸了");
  const missing = core.missingGates(signal).map(item => item.index);
  assert.deepEqual(missing, [1, 3, 5], `还缺的门应是 本地边界/证伪反例/签署，实际 ${missing}`);
});

test("提议器不许把六道门全填满：签字前必须还剩人要做的事", () => {
  // 这条是防线：以后谁想\"让它更自动\"，把 ourAccess 或 falsifier 也自动填上，
  // 这里会红。机器可以把材料备齐，但不能替人做判断。
  const signal = asIntakeWrites(DISCLOSURE, NOW);
  assert.ok(core.missingGates(signal).length >= 2,
    "自动提议之后只差签字了——那签字就退化成一个走过场的按钮");
});

test("门 2 把「未知」当没填：占位词不许假过闸", () => {
  assert.equal(core.isPlaceholder("未知"), true);
  assert.equal(core.isPlaceholder("  待确认。"), true);
  assert.equal(core.isPlaceholder("N/A"), true);
  assert.equal(core.isPlaceholder(""), true);
  // 有信息的句子不许被误判成占位
  assert.equal(core.isPlaceholder("股权比例未知，但持股关系明确"), false);
  assert.equal(core.isPlaceholder("华南地区"), false);
  // 「无」「没有」是真答案，不是占位。ourAccess 的字段提示原文就是「没有就写没有」，
  // 「我方接触不到任何人」是有决策含量的结论。当成没填会逼人编一个用途出来。
  for (const answer of ["无", "没有", "暂无"]) {
    assert.equal(core.isPlaceholder(answer), false, `「${answer}」被当成没填了`);
  }

  const scope = {};
  for (const field of ontology.SCOPE_FIELDS) scope[field.key] = "已填写";
  scope.dataBasis = "未知";
  const signal = core.makeSignal({ ...DISCLOSURE, constraints: { scope } }, core.initialWeights, RULES);
  assert.equal(core.gateState(signal).states[1], false, "范围里填「未知」却过了门 2");
});

test("同一批语料，提议结果稳定可复现", () => {
  const a = propose.proposeConstraints(DISCLOSURE, NOW);
  const b = propose.proposeConstraints(DISCLOSURE, NOW);
  assert.deepEqual(a, b);
});
