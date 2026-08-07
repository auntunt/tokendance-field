// 人物测绘的纪律测试。人物是新实体，但纪律一条都不新开：
// 关于人的判断照样走六道门，切入排序不授权，PII 边界是字段白名单而非自觉。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.mjs";

const outDir = buildKernel();
const require = createRequire(import.meta.url);
const core = require(`${outDir}/field-core.js`);
const ontology = require(`${outDir}/ontology.js`);
const people = require(`${outDir}/people.js`);

const RULES = ontology.RELATIONS.map(item => ({ id: item.id, words: item.words }));
const future = new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10);

function person(overrides = {}) {
  return { id: "p1", createdAt: "2026-08-01", ...ontology.emptyPersonRole(), name: "李全（全哥）", employer: "广联达", department: "流程与数字化部", title: "总经理", ourPath: "", ...overrides };
}

/** 一条关于人的、六道门全过的判断。 */
function signedAboutPerson(overrides = {}) {
  const scope = {};
  for (const field of ontology.SCOPE_FIELDS) scope[field.key] = "已填写";
  return core.makeSignal({
    title: "李全是这条采购线的实际决策人",
    evidence: "两次投标复盘均显示技术选型由流程与数字化部先定，采购部仅走流程，李全在两次会上均做最终表态。",
    source: "客户方复盘会记录",
    constraints: {
      scope, epistemicState: "interpretation", falsifier: "发现预算实际由 IT 部门审批即推翻",
      counterEvidence: "上一单合同是韩小明签的", sourceType: "internal",
      humanSource: "客户方采购经理在 7/20 复盘会上口头提及",
      validUntil: future, probability: 65, signedOff: true, ...overrides,
    },
  }, core.initialWeights, RULES);
}

test("PII 边界是字段白名单：人物只承载公开职业事实", () => {
  // 这是代码级边界，不是注释里的自觉。加字段前先想清楚它是不是职务信息。
  const keys = Object.keys(ontology.emptyPersonRole());
  assert.deepEqual(keys.sort(), ["department", "employer", "name", "ourPath", "title"].sort());
  const banned = ["home", "address", "phone", "wechat", "family", "spouse", "birthday", "hobby", "salary", "私生活", "住址", "家庭"];
  for (const field of ontology.PERSON_FIELDS) {
    for (const word of banned) {
      assert.ok(!field.key.toLowerCase().includes(word.toLowerCase()), `人物字段不得承载 ${word}`);
    }
  }
});

test("人物关系类型只描述职权与工作关系", () => {
  const ids = ontology.PERSON_RELATIONS.map(item => item.id);
  assert.deepEqual(ids, ["reports_to", "decides", "influences", "moved_from", "co_serves"]);
  assert.equal(ontology.personRelationLabel("reports_to"), "汇报关系");
  assert.equal(ontology.personRelationLabel("drinking_buddy"), "待判定");
});

test("关于人的判断走同一套六道门，不因为对象是人就放松", () => {
  const gate = core.gateState(signedAboutPerson());
  assert.equal(gate.passed, 6);
  assert.equal(gate.executable, true);
  // 拆掉证伪就该掉下来——和企业关系那侧完全一致。
  assert.equal(core.gateState(signedAboutPerson({ falsifier: "" })).executable, false);
});

test("人际来源说不出出处，门 5 不过——私有情报是收紧不是放宽", () => {
  const noProvenance = signedAboutPerson({ humanSource: "" });
  assert.equal(core.gateState(noProvenance).states[4], false, "internal 缺人际出处，来源门不成立");
  assert.equal(core.gateState(noProvenance).executable, false);
  // independent 不需要人际出处，规则只对 internal 生效。
  assert.equal(core.gateState(signedAboutPerson({ sourceType: "independent", humanSource: "" })).states[4], true);
});

test("切入排序只回答先看谁，不授权任何行动", () => {
  const signed = signedAboutPerson();
  const roster = [
    person({ id: "p1", name: "李全（全哥）", ourPath: "上季度峰会见过" }),
    person({ id: "p2", name: "韩小明", title: "副经理" }),
    person({ id: "p3", name: "王猛", title: "架构师" }),
  ];
  const ranked = people.entryPointsFor("广联达", roster, [signed]);
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].person.name, "李全（全哥）", "有已签署判断且有通路的人排最前");
  assert.equal(ranked[0].signedJudgments, 1);
  assert.equal(ranked[0].hasPath, true);
  // 排序分不是可信度：它没有把任何未过闸的东西变成可执行。
  const unsigned = people.entryPointsFor("广联达", roster, [signedAboutPerson({ signedOff: false })]);
  assert.equal(unsigned[0].signedJudgments, 0, "未签署的判断不计入已签署数");
  assert.ok(unsigned[0].openJudgments >= 1, "它只作为待补齐的功课出现");
});

