// 判断层的测试。
//
// 这一层的失效方式和抽取层不一样：它不会报错，只会说出一句听起来很有道理、
// 但数据不支持的话。一份带着假判断的报告比一份只堆事实的报告更糟——
// 堆事实至少读者知道自己得自己想，假判断会让人直接拿去做决定。
//
// 所以下面盯的都是「说错但不报错」那一类：
//   1. 样本太少也敢下判断（3 家里 2 家占 67%，那是巧合不是结构）
//   2. 证据等级比支撑它的来源还硬（自述来源撑出「可对外」）
//   3. 反例栏空着——只报对自己有利的那半边数据
//   4. 人写的判断混进「算出来的」里冒充确定性产物
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.mjs";

const outDir = buildKernel();
const require = createRequire(import.meta.url);
const profileLib = require(`${outDir}/company-profile.js`);
const judgment = require(`${outDir}/report-judgment.js`);

const FETCHED = "2026-08-12";

/** 造一个档案。facts 传 {dim: {key: [value, grade]}}。 */
function makeProfile(id, options = {}) {
  const profile = profileLib.emptyProfile(id, options.name || `公司${id}`);
  profile.listing = options.listing || "private";
  profile.relevance = options.relevance || "unclear";
  for (const [dim, fields] of Object.entries(options.facts || {})) {
    profile.facts[dim] = {};
    for (const [key, [value, grade, label]] of Object.entries(fields)) {
      profile.facts[dim][key] = {
        value, grade,
        source: grade === "statutory" ? "2025 年年报" : "公司官网",
        fetchedAt: FETCHED,
        // 第三位是归一标签。交叉统计只认 label，不认 value——所以测试必须能分别给。
        // 不给 label 就等于「这条不参与交叉统计」，那本身也是要测的一种状态。
        ...(label === undefined ? {} : { label }),
      };
    }
  }
  return profile;
}

test("样本太少不下判断——3 家里 2 家占 67% 是巧合，不是结构", () => {
  const profiles = [
    makeProfile("a", { facts: { business: { pricing: ["项目制", "self"] } } }),
    makeProfile("b", { facts: { business: { pricing: ["项目制", "self"] } } }),
    makeProfile("c", { facts: { business: { pricing: ["订阅", "self"] } } }),
  ];
  const set = judgment.buildJudgments(profiles);
  const concentration = set.computed.filter(j => j.claim.includes("集中"));
  assert.equal(concentration.length, 0, "3 家的样本就敢报集中度，这种判断纯属噪音");
});

test("证据等级不许超过支撑它的最软那条来源", () => {
  // 12 家全填「项目制」，但全部来自自述——集中度是真的，硬度不是。
  const profiles = Array.from({ length: 12 }, (_, i) =>
    makeProfile(`p${i}`, { facts: { business: { pricing: ["项目制", "self"] } } }));
  const set = judgment.buildJudgments(profiles);
  const hit = set.computed.find(j => j.claim.includes("集中"));
  assert.ok(hit, "12 家全同一个取值，应该报出集中度");
  assert.equal(hit.confidence, "internal",
    "支撑全是自述来源，却给了可对外——这会让人把通稿里的数字引出去");
});

test("有一条未核实来源就降到仅线索", () => {
  const profiles = Array.from({ length: 12 }, (_, i) =>
    makeProfile(`p${i}`, {
      facts: { business: { pricing: ["项目制", i === 0 ? "unverified" : "statutory"] } },
    }));
  const set = judgment.buildJudgments(profiles);
  const hit = set.computed.find(j => j.claim.includes("集中"));
  assert.ok(hit);
  assert.equal(hit.confidence, "lead", "混进了未核实来源，等级必须掉到仅线索");
});

test("每条判断都必须有反例栏，空着等于只报了一半数据", () => {
  const profiles = Array.from({ length: 30 }, (_, i) =>
    makeProfile(`p${i}`, {
      listing: i < 10 ? "us" : "private",
      facts: i < 10
        ? { business: { pricing: ["项目制", "statutory"], verticals: ["工业制造", "statutory"] } }
        : {},
    }));
  const set = judgment.buildJudgments(profiles);
  assert.ok(set.computed.length > 0, "这个样本应该能算出判断");
  for (const j of set.computed) {
    assert.ok(j.counter && j.counter.trim(), `「${j.claim}」没写反例检查`);
    assert.ok(j.support && j.support.trim(), `「${j.claim}」没写支撑`);
    assert.ok(j.claim.length > 8, "判断太短，不可能是一句能被反驳的话");
  }
});

