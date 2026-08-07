// 纪律内核的行为测试。这些断言是"换本体不许换纪律"这句话的可执行版本：
// 如果谁把某道门放宽、把归因门槛调低、或让管线候选直接过闸，这里必须红。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.mjs";

const outDir = buildKernel();
const require = createRequire(import.meta.url);
const core = require(`${outDir}/field-core.js`);
const ontology = require(`${outDir}/ontology.js`);
const graph = require(`${outDir}/graph.js`);

const RULES = ontology.RELATIONS.map(item => ({ id: item.id, words: item.words }));
const future = new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10);

/** 一条把六道门全部填满的情报。 */
function fullySigned(overrides = {}) {
  const scope = {};
  for (const field of ontology.SCOPE_FIELDS) scope[field.key] = "已填写";
  return core.makeSignal({
    title: "A 增资入股 B",
    evidence: "公告披露 A 公司以现金 3.2 亿元认购 B 公司新增注册资本，交割后持股 18.4%。",
    source: "巨潮资讯网公告",
    constraints: {
      scope, epistemicState: "interpretation", falsifier: "工商登记未变更即推翻",
      counterEvidence: "存在同期反向减持公告", sourceType: "independent",
      validUntil: future, probability: 70, signedOff: true, ...overrides,
    },
  }, core.initialWeights, RULES);
}

test("六道门全填才可执行", () => {
  const gate = core.gateState(fullySigned());
  assert.equal(gate.passed, 6);
  assert.equal(gate.executable, true);
  assert.equal(core.GATE_LABELS.length, 6);
});

test("每一道门都是否决权：单独拆掉任意一道都不可执行", () => {
  const broken = [
    { key: "原始证据", signal: { ...fullySigned(), evidence: "太短" } },
    { key: "本地边界", signal: fullySigned({ scope: { ...fullySigned().constraints.scope, [ontology.SCOPE_FIELDS[0].key]: "" } }) },
    { key: "证伪 / 反例", signal: fullySigned({ falsifier: "" }) },
    { key: "反例单独缺失", signal: fullySigned({ counterEvidence: "" }) },
    { key: "来源谱系", signal: fullySigned({ sourceType: "unknown" }) },
    { key: "有效期缺失", signal: fullySigned({ validUntil: "" }) },
    { key: "专家签署", signal: fullySigned({ signedOff: false }) },
  ];
  for (const item of broken) {
    assert.equal(core.gateState(item.signal).executable, false, `${item.key} 被拆掉后仍可执行`);
  }
});

test("过期的来源等于没有来源", () => {
  const expired = fullySigned({ validUntil: "2020-01-01" });
  assert.equal(core.isExpired(expired), true);
  assert.equal(core.gateState(expired).executable, false);
});

test("有效期填今天，当天全天有效——不能因为时区把日期解析成 UTC 零点", () => {
  // 回归：new Date("YYYY-MM-DD") 按 UTC 零点解析，在 UTC+8 下"今天到期"
  // 从早上八点起就被判失效，第 5 道门无缘无故关掉。有效期是日期，不是时刻。
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const signal = fullySigned({ validUntil: today });
  assert.equal(core.isExpired(signal), false, "今天到期的情报在今天之内不算过期");
  assert.equal(core.gateState(signal).states[4], true, "来源/时效门应当通过");
  assert.equal(core.gateState(signal).executable, true);

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const stale = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
  assert.equal(core.isExpired(fullySigned({ validUntil: stale })), true, "昨天到期就是过期");
});

test("执行质量低于 60 时结果只记录，不改写权重", () => {
  const signal = fullySigned();
  const low = core.attribute(signal, core.initialWeights, "confirmed", 59);
  assert.equal(low.attributable, false);
  assert.deepEqual(low.nextWeights, core.initialWeights);
  assert.equal(low.weightChange, "执行质量不足，不归因");

  const high = core.attribute(signal, core.initialWeights, "confirmed", 60);
  assert.equal(high.attributable, true);
});

