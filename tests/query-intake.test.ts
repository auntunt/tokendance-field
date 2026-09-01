// 主动查询解析层的回归测试。
//
// 这一层原来一个测试都没有，代价是两个缺陷一路走到了 UI：
//   1. 拿整句去消歧 → bigram 相似度永远过不了阈值 → 实体名等于整句话
//   2. 搜索词只用维度通用提示 → 用户片段里的关键词（OCP）被丢掉
// 下面每个用例都对着一个具体的失败现象写，不是对着函数签名写。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.ts";

const require = createRequire(import.meta.url);
const outDir = buildKernel();
const {
  extractEntityName, salientTerms, buildSearchTasks, parseQuery, MAX_SEARCH_TASKS,
  relevanceProbe, looksDegraded, relevantToEntity,
} = require(`${outDir}/query-intake.js`);

// 最小名单 fixture：故意放两个法人名高度相似的条目，
// 用来验证消歧确实会把「两个不同法人」同时报出来。
const ROSTER = [
  { id: "vnet-dc", name: "世纪互联", legalName: "世纪互联数据中心有限公司", listing: "NASDAQ:VNET" },
  { id: "vnet-bj", name: "北京世纪互联宽带", legalName: "北京世纪互联宽带数据中心有限公司", listing: "" },
  { id: "glodon", name: "广联达", legalName: "广联达科技股份有限公司", listing: "SZ:002410" },
];

test("从一句话里抽实体名，不能把整句当成公司名", () => {
  // 这是验收用例本身。原来的行为是返回整句，导致后面全链路失效。
  assert.equal(extractEntityName("世纪互联最近启动了OCP设计建设"), "世纪互联");
});

test("剥掉口语铺垫——「听说」这类词不属于公司名", () => {
  assert.equal(extractEntityName("听说广联达要做前置部署"), "广联达");
  assert.equal(extractEntityName("我昨天听到世纪互联在建数据中心"), "世纪互联");
});

test("已经是干净公司名的输入，原样返回，不许乱切", () => {
  assert.equal(extractEntityName("广联达科技股份有限公司"), "广联达科技股份有限公司");
  assert.equal(extractEntityName("世纪互联"), "世纪互联");
});

test("抽出来的名字有长度上限——超长说明切失败了，不能拿去搜", () => {
  const long = "某某某某某某某某某某某某某某某某某某某某某某某某某某某某某某";
  assert.ok(extractEntityName(long).length <= 24);
});

test("片段里的关键词要被挑出来，这才是用户真正问的那件事", () => {
  // OCP 是整条查询的重点；原来的实现完全不看它。
  assert.deepEqual(salientTerms("世纪互联最近启动了OCP设计建设", "世纪互联"), ["OCP"]);
});

test("太泛的缩写不算关键词——带进查询只会污染结果", () => {
  assert.deepEqual(salientTerms("这家公司的CEO和CTO都换了", "某公司"), []);
});

test("实体名里已经有的词不算新信息，不重复搜一遍", () => {
  assert.deepEqual(salientTerms("VNET 的 OCP 部署", "VNET"), ["OCP"]);
});

test("搜索词第一条必须是裸实体名——这是唯一稳定能拿到语料的形态", () => {
  // 实测：中文短名配低共现外来词时，搜索引擎会静默降级。
  // 先跑裸实体，保证 salient 失败时不至于整次查询空手而归。
  const tasks = buildSearchTasks("世纪互联", [{ id: "fde", reason: "", confidence: "high" }], 6, ["OCP"]);
  assert.equal(tasks[0].query, "世纪互联");
  assert.equal(tasks[0].kind, "anchor");
});

test("片段关键词排在维度通用提示之前", () => {
  const tasks = buildSearchTasks("世纪互联", [{ id: "fde", reason: "", confidence: "high" }], 6, ["OCP"]);
  const salientAt = tasks.findIndex(t => t.kind === "salient");
  const dimAt = tasks.findIndex(t => t.kind === "dimension");
  assert.ok(salientAt > -1, "关键词查询必须存在");
  assert.ok(dimAt > -1, "维度查询必须存在");
  assert.ok(salientAt < dimAt, "关键词比通用提示更接近用户的问题，要先搜");
});

