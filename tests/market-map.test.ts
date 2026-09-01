// 版图层的纪律测试。
//
// 这一层最容易撒的谎有两个，下面每一条断言都对着其中一个：
//
// 一、把转载数当覆盖数。同一份增资公告被五家媒体转发，台账里五条，
//     格子涂成深色，读图的人以为"好几家都这么说"。热度必须按去重后的
//     独立来源数算，不是条数。
// 二、把"没查过"和"查过没有"涂成同一种冷色。前者是我们的空白，
//     后者是关于世界的陈述，混在一起，这张图就在替我们编事实。
//
// 另外锁死一件事：版图不碰六道门。它是"换个看法"，不是"新的过闸方式"。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.ts";

const outDir = buildKernel();
const require = createRequire(import.meta.url);
const core = require(`${outDir}/field-core.js`);
const map = require(`${outDir}/market-map.js`);
const { RELATIONS } = require(`${outDir}/ontology.js`);

const WEIGHTS = core.initialWeights;
const RULES = RELATIONS.map(item => ({ id: item.id, words: item.words }));

/** 一条普通情报。默认未过闸——过闸要显式给 signed。 */
function mk({ id, title = "一条情报", evidence, source, edges = [], sourceType = "independent", signed = false }) {
  return core.makeSignal({
    id,
    title,
    evidence,
    source,
    edges,
    constraints: signed
      ? {
          scope: { entityScope: "甲电子/乙材料", marketRegion: "华东", dataBasis: "营收", timeWindow: "2026H1", ourAccess: "无" },
          epistemicState: "observation",
          falsifier: "工商信息未变更即不成立",
          counterEvidence: "暂无反面材料",
          sourceType,
          validUntil: "2099-12-31",
          probability: 70,
          signedOff: true,
        }
      : { sourceType },
  }, WEIGHTS, RULES);
}

const EQUITY = (from, to) => [{ from, to, relation: "equity", direction: "forward" }];

/** 同一份材料的三种排版。转载真实会动的就是这些：全角标点、空白、零宽字符。 */
const MATERIAL = "公司与乙材料科技有限公司签署增资协议，以自有资金人民币32,000万元认购新增注册资本。";
const MATERIAL_REPRINT = "公司与乙材料科技有限公司签署增资协议， 以自有资金人民币 32,000 万元认购新增注册资本。";
const MATERIAL_ZERO_WIDTH = "公司与乙材料科技有限公司签署增资协议，​以自有资金人民币32,000万元认购新增注册资本。";

function cellOf(result, org, relation) {
  const row = result.rows.find(item => item.org === org);
  assert.ok(row, `版图里没有 ${org} 这一行`);
  return row.cells.find(cell => cell.relation === relation);
}

test("转载不抬热度：同一份材料换三个来源，热度仍然是 1", () => {
  const signals = [
    mk({ id: "a", evidence: MATERIAL, source: "巨潮资讯", edges: EQUITY("甲电子", "乙材料") }),
    mk({ id: "b", evidence: MATERIAL_REPRINT, source: "某财经门户", edges: EQUITY("甲电子", "乙材料") }),
    mk({ id: "c", evidence: MATERIAL_ZERO_WIDTH, source: "某公众号", edges: EQUITY("甲电子", "乙材料") }),
  ];
  const cell = cellOf(map.buildMarketMap(signals), "甲电子", "equity");
  assert.equal(cell.signals.length, 3, "三条情报都要留在格子里，看得见");
  assert.equal(cell.materials, 1, "三条是同一份材料的三种排版");
  assert.equal(cell.heat, 1, "热度按材料算，不按条数算——转载不是第二个来源");
  assert.equal(cell.reprints, 2, "被折叠掉的条数就是转载量，要能报出来");
});

test("三份互不相同的材料、三个独立来源，热度才是 3", () => {
  const signals = [
    mk({ id: "a", evidence: "甲电子以自有资金认购乙材料新增注册资本，持股比例达到百分之十八。", source: "巨潮资讯", edges: EQUITY("甲电子", "乙材料") }),
    mk({ id: "b", evidence: "乙材料本次增资的出资方为甲电子，出资额三亿两千万元人民币。", source: "上交所披露", edges: EQUITY("甲电子", "乙材料") }),
    mk({ id: "c", evidence: "甲电子获得乙材料一个董事席位，提名权写入本次增资协议条款。", source: "某券商研报", edges: EQUITY("甲电子", "乙材料") }),
  ];
  const cell = cellOf(map.buildMarketMap(signals), "甲电子", "equity");
  assert.equal(cell.materials, 3);
  assert.equal(cell.heat, 3);
  assert.equal(cell.reprints, 0);
  assert.equal(cell.state, "backed");
});