test("反例把权重反向修正，支持则正向", () => {
  const signal = fullySigned();
  signal.dimensions = signal.dimensions.map((item, index) => ({ ...item, score: index === 0 ? 90 : 40 }));
  const up = core.attribute(signal, core.initialWeights, "confirmed", 80);
  const down = core.attribute(signal, core.initialWeights, "counter", 80);
  assert.ok(up.nextWeights[0] > core.initialWeights[0], "支持结果应抬高高分维度权重");
  assert.ok(down.nextWeights[0] < core.initialWeights[0], "反例应压低高分维度权重");
});

test("单一维度无法独裁：极端输入被夹回可比区间", () => {
  // 原版实现是"先夹紧 12–40，再归一化"，所以归一化后的值可以超过 40，
  // 上界是 40/(40+12×3)≈52.6%。这里守住的是比例上界，不是夹紧后的原始数字。
  const extreme = core.normalizeWeights([100, 0, 0, 0]);
  for (const value of extreme) { assert.ok(value >= 15 && value <= 53, `权重越界: ${value}`); }
  assert.ok(Math.abs(extreme.reduce((sum, value) => sum + value, 0) - 100) <= 2, "归一化后总和应接近 100（取整存在 ±1 漂移）");
  assert.ok(extreme[0] < 100, "任一维度都不能吃掉全部权重");
});

test("Brier 打分：判断越准误差越小，观察态自比为 0", () => {
  const confident = fullySigned({ probability: 90 });
  assert.equal(core.attribute(confident, core.initialWeights, "confirmed", 80).brierScore, 1);
  assert.equal(core.attribute(confident, core.initialWeights, "counter", 80).brierScore, 81);
  assert.equal(core.attribute(confident, core.initialWeights, "watching", 80).brierScore, 0);
});

test("管线候选结构性卡在来源门：假设 + 同源 + 无有效期", () => {
  const candidate = core.makeSignal({
    title: "C 向 D 供货",
    evidence: "报道称 C 公司为 D 公司提供电芯，2026 年上半年出货占其采购量的四成以上。",
    source: "行业媒体报道",
    origin: "pipeline",
    constraints: { ...core.emptyConstraints(), epistemicState: "hypothesis", sourceType: "related" },
  }, core.initialWeights, RULES);
  const gate = core.gateState(candidate);
  assert.equal(gate.executable, false);
  assert.equal(gate.states[4], false, "来源/时效门必须失败：related 无有效期");
  assert.equal(gate.states[5], false, "专家签署门必须失败");
  assert.equal(candidate.origin, "pipeline");
});

test("推演产物和管线候选走同一条隔离路径，且能被认出来", () => {
  // Phase 5：沙盘输出必须和抓取来的东西一样卡在第 5 道门，
  // 同时 origin 要保留 simulation——否则库里分不清"我猜的"和"我查到的"。
  const simulated = core.makeSignal({
    title: "[推演] E 独家配套 F 的固态电池",
    evidence: "（假设）若该场景成立，应能在整车厂定点公告或供应商名录中看到 E 被列为独家配套方。",
    source: "沙盘推演：某头部电池厂切入固态电池",
    origin: "simulation",
    constraints: { ...core.emptyConstraints(), epistemicState: "hypothesis", sourceType: "related" },
  }, core.initialWeights, RULES);
  const gate = core.gateState(simulated);
  assert.equal(gate.executable, false, "推演产物永远不能可执行");
  assert.equal(gate.states[4], false, "来源门必须失败：推演没有真实来源");
  assert.equal(gate.states[5], false, "签署门必须失败");
  assert.equal(simulated.origin, "simulation", "推演标记不能被覆盖成 pipeline");
  assert.ok(simulated.title.startsWith("[推演]"), "标题必须带推演前缀");
});

test("给推演补上真实来源和签署后才能过闸——这是唯一的出路", () => {
  // 推演本身不能过闸，但它指出的东西被真实证据坐实后应当可以。
  // 换句话说：沙盘是待办清单，不是死胡同。
  const scope = {};
  for (const field of ontology.SCOPE_FIELDS) scope[field.key] = "已填写";
  const verified = core.makeSignal({
    title: "[推演] E 独家配套 F 的固态电池",
    evidence: "定点公告确认 E 公司成为 F 汽车固态电池独家配套供应商，供货周期 2027 至 2029 年。",
    source: "F 汽车定点公告",
    origin: "simulation",
    constraints: {
      scope, epistemicState: "interpretation", falsifier: "供应商名录未出现 E 即推翻",
      counterEvidence: "存在第二家配套方的招标记录", sourceType: "independent",
      validUntil: future, probability: 65, signedOff: true,
    },
  }, core.initialWeights, RULES);
  assert.equal(core.gateState(verified).executable, true, "补齐六道门后应当可执行");
  assert.equal(verified.origin, "simulation", "出身不会因为过闸而被改写");
});

