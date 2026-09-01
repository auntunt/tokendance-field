// 公司档案层与语料导入的行为测试。
//
// 这一层的危险不是「不过闸」，而是**凭空升级来源**：报告的全部价值在于
// 「哪一格是硬的」，一旦把通稿里的话标成法定披露，整份报告就不能用了。
// 所以下面的断言主要盯三件事：
//   1. 定级只会低估不会高估（原始语料没有字段级出处，就不许给 statutory）；
//   2. 不许自动把公司标成「FDE 实践者」——那正是报告要回答的问题；
//   3. 缺的字段是真的缺，不填占位（否则覆盖率是假的，等于自欺）。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.ts";

const outDir = buildKernel();
const require = createRequire(import.meta.url);
const dims = require(`${outDir}/fde-dimensions.js`);
const profileLib = require(`${outDir}/company-profile.js`);
const importer = require(`${outDir}/corpus-import.js`);

const FETCHED = "2026-08-09";

// 一条较全的真实形状（内容改写过，不引真人姓名）。
const RICH = {
  id: 39,
  name: "羚数智能（上海）",
  name_raw: "羚数智能（上海）【本轮】",
  city: "上海",
  macro_region: "华东",
  sector: "工业制造",
  sector_raw: "制造业 AI Agent+工业垂类大模型",
  billing_raw: "SaaS+项目制（无锡/淮安设区域交付中心）",
  founder_raw: "张三：原世界 500 强工业企业事业部总经理",
  founder_detail: "张三——原世界 500 强工业企业事业部总经理，团队源自跨国工业集团",
  founder_tags: ["外企/跨国", "央国企/产业老兵"],
  funding_detail: "天使+Pre-A 共 2 轮",
  rounds: 2,
  investors: ["某种子基金", "某线性资本"],
  funding_amount_wan: 7200,
  listed: false,
  stage: "Pre-A",
  narrative: "制造业 AI Agent 与新型工业软件服务商",
  deliverable: "为央国企交付工业大模型应用方案；并在无锡、淮安设区域交付中心",
  sources: ["http://jjckb.xinhuanet.com/20260730/abc/c.html", "https://pitchhub.36kr.com/project/1679701662700293"],
};

// 142/207 是这种：只有一行摘要，没有任何链接。
const BARE = {
  id: 188,
  name: "某某科技",
  city: "未标注",
  sector: "通用平台",
  founder_raw: "李四：技术出身",
  funding_raw: "无公开融资",
  funding_state: "无公开融资",
  listed: false,
  stage: "无公开融资",
  billing_raw: "项目制",
};

test("维度清单是六项，字段总数固定，不许有重名 key", () => {
  assert.equal(dims.DIMENSIONS.length, 6);
  const ids = dims.DIMENSIONS.map(item => item.id);
  assert.deepEqual(ids, ["shareholders", "team", "funding", "business", "fde", "background"]);
  const keys = dims.ALL_FIELDS.map(item => `${item.dimension}.${item.key}`);
  assert.equal(new Set(keys).size, keys.length, "字段 key 重复会让覆盖率算错");
  assert.ok(dims.ALL_FIELDS.length >= 25, `字段太少说明清单没落全，现在 ${dims.ALL_FIELDS.length}`);
  for (const field of dims.ALL_FIELDS) {
    assert.ok(field.where && field.where.trim(), `${field.key} 没写去哪儿找，抓取任务就没法自动化`);
  }
});

test("没有字段级出处的语料，一律不给「法定披露」", () => {
  const profile = importer.importCompany(RICH, FETCHED);
  const cover = profileLib.coverageOf(profile);
  // 这条有新华社链接，够 independent；但没有任何调研字段可以标 statutory。
  const founders = profileLib.fact(profile, "team", "founders");
  assert.equal(founders.grade, "independent");
  assert.equal(cover.byGrade.statutory, 0, "语料没有字段级出处，出现 statutory 就是凭空升级");
});