test("当事人自己发的和自己打听的不进热度，但仍然留在格子里", () => {
  const signals = [
    mk({ id: "a", evidence: MATERIAL, source: "甲电子官网", sourceType: "related", edges: EQUITY("甲电子", "乙材料") }),
    mk({ id: "b", evidence: "销售会上对方提到甲电子已经完成对乙材料的增资交割。", source: "客户口述", sourceType: "internal", edges: EQUITY("甲电子", "乙材料") }),
  ];
  const cell = cellOf(map.buildMarketMap(signals), "甲电子", "equity");
  assert.equal(cell.signals.length, 2, "看得见");
  assert.equal(cell.materials, 2);
  assert.equal(cell.heat, 0, "只有独立第三方来源进热度");
  assert.equal(cell.state, "no-independent", "查过但没有独立来源，不能和没查过同色");
});

test("没查过的格子和查过没独立来源的格子必须是两种状态", () => {
  const signals = [mk({ id: "a", evidence: MATERIAL, source: "甲电子官网", sourceType: "related", edges: EQUITY("甲电子", "乙材料") })];
  const result = map.buildMarketMap(signals);
  assert.equal(cellOf(result, "甲电子", "equity").state, "no-independent");
  assert.equal(cellOf(result, "甲电子", "supply").state, "unchecked", "供应关系一条材料都没有——这是我们的空白，不是'没有供应关系'");
  // 空白率要能报出来，否则界面没法把这句话说出口。
  assert.equal(result.cellCount, 2 * RELATIONS.length);
  assert.equal(result.uncheckedCount, 2 * RELATIONS.length - 2, "两行各一个 equity 格子有料，其余全空");
});

test("热度和过闸是两个数：三份独立材料也不让任何一条过闸", () => {
  const signals = [
    mk({ id: "a", evidence: "甲电子认购乙材料新增注册资本，持股百分之十八，来源为交易所披露文件。", source: "巨潮资讯", edges: EQUITY("甲电子", "乙材料") }),
    mk({ id: "b", evidence: "乙材料本次增资出资方为甲电子，金额三亿两千万元，见交易所公告附件。", source: "上交所披露", edges: EQUITY("甲电子", "乙材料") }),
    mk({ id: "c", evidence: "甲电子取得乙材料董事提名权一名，条款写在增资协议第四条。", source: "某券商研报", edges: EQUITY("甲电子", "乙材料") }),
  ];
  const cell = cellOf(map.buildMarketMap(signals), "甲电子", "equity");
  assert.equal(cell.heat, 3, "覆盖够了");
  assert.equal(cell.admitted.length, 0, "但一条都没过闸——材料多不等于判断硬");
  for (const signal of signals) assert.equal(core.gateState(signal).executable, false);
});

test("过完六道门的才进 admitted，过期的要掉出来", () => {
  const fresh = mk({ id: "a", evidence: MATERIAL, source: "巨潮资讯", edges: EQUITY("甲电子", "乙材料"), signed: true });
  assert.equal(core.gateState(fresh).executable, true, "先确认这条真的过闸了，否则下面的断言是空的");
  const stale = { ...fresh, id: "b", constraints: { ...fresh.constraints, validUntil: "2020-01-01" } };
  const cell = cellOf(map.buildMarketMap([fresh]), "甲电子", "equity");
  assert.equal(cell.admitted.length, 1);
  assert.equal(cellOf(map.buildMarketMap([stale]), "甲电子", "equity").admitted.length, 0, "过期的来源等于没有来源");
});

test("关系类型用边上声明的，不用关键词猜出来的 topics", () => {
  // 这段原文里一个"供应"类关键词都没有，但边明确写了 supply。
  const signal = mk({
    id: "a", title: "两家主体之间的往来", evidence: "乙材料每月向甲电子发出一批货物，价格随行就市，没有长期约定。",
    source: "巨潮资讯", edges: [{ from: "乙材料", to: "甲电子", relation: "supply", direction: "forward" }],
  });
  const result = map.buildMarketMap([signal]);
  assert.equal(cellOf(result, "甲电子", "supply").signals.length, 1, "边声明了 supply，就落在 supply");
  assert.equal(cellOf(result, "甲电子", "equity").state, "unchecked", "不许因为关键词命中就跑到别的格子里");
});

