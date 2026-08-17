// 判重层的纪律测试。
//
// 这一层最容易出的错不是"没认出重复"，而是"认出重复之后顺手替人做了决定"——
// 比如把判重结果混进证据强度、或者悄悄丢掉一条候选。所以下面既测识别，也测边界。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { buildKernel } from "./build-kernel.mjs";

const require = createRequire(import.meta.url);
const outDir = buildKernel();
const dedup = require(`${outDir}/dedup.js`);

/** 一份真实形态的披露原文（改了主体名）。 */
const DISCLOSURE = `甲电子股份有限公司关于对外投资的公告
本公司及董事会全体成员保证信息披露内容的真实、准确和完整。
公司于 2026 年 7 月 15 日与乙材料科技有限公司签署《增资协议》，
以自有资金人民币 32,000 万元认购乙材料新增注册资本，本次增资完成后，
公司持有乙材料 18.4% 的股权，并有权提名一名董事。`;

test("同一份披露被转载后排版变了，指纹不变", () => {
  const fp = dedup.corpusFingerprint(DISCLOSURE);

  // 转载时真实会发生的排版变化，逐个验：
  const variants = {
    "换行折成空格": DISCLOSURE.replace(/\n/g, " "),
    "缩进与多余空格": DISCLOSURE.split("\n").map(line => "    " + line + "  ").join("\n"),
    "全角空格": DISCLOSURE.replace(/ /g, "　"),
    "零宽字符残留": DISCLOSURE.replace("增资协议", "增​资‍协议"),
    "全角标点折半角": DISCLOSURE.replace(/（/g, "(").replace(/）/g, ")"),
    "首尾空白": "\n\n  " + DISCLOSURE + "  \n\n",
    // 下面三个是真实抓下来时踩到的，上面那批全过、它们全不过：
    // 归一化只把连续空白折成「一个空格」，没解决「有没有空格」。
    // 原文 "，" 与转载版 "， " 折完仍然不同，指纹照样被打散。
    "标点后多一个空格": DISCLOSURE.replace(/，/g, "， "),
    "全角空格当分隔": DISCLOSURE.replace(/\n+/g, "　 "),
    "汉字之间被塞进空格": DISCLOSURE.replace("本公司", "本 公 司"),
  };
  for (const [label, variant] of Object.entries(variants)) {
    assert.equal(dedup.corpusFingerprint(variant), fp, `${label} 应当被认成同一份`);
  }
});

test("拉丁词之间的空格是词边界，不许跟着一起删", () => {
  // 删掉紧贴汉字的空格是安全的，但这条规则不能蔓延到字母数字之间——
  // 那里空格分开的是两个词，"Model X" 折成 "ModelX" 就是改内容了。
  const a = "公司代号 Model X Pro 于 2026 年量产";
  const b = "公司代号 ModelXPro 于 2026 年量产";
  assert.notEqual(dedup.corpusFingerprint(a), dedup.corpusFingerprint(b));

  // 全角字母同理：ＡＢ Ｃ 不能折成 ABC。
  assert.notEqual(
    dedup.corpusFingerprint("型号 ＡＢ Ｃ 已停产"),
    dedup.corpusFingerprint("型号 ＡＢＣ 已停产"),
  );

  // 但汉字与拉丁词之间的空格仍然该删——那是排版，不是词边界。
  assert.equal(
    dedup.corpusFingerprint("公司代号 Model X Pro 于 2026 年量产"),
    dedup.corpusFingerprint("公司代号Model X Pro于2026年量产"),
  );
});

test("内容真的不同，指纹就不同——不做近似匹配", () => {
  const fp = dedup.corpusFingerprint(DISCLOSURE);
  // 只改一个数字：18.4% → 18.5%。这是两份不同的披露，绝不许折叠。
  const altered = DISCLOSURE.replace("18.4%", "18.5%");
  assert.notEqual(dedup.corpusFingerprint(altered), fp);
  // 只改金额同理。
  assert.notEqual(dedup.corpusFingerprint(DISCLOSURE.replace("32,000", "23,000")), fp);
});

test("判重只描述事实，不给分数也不给建议", () => {
  const verdict = dedup.repeatVerdict([{
    id: "c1", fingerprint: "f", sourceName: "巨潮资讯网", sourceUrl: null,
    entryPoint: "collect", seenAt: "2026-07-16T00:00:00.000Z", textLength: 300, candidatesCount: 2,
  }], "巨潮资讯网");

  assert.equal(verdict.seen, true);
  assert.equal(verdict.timesSeen, 1);
  assert.equal(verdict.differentSource, false);
  // 结论里不许出现相似度/置信度这类会被当成判断依据的数字。
  assert.ok(!/\d+%|相似度|置信/.test(verdict.message), `不许给相似度分数：${verdict.message}`);
  // 也不许替人做决定。
  for (const word of ["建议", "应该丢弃", "自动"]) {
    assert.ok(!verdict.message.includes(word), `不许给建议：${word}`);
  }
});

test("换来源给同一份材料，明确点出这是转载而不是第二来源", () => {
  const verdict = dedup.repeatVerdict([{
    id: "c1", fingerprint: "f", sourceName: "巨潮资讯网", sourceUrl: null,
    entryPoint: "collect", seenAt: "2026-07-16T00:00:00.000Z", textLength: 300, candidatesCount: 2,
  }], "某财经媒体");

  assert.equal(verdict.differentSource, true);
  assert.match(verdict.message, /转载/);
  // 必须说出第一次是谁给的，否则人无法判断这两个来源是什么关系。
  assert.match(verdict.message, /巨潮资讯网/);
});

