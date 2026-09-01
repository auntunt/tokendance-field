// 持股名单排表的测试。
//
// 这个解析器的风险不是「排不出表」，而是**排错了还看起来对**：
// 一张对齐的表格比一段散文更像结论，摆错一行没人会怀疑。
// 所以这里盯三件事：口径子句不许丢、认不出来必须退回散文、名字不许吃进句子。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.ts";

const outDir = buildKernel();
const require = createRequire(import.meta.url);
const { parseHolders } = require(`${outDir}/holder-table.js`);

// 下面四段全部是 data/filing-facts.json 里的真实值，不是编的。
const SEC = "Thomas M. Siebel 18.1%（28,535,827 股）；The Vanguard Group 9.3%（12,489,440 股）；BlackRock, Inc. 7.4%（9,984,692 股）";
const HK = "Easy Key Holdings Limited 19.23%；Oriental Tao Limited 10.89%；Billion Tao Limited 8.34%；富國基金管理有限公司 6.13%；BlackRock, Inc. 5.50%。口径：SFO 第XV部第2、3分部下的权益披露，5% 门槛按股份类别计算，故可能出现占总股本低于 5% 的股东";
const A_SHARE = "2026-03-31 报告期十大流通股东中机构类持有人 6 席，合计持股占总股本 5.707%：香港中央结算有限公司（其它）1.8507%；UBS AG（QFII）1.5342% 口径：名单为十大流通股东（不是十大股东，限售股不计入流通盘）；比例为接口 HOLD_RATIO 字段＝占总股本比例，不是占流通股比例。数据来源：东方财富 F10 RPT_F10_EH_FREEHOLDERS（300166.SZ）";

test("SEC 那种「名字 比例（股数）」排得出行，股数进备注", () => {
  const table = parseHolders(SEC);
  assert.ok(table, "SEC 格式必须能解析");
  assert.equal(table.rows.length, 3);
  assert.equal(table.rows[0].name, "Thomas M. Siebel");
  assert.equal(table.rows[0].pct, "18.1");
  assert.equal(table.rows[0].note, "28,535,827 股");
});

test("A 股那种「名字（类型）比例」也排得出，类型进备注", () => {
  const table = parseHolders(A_SHARE);
  assert.ok(table, "A 股格式必须能解析");
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0].name, "香港中央结算有限公司");
  assert.equal(table.rows[0].note, "其它");
  assert.equal(table.rows[1].name, "UBS AG");
  assert.equal(table.rows[1].pct, "1.5342");
});

test("比例照抄原文，不重算也不四舍五入", () => {
  // 1.5342 被显示成 1.53 就等于悄悄改了一个法定披露级别的数字。
  const table = parseHolders(A_SHARE);
  assert.equal(table.rows[1].pct, "1.5342", "小数位被截了——那是在改数据");
});

test("口径子句一个字都不许丢——它是这些数字唯一的量纲说明", () => {
  // 「占总股本比例」和「占流通股比例」差一倍还不止。表格把数字排整齐之后，
  // 只有这句话能说明它们在量什么。丢了它，这张表就是个看起来很准的错误。
  for (const raw of [HK, A_SHARE]) {
    const table = parseHolders(raw);
    assert.ok(table.basis, "口径子句没被保留");
    const clause = raw.slice(raw.search(/(口径：|数据来源：)/)).replace(/[。；]+$/, "").trim();
    assert.equal(table.basis, clause.replace(/[。；]+$/, "").trim(), "口径子句被改写了，必须原文照搬");
  }
  assert.match(parseHolders(A_SHARE).basis, /不是占流通股比例/, "最要紧的那句限定没了");
  assert.match(parseHolders(A_SHARE).basis, /数据来源：东方财富/, "数据来源子句丢了");
});

test("引子里的「合计占总股本」不许被当成一个股东排进表", () => {
  const table = parseHolders(A_SHARE);
  assert.match(table.preamble, /十大流通股东中机构类持有人 6 席/);
  for (const row of table.rows) {
    assert.doesNotMatch(row.name, /合计|报告期|席/, `「${row.name}」是引子的一部分，不是股东`);
  }
});