test("关系类型认不出来的边不硬塞进任何格子", () => {
  const signal = mk({
    id: "a", evidence: MATERIAL, source: "巨潮资讯",
    edges: [{ from: "甲电子", to: "乙材料", relation: "说不清的关系", direction: "forward" }],
  });
  const result = map.buildMarketMap([signal]);
  assert.equal(result.rows.length, 0, "认不出类型就不上版图");
  assert.equal(result.offMap.length, 1, "但必须落在 offMap 里，不许静默丢掉");
});

test("没有关系边的情报不进版图，但一条都不许丢", () => {
  const signals = [
    mk({ id: "a", evidence: "行业里做前置交付工程的公司这两年明显变多，但没有具体主体信息。", source: "某访谈" }),
    mk({ id: "b", evidence: MATERIAL, source: "巨潮资讯", edges: EQUITY("甲电子", "乙材料") }),
  ];
  const result = map.buildMarketMap(signals);
  assert.equal(result.offMap.length, 1);
  assert.equal(result.offMap[0].id, "a");
  assert.equal(result.rows.length, 2, "只有带边的那条产生了主体行");
});

test("人物不成为版图的行", () => {
  const signals = [
    mk({ id: "a", evidence: "李全同时在甲电子与乙材料担任董事，两边的任命公告都能查到。", source: "巨潮资讯",
      edges: [{ from: "李全", to: "甲电子", relation: "personnel", direction: "forward", kind: "person-org" }] }),
    mk({ id: "b", evidence: "李全与王明在同一个采购决策链上，一个拍板一个复核，见会议纪要。", source: "某会议纪要",
      edges: [{ from: "李全", to: "王明", relation: "personnel", direction: "forward", kind: "person-person" }] }),
  ];
  const result = map.buildMarketMap(signals, ["李全", "王明"]);
  const orgs = result.rows.map(row => row.org);
  assert.deepEqual(orgs, ["甲电子"], "只有主体上版图");
  assert.ok(!orgs.includes("李全"));
  assert.equal(result.offMap.some(item => item.id === "b"), true, "人—人的边没有主体坐标，落 offMap");
});

test("主体名的排版差异不分裂成两行", () => {
  const signals = [
    mk({ id: "a", evidence: "第一份材料：甲电子股份有限公司认购乙材料新增注册资本三亿两千万元。", source: "巨潮资讯",
      edges: EQUITY("甲电子股份有限公司", "乙材料") }),
    mk({ id: "b", evidence: "第二份材料：乙材料确认本次增资出资方为甲电子，并给出一个董事席位。", source: "上交所披露",
      edges: EQUITY("甲电子 股份有限公司", "乙材料") }),
  ];
  const result = map.buildMarketMap(signals);
  assert.equal(result.rows.filter(row => row.org.startsWith("甲电子")).length, 1, "带空格和不带空格是同一家公司");
  assert.equal(cellOf(result, "甲电子股份有限公司", "equity").heat, 2);
});

test("非法人主体的行要能被认出来——园区不是一家公司", () => {
  const signals = [mk({ id: "a", evidence: MATERIAL, source: "巨潮资讯", edges: EQUITY("万洋众创城", "甲电子股份有限公司") })];
  const result = map.buildMarketMap(signals);
  assert.equal(result.rows.find(row => row.org === "万洋众创城").kind, "site");
  assert.equal(result.rows.find(row => row.org === "甲电子股份有限公司").kind, "legal");
});

test("版图层不碰六道门", () => {
  const signal = mk({ id: "a", evidence: MATERIAL, source: "巨潮资讯", edges: EQUITY("甲电子", "乙材料") });
  const before = core.gateState(signal);
  map.buildMarketMap([signal]);
  const after = core.gateState(signal);
  assert.deepEqual(after.states, before.states, "建版图不许改任何一道门的状态");
  assert.equal(after.executable, false);
  // 版图模块不许导出任何过闸相关的东西。
  for (const name of Object.keys(map)) {
    assert.ok(!/gate|executable|signoff|approve/i.test(name), `版图层不该导出 ${name}`);
  }
});