test("没见过就返回 null，不返回一个 seen=false 的对象", () => {
  // 空对象会让调用方写出 if (verdict) 这种误判。没见过就是没有结论。
  assert.equal(dedup.repeatVerdict([], "任意来源"), null);
});

test("判重永远不碰六道门", async () => {
  const source = await (await import("node:fs/promises")).readFile(
    new URL("../lib/dedup.ts", import.meta.url), "utf8");
  // 判重层不许 import 判定内核，也不许自己出现门相关的字段名。
  assert.ok(!source.includes("field-core"), "判重层不许依赖判定内核");
  for (const word of ["signedOff", "gateState", "executable", "epistemicState", "falsifier"]) {
    assert.ok(!source.includes(word), `判重层不许触碰门字段：${word}`);
  }
});

test("同一毫秒内两个来源给同一份材料，两条 sighting 都要留住", () => {
  // 回归：曾经 id 只用「时间戳 + 指纹」拼，配 INSERT OR REPLACE，
  // 后一条会静默盖掉前一条，于是「来源A 也给过」这个事实消失，
  // timesSeen 和 firstSource 双双失真——而判重层的全部价值就在这两个数上。
  const db = new Database(":memory:");
  dedup.ensureCorpusTable(db);
  const fp = dedup.corpusFingerprint(DISCLOSURE);
  const at = "2026-07-16T02:00:00.000Z";
  const entry = (sourceName, entryPoint) => ({
    fingerprint: fp, sourceName, sourceUrl: null, entryPoint,
    seenAt: at, textLength: DISCLOSURE.length, candidatesCount: 1,
  });
  dedup.recordSighting(db, entry("巨潮资讯网", "collect"));
  dedup.recordSighting(db, entry("某财经媒体", "extract"));

  const prior = dedup.priorSightings(db, fp);
  assert.equal(prior.length, 2, "两个来源的记录都必须在");
  assert.deepEqual(prior.map(row => row.sourceName), ["巨潮资讯网", "某财经媒体"]);
  // 首次来源必须仍是真正的第一个。
  assert.equal(dedup.repeatVerdict(prior, "第三方").firstSource, "巨潮资讯网");
});

test("同一次事件重放不重复计数——幂等", () => {
  // 重试、双击、页面重发都会造成同一事件重放。它不该把「见过几次」抬高。
  const db = new Database(":memory:");
  dedup.ensureCorpusTable(db);
  const fp = dedup.corpusFingerprint(DISCLOSURE);
  const entry = {
    fingerprint: fp, sourceName: "巨潮资讯网", sourceUrl: "https://example/a",
    entryPoint: "collect", seenAt: "2026-07-16T02:00:00.000Z",
    textLength: DISCLOSURE.length, candidatesCount: 2,
  };
  dedup.recordSighting(db, entry);
  dedup.recordSighting(db, entry);
  dedup.recordSighting(db, entry);
  assert.equal(dedup.priorSightings(db, fp).length, 1);
});

/**
 * 每个调 extractRelations 的入口都必须归到两类之一，不许有第三类：
 *
 *   语料类（collect / extract）——输入是有来源的真实材料，会变成证据。
 *                                 必须过判重，否则转载会伪装成第二来源。
 *   假设类（simulate）——输入是人写的假设场景，判重无从谈起（没有"来源"可言）。
 *                        它必须保证另一件同等强度的事：产物永远不能变成证据。
 *
 * 新增入口时这条测试会失败，逼人明确它属于哪一类。这比白名单可靠——
 * 白名单是"我记得给它开了口子"，这里是"你必须说清它凭什么不判重"。
 */
test("每个抽取入口都必须归类：语料类判重，假设类不许产出证据", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const apiDir = new URL("../app/api/", import.meta.url);
  const entries = [];
  for (const name of await readdir(apiDir)) {
    let source;
    try { source = await readFile(new URL(`${name}/route.ts`, apiDir), "utf8"); } catch { continue; }
    if (source.includes("extractRelations(")) entries.push({ name, source });
  }
  assert.ok(entries.length >= 3, `应当发现至少三个抽取入口，实际 ${entries.length}`);

  const CORPUS = ["collect", "extract", "query"];
  const HYPOTHESIS = ["simulate"];
  for (const { name, source } of entries) {
    assert.ok(CORPUS.includes(name) || HYPOTHESIS.includes(name),
      `新入口 ${name} 未归类：要么过判重（语料类），要么强制 origin=simulation（假设类）`);

    if (CORPUS.includes(name)) {
      assert.ok(source.includes("corpusFingerprint("), `${name} 必须算语料指纹`);
      assert.ok(source.includes("priorSightings("), `${name} 必须查判重台账`);
      assert.ok(source.includes("recordSighting("), `${name} 抽完必须记一次 sighting`);
      // 判重必须在调模型之前：放在后面就既没省 token，也没拦住台账污染。
      assert.ok(source.indexOf("priorSightings(") < source.indexOf("extractRelations("),
        `${name} 的判重必须在 extractRelations 之前`);
    } else {
      // 假设类：服务端强制打标，不能只靠前端或模型自觉。
      assert.match(source, /origin:\s*"simulation"/, `${name} 必须在服务端强制 origin=simulation`);
      assert.ok(!source.includes("recordSighting("),
        `${name} 不许写判重台账——假设不是见过的材料，混进去会污染"见过几次"`);
    }
  }
});