test("花名和本名都能命中同一个人", () => {
  const signal = core.makeSignal({
    title: "C师傅主导 AECOS 平台基础服务选型",
    evidence: "多次评审会上由 C师傅 拍定基础服务组件的技术路线，采购流程在其后启动。",
    source: "客户方评审会记录",
  }, core.initialWeights, RULES);
  const ranked = people.entryPointsFor("广联达", [person({ id: "p9", name: "林超（C师傅）" })], [signal]);
  assert.ok(ranked[0].openJudgments >= 1, "括号内的花名要能命中");
});

test("同姓不同名不得误伤", () => {
  const signal = core.makeSignal({
    title: "李全德出任某公司监事",
    evidence: "工商登记显示李全德自 2026 年 6 月起担任该公司监事，与本次采购线无关联记录。",
    source: "工商登记",
  }, core.initialWeights, RULES);
  const ranked = people.entryPointsFor("广联达", [person({ name: "李全" })], [signal]);
  assert.equal(ranked[0].openJudgments, 0, "李全不应命中李全德");
});

test("组织架构树只从汇报边构建，不猜层级", () => {
  const roster = [person({ id: "p1", name: "李全", title: "总经理" }), person({ id: "p2", name: "韩小明", title: "副经理" }), person({ id: "p3", name: "王猛", title: "架构师" })];
  const links = [
    { from: "韩小明", to: "李全", relation: "reports_to", bestGate: 4, executable: false, signalIds: ["s1"] },
    { from: "王猛", to: "韩小明", relation: "reports_to", bestGate: 3, executable: false, signalIds: ["s2"] },
    // 非汇报关系不参与建树。
    { from: "王猛", to: "李全", relation: "influences", bestGate: 5, executable: false, signalIds: ["s3"] },
  ];
  const tree = people.reportingTree(roster, links);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].name, "李全");
  assert.equal(tree.childrenOf(tree.roots[0])[0].name, "韩小明");
  assert.equal(tree.childrenOf(roster[1])[0].name, "王猛");
  // 没有汇报边的人是自己的根，不被硬塞进某个层级。
  const flat = people.reportingTree(roster, []);
  assert.equal(flat.roots.length, 3);
});

test("从人看主体：过闸数跟随支撑情报，不因为画出来就可信", () => {
  const signal = core.makeSignal({
    title: "李全同时出现在两家主体的采购决策中",
    evidence: "两份评审记录显示李全分别代表广联达与其全资子公司参与同类基础服务采购评审。",
    source: "客户方评审会记录",
    edges: [{ from: "李全", to: "斯维尔", relation: "personnel", direction: "forward" }],
  }, core.initialWeights, RULES);
  const orgs = people.orgsOfPerson(person({ name: "李全" }), [signal]);
  const names = orgs.map(item => item.org);
  assert.ok(names.includes("斯维尔"));
  assert.ok(names.includes("广联达"), "雇主也算一条连接");
  assert.ok(orgs.every(item => item.bestGate <= 6));
  assert.ok(!names.includes("李全"), "人自己不算他连着的主体");
});

test("名册写花名、情报写本名时，人不能被当成自己连着的主体", () => {
  // 浏览器里真实出现过：名册「李全（全哥）」，边上「李全」，
  // 命中判定用宽松别名、自我排除用严格相等，于是他把自己列成了关联主体。
  const signal = core.makeSignal({
    title: "李全牵头本轮流程系统选型",
    evidence: "客户方经理口述：集团流程系统选型改由李全牵头，原分散采购权限收回。",
    source: "客户方经理口述",
    edges: [{ from: "李全", to: "广联达", relation: "personnel", direction: "forward" }],
  }, core.initialWeights, RULES);
  const orgs = people.orgsOfPerson(person({ name: "李全（全哥）", employer: "广联达" }), [signal]);
  const names = orgs.map(item => item.org);
  assert.ok(!names.includes("李全"), "本名不能出现在关联主体里");
  assert.ok(!names.includes("全哥"), "花名也不能");
  assert.deepEqual(names, ["广联达"]);
});

test("名册里的人还没有任何支撑情报时，雇主连接的过闸数是 0 而不是崩", () => {
  // 浏览器里真实崩过一次：没有情报命中时，代码伪造了一个没有 constraints 的
  // 假 Signal 去过闸，gateState 直接读 undefined.scope。
  // 名册是事实清单，本来就不该进闸门——这里锁死这个语义。
  const solo = people.orgsOfPerson(person({ name: "王猛", employer: "广联达" }), []);
  assert.equal(solo.length, 1, "雇主本身仍然算一条连接");
  assert.equal(solo[0].org, "广联达");
  assert.equal(solo[0].bestGate, 0, "名册录入不是证据，过闸数必须是 0");
  assert.deepEqual(solo[0].signalIds, [], "没有支撑情报就不能挂任何 signal id");

  // 名册里的人一个情报都没命中时，排序也不能崩。
  const ranked = people.entryPointsFor("广联达", [person({ name: "王猛", employer: "广联达" })], []);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].signedJudgments, 0);
});