test("候选度只给方向，不给许可", () => {
  const strong = core.makeSignal({
    title: "持股 并购 增资 收购 控股",
    evidence: "持股、并购、增资、收购、控股、供货、采购、专利授权同时出现的一段长语料，用来把候选度推到高位。",
    source: "测试语料",
  }, core.initialWeights, RULES);
  assert.ok(strong.candidateScore > 50, "关键词密集时候选度应该高");
  assert.equal(core.gateState(strong).executable, false, "候选度再高也不能自己过闸");
});

test("关系图的边只反映过闸数，不反映概率", () => {
  const admitted = fullySigned();
  admitted.edges = [{ from: "A 公司", to: "B 公司", relation: "equity", direction: "forward" }];
  const rumor = core.makeSignal({
    title: "传闻 E 收购 F",
    evidence: "市场传闻 E 公司正在洽谈收购 F 公司，双方均未确认，无公告支持。",
    source: "社交媒体",
    edges: [{ from: "E 公司", to: "F 公司", relation: "equity", direction: "forward" }],
    constraints: { probability: 95 },
  }, core.initialWeights, RULES);

  const built = graph.buildGraph([admitted, rumor], []);
  assert.equal(built.edges.length, 2);
  assert.equal(built.nodes.length, 4);
  const solid = built.edges.find(edge => edge.from === "A 公司");
  const dashed = built.edges.find(edge => edge.from === "E 公司");
  assert.equal(solid.executable, true);
  assert.equal(dashed.executable, false, "概率 95% 但零约束的边不得可执行");
  assert.equal(graph.edgeTone(solid), "#41c6cc");
  assert.notEqual(graph.edgeTone(dashed), "#41c6cc");
});

test("同一条边被多份情报支撑时取最高过闸数并合并出处", () => {
  const weak = core.makeSignal({
    title: "A 与 B 有股权关系（弱证据）", evidence: "有资料显示 A 公司与 B 公司存在股权关联，细节不详。",
    source: "二手资料", edges: [{ from: "A 公司", to: "B 公司", relation: "equity", direction: "forward" }],
  }, core.initialWeights, RULES);
  const strong = fullySigned();
  strong.edges = [{ from: "A 公司", to: "B 公司", relation: "equity", direction: "forward" }];

  const built = graph.buildGraph([weak, strong], []);
  assert.equal(built.edges.length, 1, "同向同类型的边应合并");
  assert.equal(built.edges[0].signalIds.length, 2);
  assert.equal(built.edges[0].bestGate, 6);
  assert.equal(built.edges[0].executable, true);
});

test("关系类型筛选只影响可见性，不影响过闸", () => {
  const signal = fullySigned();
  signal.edges = [{ from: "A 公司", to: "B 公司", relation: "equity", direction: "forward" }];
  assert.equal(graph.buildGraph([signal], ["supply"]).edges.length, 0);
  assert.equal(graph.buildGraph([signal], ["equity"]).edges.length, 1);
});

test("图布局稳定可复现", () => {
  const signal = fullySigned();
  signal.edges = [{ from: "A 公司", to: "B 公司", relation: "equity", direction: "forward" }];
  assert.deepEqual(graph.buildGraph([signal], []).nodes, graph.buildGraph([signal], []).nodes);
});

test("本体是四维五关系，且换本体不动内核签名", () => {
  assert.equal(ontology.DIMENSIONS.length, 4);
  assert.equal(ontology.RELATIONS.length, 5);
  assert.equal(ontology.SCOPE_FIELDS.length, 5);
  assert.equal(core.initialWeights.length, ontology.DIMENSIONS.length);
  assert.deepEqual(Object.keys(core.emptyConstraints().scope).sort(), ontology.SCOPE_FIELDS.map(item => item.key).sort());
});