test("交易所链接也只压到独立三方——能证明公告存在，不能证明这句话抄自公告", () => {
  const ceiling = importer.ceilingGrade({ sources: ["https://www.cninfo.com.cn/new/disclosure/detail?stockCode=000001"] });
  assert.equal(ceiling.grade, "independent");
});

test("没有任何链接的公司，全部字段落到未核实", () => {
  const profile = importer.importCompany(BARE, FETCHED);
  const cover = profileLib.coverageOf(profile);
  assert.equal(cover.byGrade.statutory, 0);
  assert.equal(cover.byGrade.independent, 0);
  assert.equal(cover.byGrade.self, 0);
  assert.ok(cover.byGrade.unverified > 0, "该有值的字段还是有值，只是级别最低");
  const founders = profileLib.fact(profile, "team", "founders");
  assert.equal(founders.grade, "unverified");
  assert.match(founders.source, /无字段级出处/);
});

test("聚合站单独出现时只算企业自述，不算独立三方", () => {
  const only36kr = importer.ceilingGrade({ sources: ["https://pitchhub.36kr.com/project/1"] });
  assert.equal(only36kr.grade, "self");
});

test("备案号是唯一给法定披露的地方——它本身就是监管登记事实", () => {
  const profile = importer.importCompany({ ...BARE, filing: "备案号 Guangdong-Xxx-202503050025（2025/3/28）" }, FETCHED);
  const entry = profileLib.fact(profile, "background", "partnerships");
  assert.equal(entry.grade, "statutory");
  assert.match(entry.source, /备案/);
});

test("不许自动把公司标成 FDE 实践者", () => {
  for (const company of [RICH, BARE, { ...RICH, narrative: "前置部署工程师团队驻场交付" }]) {
    const { relevance } = importer.initialRelevance(company);
    assert.notEqual(relevance, "practitioner", "谁是 FDE 实践者是报告要回答的问题，不能预先猜答案");
  }
});

test("出现驻场字样升到「近似模式」，并且必须给出可反驳的理由", () => {
  const near = importer.initialRelevance(RICH); // deliverable 里有「交付中心」
  assert.equal(near.relevance, "adjacent");
  assert.ok(near.reason.includes("驻场") || near.reason.includes("交付中心"));
  const thin = importer.initialRelevance({ name: "空壳" });
  assert.equal(thin.relevance, "unclear");
  assert.match(thin.reason, /不足/);
});

test("融资三要素分别落位——原来这些字段在导入时被整段丢掉", () => {
  const profile = importer.importCompany(RICH, FETCHED);
  assert.match(profileLib.fact(profile, "funding", "rounds").value, /2 轮/);
  assert.match(profileLib.fact(profile, "funding", "investors").value, /某种子基金/);
  assert.match(profileLib.fact(profile, "funding", "amounts").value, /7200/);
  assert.match(profileLib.fact(profile, "team", "priorAffil").value, /外企/);
});

test("缺的字段返回 null，不返回空串——否则覆盖率是假的", () => {
  const profile = importer.importCompany(BARE, FETCHED);
  assert.equal(profileLib.fact(profile, "shareholders", "majorHolders"), null);
  assert.equal(profileLib.fact(profile, "fde", "jdEvidence"), null);
  const cover = profileLib.coverageOf(profile);
  assert.ok(cover.filled < cover.total, "全填满说明在造数据");
  assert.equal(cover.byDimension.shareholders.filled, 0, "语料里根本没有股东信息，覆盖率必须显示 0");
});

test("每条事实都带出处和抓取时间，一个都不能少", () => {
  for (const company of [RICH, BARE]) {
    const profile = importer.importCompany(company, FETCHED);
    for (const [dimension, bucket] of Object.entries(profile.facts)) {
      for (const [key, entry] of Object.entries(bucket)) {
        assert.ok(entry.source && entry.source.trim(), `${dimension}.${key} 没出处`);
        assert.equal(entry.fetchedAt, FETCHED, `${dimension}.${key} 没抓取时间，定期重跑就算不出新旧`);
        assert.ok(dims.SOURCE_GRADES.includes(entry.grade), `${dimension}.${key} 级别非法`);
      }
    }
  }
});

