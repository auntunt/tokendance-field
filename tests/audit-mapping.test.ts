// 审计器自身的对照测试。
// 0/207 这个结论只有在映射器"没有偷偷放宽也没有偷偷收紧"时才成立，
// 所以这里正反两向都要验：给足材料必须过，材料有缺必须卡在对应那道门。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.ts";
import { cardToSignal, readEpistemicState, buildEvidence } from "../audit/card-to-signal.ts";
import { gradeUrl, gradeSources } from "../audit/source-grade.ts";

const outDir = buildKernel();
const require = createRequire(import.meta.url);
const core = require(`${outDir}/field-core.js`);
const onto = require(`${outDir}/ontology.js`);
const rules = onto.RELATIONS.map(r => ({ id: r.id, words: r.words }));
const gate = seed => core.gateState(core.makeSignal(seed, core.initialWeights, rules, "t"));

/** 一张材料齐全的理想卡片。用于验证审计器不是"永远返回不通过"的死程序。 */
const FULL_CARD = {
  id: 999, name: "某某科技有限公司", name_raw: "某某科技有限公司",
  sector_raw: "工业视觉", channel_raw: "L1 政府目录", channel_label: "政府目录",
  city: "苏州", macro_region: "华东", confidence: 4,
  narrative: "公开招标公告显示该公司中标某产线视觉检测项目，合同金额 480 万元，交付期 180 天。",
  deliverable: "产线视觉检测系统", founder_detail: "", funding_detail: "", filing: "",
  risk: "若中标公告被撤销或合同未实际履行，则本判断不成立",
  edge_reason: "同批次另有两家报价更低者未中标，存在评标口径差异",
  sources: ["https://www.ggzy.gov.cn/notice/123456.html"],
};

test("对照组：材料齐全 + 人工字段补齐 → 必须六门全过", () => {
  const seed = cardToSignal(FULL_CARD);
  const patched = {
    ...seed,
    constraints: {
      ...seed.constraints,
      scope: { ...seed.constraints.scope, dataBasis: "中标金额口径", timeWindow: "2026 年内", ourAccess: "客户方采购总监认识" },
      validUntil: "2099-12-31", signedOff: true,
    },
  };
  const g = gate(patched);
  assert.equal(g.executable, true, `对照组应全过，实际只过 ${g.passed} 门：${JSON.stringify(g.states)}`);
});

test("审计器未放宽：老数据原样映射时，门 2/4/5/6 必须全部不过", () => {
  const g = gate(cardToSignal(FULL_CARD));
  assert.equal(g.states[0], true, "证据充足时门 1 应过");
  assert.equal(g.states[1], false, "老数据无口径/时窗/杠杆，门 2 不该过");
  assert.equal(g.states[4], false, "老数据无有效期，门 5 不该过");
  assert.equal(g.states[5], false, "老数据无签署，门 6 不该过");
  assert.equal(g.executable, false);
});

test("门 1：只有标签没有正文的表行必须不过", () => {
  const bare = { ...FULL_CARD, narrative: "", deliverable: "", founder_detail: "", funding_detail: "", filing: "" };
  assert.equal(buildEvidence(bare), "");
  assert.equal(gate(cardToSignal(bare)).states[0], false);
});

test("「去某站搜XX」不是来源，必须判 unknown", () => {
  assert.equal(gradeUrl('https://36kr.com/p（搜"砖助智连"').type, "unknown");
  assert.equal(gradeUrl("https://www.qcc.com（搜\"美象信息科技有限公司\"").type, "unknown");
});

test("来源判级按发布方类型，不按知名度", () => {
  assert.equal(gradeUrl("https://www.ggzy.gov.cn/x/1.html").type, "independent", "招投标公告：采购人发布");
  assert.equal(gradeUrl("https://sheitc.sh.gov.cn/x/1.html").type, "independent", "政府域名");
  assert.equal(gradeUrl("https://pitchhub.36kr.com/project/2112241807796485").type, "related", "创投库项目页由项目方自填");
  assert.equal(gradeUrl("https://www.zhipin.com/gongsi/abc.html").type, "related", "招聘 JD 由企业自撰");
  assert.equal(gradeUrl("https://www.qcc.com/firm/abc.html").type, "related", "工商库含企业自填栏位");
  assert.equal(gradeUrl("https://mp.weixin.qq.com/s?__biz=x").type, "unknown", "公众号无法判定发布方");
});

test("聚合取最强一条，但全弱不得升级", () => {
  assert.equal(gradeSources(["https://www.qcc.com/a", "https://www.ggzy.gov.cn/b.html"]).type, "independent");
  assert.equal(gradeSources(["https://www.qcc.com/a", "https://www.zhipin.com/b"]).type, "related");
  assert.equal(gradeSources(["https://mp.weixin.qq.com/s?x=1"]).type, "unknown");
  assert.equal(gradeSources([]).type, "unknown", "没有来源不能算弱来源，只能算未知");
});

test("认识状态从老数据标记读取，不猜", () => {
  assert.equal(readEpistemicState({ narrative: "已披露中标" }), "observation");
  assert.equal(readEpistemicState({ founder_raw: "依托某院士体系【推测】" }), "interpretation");
  assert.equal(readEpistemicState({ funding_detail: "A 轮【待核实】" }), "hypothesis");
});

test("★ 星级只影响 probability，绝不影响过闸", () => {
  const five = cardToSignal({ ...FULL_CARD, confidence: 5 });
  const two = cardToSignal({ ...FULL_CARD, confidence: 2 });
  assert.equal(five.constraints.probability, 100);
  assert.equal(two.constraints.probability, 40);
  assert.deepEqual(gate(five).states, gate(two).states, "星级不同但过闸判定必须一致");
});

test("模型不得代签：cardToSignal 永不产出 signedOff=true", () => {
  for (const stars of [null, 2, 3, 4, 5]) {
    assert.equal(cardToSignal({ ...FULL_CARD, confidence: stars }).constraints.signedOff, false);
  }
});