test("认不出来就退回散文，绝不猜着摆进表格", () => {
  // 摆错了的表格比散文更危险：它看起来像已经核过的结论。
  for (const raw of [
    "无控股主体",
    "自然人控股",
    "刘庆峰",
    "管连平和霍卫平",
    "2026-03-31 报告期流通股集中度（横截面，非变动）：第一大流通股东 管连平 持 3.532%，十大流通股东合计持股占总股本 13.6189%，共 10 名披露",
    "某公司 12.3%；这里是一句没有比例的散文",
    "",
  ]) {
    assert.equal(parseHolders(raw), null, `「${raw.slice(0, 24)}」不该被排成表`);
  }
});

test("只有一行不排表——一行的「表」只是把一句话套了个框", () => {
  assert.equal(parseHolders("Thomas M. Siebel 18.1%（28,535,827 股）"), null);
});

test("同一段输入解析两次结果一样——报告要能逐版比对", () => {
  assert.deepEqual(parseHolders(HK), parseHolders(HK));
});

// 下面两段也是真实值。第一版解析器把它们整段退回了散文——
// 只因为名单后面多跟了一句附注。那不是「认不出来」，是解析器切错了边界。
const SEC_WITH_NOTE = "截至 2025-08-04：Thomas M. Siebel 18.1%（28,535,827 股）；The Vanguard Group 9.3%（12,489,440 股）；BlackRock, Inc. 7.4%（9,984,692 股）。股份类别：Class A Common Stock。口径：SEC Rule 13d-3 实益拥有权，非登记在册持股；百分比为占该股份类别的比例，非占总股本；因各人分母不同，比例之间不可相加";
const ORDINAL_LIST = "2026-03-31 报告期十大流通股东：1. 北京用友科技有限公司 26.9582%；2. 上海用友科技咨询有限公司 11.4741%；3. 刘世强 0.9365%。集中度（横截面，非变动）：第一大流通股东 北京用友科技有限公司 持 26.9582%，十大流通股东合计持股占总股本 53.4234%，共 10 名披露。口径：名单为十大流通股东（不是十大股东，限售股不计入流通盘）；比例为接口 HOLD_RATIO 字段＝占总股本比例，不是占流通股比例";

test("名单后面跟着附注句时，名单照排、附注照留——不许因为多一句就整段退回散文", () => {
  const table = parseHolders(SEC_WITH_NOTE);
  assert.ok(table, "名单本身是规整的，多一句附注不该让它排不出表");
  assert.equal(table.rows.length, 3);
  assert.equal(table.rows[0].name, "Thomas M. Siebel");
  assert.match(table.notes, /股份类别：Class A Common Stock/, "股份类别丢了——那正是这些比例的分母");
  assert.match(table.basis, /非占总股本/, "口径丢了");
});

test("「1. 」这种序号不进股东名——排位已经由行的顺序表达了", () => {
  const table = parseHolders(ORDINAL_LIST);
  assert.ok(table);
  assert.equal(table.rows[0].name, "北京用友科技有限公司", "序号被吃进了名字里");
  assert.equal(table.rows[2].name, "刘世强");
  assert.equal(table.rows[0].pct, "26.9582");
  assert.match(table.notes, /合计持股占总股本 53\.4234%/, "集中度附注丢了");
});

test("以数字开头的比例不许被当成序号切掉", () => {
  // `1.8507%` 和 `1. 北京用友` 前两个字符一样，只差一个空格。
  const table = parseHolders("香港中央结算有限公司（其它）1.8507%；UBS AG（QFII）1.5342%");
  assert.equal(table.rows[0].pct, "1.8507", "比例的整数位被当序号切了");
});

test("附注、引子、口径三段合起来必须覆盖原文里的每一句", () => {
  // 排表的风险是「排版顺手把限定句丢了」。这条盯的就是不丢。
  for (const raw of [SEC_WITH_NOTE, ORDINAL_LIST]) {
    const table = parseHolders(raw);
    const kept = [table.preamble, table.notes, table.basis].filter(Boolean).join("。");
    for (const sentence of raw.split("。").map(s => s.trim()).filter(Boolean)) {
      if (sentence.includes("；") && /%/.test(sentence)) continue; // 名单句本身排进了表
      const head = sentence.split("：")[0];
      assert.ok(kept.includes(head), `「${head}」这一句在排表时丢了`);
    }
  }
});