test("人写的判断不混进算出来的那一组", () => {
  const profiles = Array.from({ length: 20 }, (_, i) => makeProfile(`p${i}`));
  const manual = [{
    claim: "护城河在客户关系和现场工程里，不在技术里",
    confidence: "public",
    support: "65 张卡片里没有一家以模型能力作为差异化卖点",
    counter: "无",
  }];
  const set = judgment.buildJudgments(profiles, manual);
  assert.equal(set.manual.length, 1);
  assert.equal(set.manual[0].origin, "manual", "人写的判断必须标 manual，否则冒充确定性产物");
  for (const j of set.computed) {
    assert.equal(j.origin, "computed");
    assert.notEqual(j.claim, manual[0].claim, "人写的判断漏进了 computed 组");
  }
  assert.equal(set.all.length, set.computed.length + 1);
});

test("全表零命中的字段会被单独报出来——缺口本身是结论", () => {
  const profiles = Array.from({ length: 20 }, (_, i) =>
    makeProfile(`p${i}`, { facts: { business: { pricing: ["项目制", "self"] } } }));
  const set = judgment.buildJudgments(profiles);
  const blind = set.computed.find(j => j.claim.includes("一条都没查到"));
  assert.ok(blind, "29 个字段全空却没报盲区，等于把最诚实的一条结论藏了");
  assert.equal(blind.confidence, "public", "盲区判断只依赖抓取事实，应该是可对外的");
  assert.ok(blind.support.includes("20"), "支撑里要写清分母");
});

test("待判定占多数时必须说清这是候选池不是同行名单", () => {
  const profiles = Array.from({ length: 20 }, (_, i) =>
    makeProfile(`p${i}`, { relevance: i < 3 ? "practitioner" : "unclear" }));
  const set = judgment.buildJudgments(profiles);
  const hit = set.computed.find(j => j.claim.includes("候选池"));
  assert.ok(hit, "17/20 还没判定却不说明，读者会把候选当同行用");
  assert.ok(hit.support.includes("3"), "支撑要写清已判定几家");
});

test("上市与未上市的覆盖差要能算出来，且说清差距来自法定披露", () => {
  const profiles = [
    ...Array.from({ length: 6 }, (_, i) => makeProfile(`u${i}`, {
      listing: "us",
      facts: {
        business: { pricing: ["订阅", "statutory"], revenue: ["10 亿美元", "statutory"] },
        shareholders: { controller: ["创始人", "statutory"], institutional: ["某基金", "statutory"] },
      },
    })),
    ...Array.from({ length: 6 }, (_, i) => makeProfile(`p${i}`, { listing: "private" })),
  ];
  const set = judgment.buildJudgments(profiles);
  const hit = set.computed.find(j => j.claim.includes("法定披露"));
  assert.ok(hit, "两组覆盖差 4 倍却没报出来");
  assert.equal(hit.confidence, "public");
});

test("比例条的占比之和不许超过 100%——图不能和统计打架", () => {
  const profiles = Array.from({ length: 15 }, (_, i) =>
    makeProfile(`p${i}`, { listing: i < 5 ? "us" : i < 9 ? "hk" : "private" }));
  const bars = judgment.listingBars(profiles);
  const sum = bars.reduce((s, b) => s + b.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `上市地占比加起来是 ${sum}，不是 1`);
  const counted = bars.reduce((s, b) => s + b.count, 0);
  assert.equal(counted, profiles.length, "分组计数和总数不一致");
});

test("维度条和字段条的占比都在 0..1 之间", () => {
  const profiles = Array.from({ length: 10 }, (_, i) =>
    makeProfile(`p${i}`, { facts: { business: { pricing: ["项目制", "self"] } } }));
  for (const bars of [judgment.dimensionBars(profiles), judgment.fieldBars(profiles)]) {
    assert.ok(bars.length > 0);
    for (const b of bars) {
      assert.ok(b.share >= 0 && b.share <= 1, `${b.label} 的占比是 ${b.share}，超出了 0..1`);
      assert.ok(b.count >= 0 && b.count <= profiles.length * 30, `${b.label} 的计数越界`);
    }
  }
});

test("空名单不崩，也不硬凑判断", () => {
  const set = judgment.buildJudgments([]);
  assert.equal(set.all.length, 0, "没有公司也敢下判断");
  assert.deepEqual(judgment.listingBars([]), []);
});

// ============ 交叉表 ============
//
// 这几条测的不是「算得对不对」，是「说的是不是情报」。
// 第一版的判断全在描述这份数据自己——覆盖率多少、哪几格空着、谁是离群值。
// 那是数据质量报告：读者读完仍然不知道这些公司在做什么。
// 交叉之后才有结论，所以下面盯的是交叉这一步会怎么骗人。