test("搜索词不重复——重复只是白等一次限流间隔", () => {
  const tasks = buildSearchTasks("广联达", [
    { id: "shareholders", reason: "", confidence: "high" },
    { id: "funding", reason: "", confidence: "high" },
  ], 6, []);
  assert.equal(new Set(tasks.map(t => t.query)).size, tasks.length);
});

// ─── 验收用例：世纪互联 + OPC→OCP 一次同时命中三件事 ────────────────────────

test("验收：纠错 OPC→OCP、消歧出两个法人、且要用户确认", () => {
  const parsed = parseQuery("世纪互联最近启动了opc设计建设", ROSTER);

  // (a) 术语纠错
  assert.ok(parsed.correction.changed, "opc 必须被纠成 OCP");
  assert.equal(parsed.correction.corrections[0].corrected, "OCP");
  assert.ok(parsed.correction.fragment.includes("OCP"));

  // (b) 消歧要把两个不同法人同时报出来，而不是替用户选一个
  const legalNames = parsed.disambiguation.candidates.map(c => c.legalName);
  assert.ok(parsed.disambiguation.candidates.length >= 2,
    `应有 ≥2 个候选，实际 ${parsed.disambiguation.candidates.length}: ${legalNames.join(" / ")}`);
  assert.ok(legalNames.includes("世纪互联数据中心有限公司"));
  assert.ok(legalNames.includes("北京世纪互联宽带数据中心有限公司"));

  // (c) 有纠错又有多个候选，必须停下来问
  assert.ok(parsed.needsConfirmation, "两个陷阱同时命中，不许静默替用户决定");
});

test("验收：实体名不是整句话，且 OCP 被带进搜索词", () => {
  const parsed = parseQuery("世纪互联最近启动了opc设计建设", ROSTER);
  assert.equal(parsed.extractedName, "世纪互联");
  assert.ok(!parsed.entityName.includes("启动"), `实体名污染了：${parsed.entityName}`);
  assert.deepEqual(parsed.salient, ["OCP"]);
  assert.ok(parsed.searchTasks.some(t => t.query.includes("OCP")),
    `没有一条搜索词带 OCP：${parsed.searchTasks.map(t => t.query).join(" | ")}`);
});

test("片段命中 OCP 关键词时要路由到 fde 维度", () => {
  const parsed = parseQuery("世纪互联最近启动了opc设计建设", ROSTER);
  assert.ok(parsed.dimensions.some(d => d.id === "fde"),
    `实际维度：${parsed.dimensions.map(d => d.id).join(",")}`);
});

test("名单里只有一家匹配、且没纠错时，不打扰用户", () => {
  const parsed = parseQuery("广联达的股东结构", ROSTER);
  assert.equal(parsed.disambiguation.candidates.length, 1);
  assert.equal(parsed.entityName, "广联达");
  assert.ok(!parsed.needsConfirmation, "唯一命中且无纠错，应直接执行");
});

test("名单里完全没有的公司也要确认——这时实体名是规则猜的", () => {
  const parsed = parseQuery("某某科技最近融了一轮", ROSTER);
  assert.equal(parsed.disambiguation.candidates.length, 0);
  assert.ok(parsed.needsConfirmation, "名单外的实体名最该让用户看一眼");
  assert.ok(parsed.entityName.length > 0 && parsed.entityName.length <= 24);
});

test("总任务数守住上限——每多一条就多等一次限流间隔", () => {
  const tasks = buildSearchTasks("广联达", [
    { id: "shareholders", reason: "", confidence: "high" },
    { id: "team", reason: "", confidence: "high" },
    { id: "funding", reason: "", confidence: "high" },
    { id: "business", reason: "", confidence: "high" },
  ], MAX_SEARCH_TASKS, ["OCP", "AIDC"]);
  assert.ok(tasks.length <= MAX_SEARCH_TASKS, `实际 ${tasks.length}`);
});

test("确认面板上列出的搜索词，必须全都会被真的执行", () => {
  // 曾经的错法：解析阶段按 6 条生成、执行阶段按 4 条截断，
  // 用户在确认面板上看到 6 条，其中 2 条根本没跑。
  // 两边共用 MAX_SEARCH_TASKS 就不会再对不上。
  const parsed = parseQuery("广联达的股东、团队、融资、业务都想看看", ROSTER);
  assert.ok(parsed.searchTasks.length <= MAX_SEARCH_TASKS,
    `解析阶段给了 ${parsed.searchTasks.length} 条，超过执行上限 ${MAX_SEARCH_TASKS}`);
});