test("档案层不引入六道门的任何字段——两套体系并行，互不覆盖", () => {
  const profile = importer.importCompany(RICH, FETCHED);
  const text = JSON.stringify(profile);
  for (const word of ["signedOff", "falsifier", "counterEvidence", "validUntil", "ourAccess", "epistemicState"]) {
    assert.doesNotMatch(text, new RegExp(word), `档案层出现 ${word} 说明两层混在一起了`);
  }
});

test("导入是确定性的，同样输入出同样结果", () => {
  const first = importer.importCorpus([RICH, BARE], FETCHED);
  const second = importer.importCorpus([RICH, BARE], FETCHED);
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
});

// ============ 归一标签 ============
//
// label 和 value 分开存，是因为两边的需求相反：
// value 要保住原话（「SaaS+项目制（无锡/淮安设区域交付中心）」带着交付方式的信息，
// 压成枚举就没了），可拿它做统计只能靠正则猜——语料里 53 条会掉出分类。
// 语料本身带着归一好的字段，把它放进 label，统计读 label、卡片读 value。
//
// 这一层坏起来是静默的：label 漏了，交叉表照样出，只是分母悄悄小了一截，
// 报告上写的百分比是对的、覆盖的公司不是全部。所以要盯分母。

test("归一标签和展示值分开：value 是原话，label 是统计口径", () => {
  // 线上语料每行同时带 billing_raw（原话）和 billing（归一枚举）。
  const [profile] = importer.importCorpus([{ ...RICH, billing: "订阅/SaaS" }], FETCHED);
  const pricing = profile.facts.business.pricing;
  assert.match(pricing.value, /无锡/, "展示值该保住原话里的交付方式信息");
  assert.equal(pricing.label, "订阅/SaaS", "统计标签该是语料归一过的那个字段，不是从原话里猜的");
  assert.equal(profile.facts.business.verticals.label, "工业制造");
  assert.equal(profile.facts.funding.rounds.label, "Pre-A");
  assert.match(profile.facts.funding.rounds.value, /2 轮/, "融资的展示值该保住轮次");
});

test("没有归一字段就没有 label——宁可不参与统计，也不拿原话去猜", () => {
  // RICH 只有 billing_raw。猜出来的分类会让交叉表看起来更完整，
  // 代价是有一部分行被归错，而报告上看不出来是猜的。
  const [profile] = importer.importCorpus([RICH], FETCHED);
  assert.equal(profile.facts.business.pricing.label, undefined);
  assert.match(profile.facts.business.pricing.value, /SaaS\+项目制/, "展示值仍在，只是不进统计");
});

test("「未披露」这类占位不许进 label——它会在交叉表里变成一个假分类", () => {
  const vague = { ...RICH, id: 901, stage: "未披露", billing: "未披露", billing_raw: "未披露" };
  const [profile] = importer.importCorpus([vague], FETCHED);
  for (const entry of [profile.facts.funding?.rounds, profile.facts.business?.pricing]) {
    if (entry) assert.equal(entry.label, undefined, `「${entry.value}」被当成一个取值进了统计`);
  }
});

test("创始人背景收成桶时，多标签按体制内优先——不然同一家会同时算进两组", () => {
  // RICH 同时带「外企/跨国」和「央国企/产业老兵」。桶必须唯一，否则分母大于公司数。
  assert.equal(importer.founderBucket(RICH.founder_tags), "院所 / 央国企");
  assert.equal(importer.founderBucket(["阿里/钉钉系"]), "大厂 / 大模型系");
  assert.equal(importer.founderBucket([]), null, "没有标签就是没有取值，不许兜到「其它」桶");
  assert.equal(importer.founderBucket(undefined), null);
});