/** 造一组交叉用的档案：sector × billing，两边都带 label。 */
function crossProfiles(spec) {
  const out = [];
  let n = 0;
  for (const [sector, billings] of Object.entries(spec)) {
    for (const [billing, count] of Object.entries(billings)) {
      for (let i = 0; i < count; i += 1) {
        out.push(makeProfile(`x${n += 1}`, {
          facts: {
            business: {
              // value 是给人读的原话，label 是统计口径。故意让 value 带上金额和括号，
              // 因为线上语料就是这样——如果哪天统计又退回去读 value，这里会先炸。
              verticals: [`${sector}（含若干细分）`, "self", sector],
              pricing: [`${billing}，累计订单 ${100 + i} 万`, "self", billing],
            },
          },
        }));
      }
    }
  }
  return out;
}

test("交叉表读的是 label，不是 value——value 带着金额和括号，正则永远猜不准", () => {
  const profiles = crossProfiles({
    政务治理: { "项目制/私有化": 11, "订阅/SaaS": 1 },
    零售消费: { "项目制/私有化": 2, "订阅/SaaS": 10 },
    工业制造: { "项目制/私有化": 6, "订阅/SaaS": 6 },
  });
  const table = judgment.sectorBillingTable(profiles);
  assert.ok(table, "三个 5 家以上的赛道应该出表");
  assert.deepEqual(table.rows.map(r => r.row), ["政务治理", "工业制造", "零售消费"],
    "行该按项目制占比从高到低排");
  const top = table.rows[0];
  const projIndex = table.cols.indexOf("项目制/私有化");
  assert.equal(top.counts[projIndex], 11, "计数不对：说明统计没走 label");
  assert.equal(top.total, 12);
});

test("交叉之后每组必然变小，所以不到 5 家的组不许进表", () => {
  const profiles = crossProfiles({
    政务治理: { "项目制/私有化": 9, "订阅/SaaS": 1 },
    零售消费: { "项目制/私有化": 1, "订阅/SaaS": 9 },
    工业制造: { "项目制/私有化": 5, "订阅/SaaS": 3 },
    法律合规: { "项目制/私有化": 2 },  // 只有 2 家，是噪音
  });
  const table = judgment.sectorBillingTable(profiles);
  assert.ok(!table.rows.some(r => r.row === "法律合规"), "2 家的组进了表，那一行的百分比没有意义");
});

test("分布不均和结构性差异不是一回事——极差不到 40 个百分点不出判断", () => {
  // 55% / 45% / 35%：确实有高低，但拿它写「收费方式是赛道定的」是过度解读。
  const profiles = crossProfiles({
    政务治理: { "项目制/私有化": 11, "订阅/SaaS": 9 },
    工业制造: { "项目制/私有化": 9, "订阅/SaaS": 11 },
    零售消费: { "项目制/私有化": 7, "订阅/SaaS": 13 },
  });
  const set = judgment.buildJudgments(profiles);
  const hit = set.computed.find(j => j.claim.includes("收费方式是赛道定的"));
  assert.equal(hit, undefined, "45% 到 55% 的波动被当成结构性差异报了出去");
});

test("只有两个赛道够格时不出交叉判断——两点连成的线不是趋势", () => {
  const profiles = crossProfiles({
    政务治理: { "项目制/私有化": 12 },
    零售消费: { "订阅/SaaS": 12 },
  });
  const set = judgment.buildJudgments(profiles);
  assert.equal(set.computed.filter(j => j.claim.includes("赛道定的")).length, 0,
    "只有两组也敢报「按赛道分化」，那是拿两个点画线");
});

test("判断里的百分比必须等于表里那一格——同一份数据出两个数字，读者只会不信整份报告", () => {
  const profiles = crossProfiles({
    政务治理: { "项目制/私有化": 11, "订阅/SaaS": 1 },
    零售消费: { "项目制/私有化": 2, "订阅/SaaS": 10, "平台+定制": 6 },
    工业制造: { "项目制/私有化": 6, "订阅/SaaS": 6 },
  });
  // 「平台+定制」是这条测试的关键：它含「定制」二字。判断和表格各写一遍正则，
  // 其中一个写成 /项目制|私有化|定制/ 就会把它算进项目制，于是判断 75%、表格 63%。
  const table = judgment.sectorBillingTable(profiles);
  const set = judgment.buildJudgments(profiles);
  const hit = set.computed.find(j => j.claim.includes("收费方式是赛道定的"));
  assert.ok(hit, "这组数据的极差足够大，应该出判断");

  const projIndex = table.cols.indexOf("项目制/私有化");
  for (const row of table.rows) {
    const inTable = `${Math.round(row.shares[projIndex] * 100)}%`;
    // 判断的支撑里逐行列了「赛道 xx%（n/m）」，跟表格对齐着看。
    assert.match(hit.support, new RegExp(`${row.row} ${inTable}（${row.counts[projIndex]}/${row.total}）`),
      `${row.row}：表里是 ${inTable}（${row.counts[projIndex]}/${row.total}），判断的支撑里找不到同一个数`);
  }
});