test("维度很多时，锚定和关键词查询不会被维度提示挤掉", () => {
  // 上限只有 4 条，如果按维度顺序先填就会把 anchor/salient 挤出去——
  // 而那两条恰恰是最可能出结果的。
  const parsed = parseQuery("世纪互联的股东、团队、融资、业务、OCP 建设", ROSTER);
  assert.equal(parsed.searchTasks[0].kind, "anchor");
  assert.ok(parsed.searchTasks.some(t => t.kind === "salient"),
    `关键词查询被挤掉了：${parsed.searchTasks.map(t => t.kind).join(",")}`);
});

// ─── 结果相关性探针 ───────────────────────────────────────────────────────────
// 这组规则的失效方式是「判错但不报错」：结果照样返回，只是变成垃圾语料。
// 下面第一个测试就是线上真实踩到的那一条。

test("探针取头不取尾：剥掉地名前缀和法定后缀", () => {
  assert.equal(relevanceProbe("世纪互联数据中心有限公司"), "世纪互联");
  assert.equal(relevanceProbe("北京世纪互联宽带"), "世纪互联");
  assert.equal(relevanceProbe("广联达科技股份有限公司"), "广联达");
  assert.equal(relevanceProbe("世纪互联"), "世纪互联");
});

test("剥过头就退回原名，不让探针短到没有判别力", () => {
  // 「北京控股」剥完只剩「北京」（地名前缀先匹配则更短），
  // 这种情况必须退回，否则探针会命中任何北京相关页面
  const probe = relevanceProbe("中国控股");
  assert.ok(probe.length >= 2, `探针太短：「${probe}」`);
});

test("回归：世纪佳缘页脚的「互联网」不能让降级批次过关", () => {
  // 线上真实事故。旧规则取实体名末尾两字「互联」做探针，
  // 世纪佳缘页脚有「互联网药品信息服务资格证书」，整批降级结果被判成正常，
  // 「世纪和年代怎么算」这种页面直接进了抽取器。
  const junk = [
    { title: "世纪 和年代怎么算？ - 百度知道", snippet: "一个世纪是一百年，通常是指连续的一百年。" },
    { title: "佳缘登录页_ 世纪 佳缘交友网", snippet: "中文实名：世纪佳缘 营业执照 互联网药品信息服务资格证书" },
  ];
  assert.equal(looksDegraded("世纪互联", junk), true, "这批结果应该被判为降级并整批丢弃");
});

test("真结果不许被误杀", () => {
  const real = [
    { title: "世纪互联 - 维基百科", snippet: "世纪互联（NASDAQ:VNET）是中国的数据中心服务商。" },
    { title: "无关页面", snippet: "别的东西" },
  ];
  assert.equal(looksDegraded("世纪互联", real), false, "有一条真命中就不该整批丢");
});

test("混着来的批次：整批放行，但逐条把巧合命中的挑出去", () => {
  // 降级不总是整批的。一条真命中就能让整批检查过关，
  // 剩下两条巧合命中的会跟着进抽取器——所以还要逐条筛。
  const real = { title: "世纪互联财报", snippet: "世纪互联公布第三季度业绩" };
  const coincidence = { title: "世纪佳缘", snippet: "互联网药品信息服务资格证书" };
  assert.equal(looksDegraded("世纪互联", [real, coincidence]), false);
  assert.equal(relevantToEntity("世纪互联", real), true);
  assert.equal(relevantToEntity("世纪互联", coincidence), false, "巧合命中必须被逐条筛掉");
});

test("英文名不走这条规则——中文分词降级跟它无关", () => {
  const results = [{ title: "VNET Group Q3", snippet: "data center revenue" }];
  assert.equal(looksDegraded("VNET", results), false);
  assert.equal(relevantToEntity("VNET", results[0]), true);
});

test("空结果不算降级——那是「没搜到」，不是「搜错了」", () => {
  assert.equal(looksDegraded("世纪互联", []), false);
});

test("全称查询也要能认出只写简称的页面", () => {
  // 用户可能在确认面板里把名字改成工商全称，
  // 而真实页面普遍只写简称——探针取前 4 字正是为了这个。
  const page = [{ title: "广联达发布年报", snippet: "广联达科技 2025 年营收" }];
  assert.equal(looksDegraded("广联达科技股份有限公司", page), false);
});