test("规模数字原样摘出，不换算单位", () => {
  const signal = mk({
    id: "a", title: "这一块的市场规模",
    evidence: "第三方测算该细分市场 2026 年规模约 12.5 亿元，其中华东占比接近四成。",
    source: "某研究机构", edges: EQUITY("甲电子", "乙材料"),
  });
  const claims = map.scaleClaims([signal]);
  assert.equal(claims.length, 1);
  // 「约」必须跟着数字一起留下。摘成光秃秃的「12.5 亿元」，
  // 一个第三方测算的估数就变成了一个精确数字——这是在替原文提高确定性。
  assert.ok(claims[0].numbers.includes("约 12.5 亿元"), `模糊限定词必须保留，实际 ${JSON.stringify(claims[0].numbers)}`);
  assert.ok(!claims[0].numbers.includes("12.5 亿元"), "不许把「约」丢掉后单独留一条精确版");
  assert.ok(!claims[0].numbers.some(item => item.includes("1250000000")), "不许换算成元");
  assert.ok(!claims[0].numbers.includes("2026"), "裸年份不是规模数字");
});

test("不谈规模的情报不进规模表", () => {
  const signal = mk({ id: "a", evidence: "甲电子于 2026 年 7 月 15 日与乙材料签署协议，约定一名董事席位。", source: "巨潮资讯", edges: EQUITY("甲电子", "乙材料") });
  assert.equal(map.scaleClaims([signal]).length, 0, "有数字但不谈规模，不该进这张表");
});

test("口径不同的数字分组放，且这一层不提供求和", () => {
  const revenue = mk({ id: "a", title: "市场规模", evidence: "按营收口径测算，该细分市场规模约 12.5 亿元。", source: "机构A", edges: EQUITY("甲电子", "乙材料"), signed: true });
  const shipment = {
    ...mk({ id: "b", title: "市场规模", evidence: "按出货量口径测算，该细分市场规模约 3 亿元。", source: "机构B", edges: EQUITY("甲电子", "乙材料"), signed: true }),
  };
  shipment.constraints = { ...shipment.constraints, scope: { ...shipment.constraints.scope, dataBasis: "出货量" } };
  const noBasis = mk({ id: "c", title: "市场规模", evidence: "有人说这个盘子大概 20 亿元，没说按什么算。", source: "某访谈", edges: EQUITY("甲电子", "乙材料") });

  const groups = map.groupByBasis(map.scaleClaims([revenue, shipment, noBasis]));
  assert.equal(groups.length, 3, "营收 / 出货量 / 没写口径，三组");
  assert.equal(groups[groups.length - 1].basis, "", "没写口径的排最后——它是待补，不是一个口径");

  // 求和的入口根本不该存在。营收口径的 12.5 亿加出货量口径的 3 亿等于 15.5，
  // 而 15.5 什么也不是。这里锁的是"没有这个函数"，不是"这个函数算得对"。
  for (const name of Object.keys(map)) {
    assert.ok(!/sum|total(?!Heat)|aggregate|marketSize/i.test(name), `不该导出 ${name}：口径不同的数字不许合计`);
  }
});

test("规模判断也要过六道门才算成立", () => {
  const signed = mk({ id: "a", title: "市场规模", evidence: "按营收口径测算，该细分市场规模约 12.5 亿元。", source: "机构A", edges: EQUITY("甲电子", "乙材料"), signed: true });
  const draft = mk({ id: "b", title: "市场规模", evidence: "按营收口径测算，该细分市场规模约 12.5 亿元。", source: "机构A", edges: EQUITY("甲电子", "乙材料") });
  assert.equal(map.scaleClaims([signed])[0].admitted, true);
  assert.equal(map.scaleClaims([draft])[0].admitted, false, "没过闸的规模数字必须标出来，不能和过闸的并排显示成同一种东西");
});

test("空版图报空，不报零", () => {
  const result = map.buildMarketMap([]);
  assert.deepEqual(result.rows, []);
  assert.equal(result.totalHeat, 0);
  assert.equal(result.cellCount, 0);
  assert.equal(result.uncheckedCount, 0, "没有行就没有格子——不该凭空造出一堆'未查'");
});
