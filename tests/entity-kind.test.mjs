// 主体本体类型的行为测试。
//
// 这组断言锁的是一件真实踩到的事：抓 7 篇真实报道，10 个主体里 5 个不是法人
// （「昆仑云」是品牌、「万洋众创城」是园区、「巴斯夫（广东）一体化基地」是项目、
//  「海油安澜号」是设备）。六道门查不出这类问题——门问证据够不够，不问主体是不是法人。
//
// 所以这里要保证的不是"分类分得准"，而是"分不准的时候往存疑一侧倒"：
// 认不出来必须落 unknown，绝不能默认 legal。错标 legal 的代价是把品牌名
// 当法人写进台账，而且不会再有人复核。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.mjs";

const outDir = buildKernel();
const require = createRequire(import.meta.url);
const { classifyEntity, ENTITY_KINDS } = require(`${outDir}/extractor.js`);

test("认不出来的主体落 unknown，不落 legal", () => {
  // 模型没标 / 标了垃圾值 / 标了不在枚举里的值，一律 unknown。
  for (const declared of [undefined, null, "", "公司", "LEGAL_ENTITY", 42, {}]) {
    assert.equal(classifyEntity("某个说不清的名字", declared), "unknown",
      `declared=${JSON.stringify(declared)} 应落 unknown`);
  }
});

test("模型标注在枚举内时被采纳", () => {
  assert.equal(classifyEntity("昆仑云", "brand"), "brand");
  assert.equal(classifyEntity("海油安澜号", "asset"), "asset");
  assert.equal(classifyEntity("大写也要认", "BRAND"), "brand");
  assert.equal(classifyEntity(" 前后有空格 ", " project "), "project");
});

test("字面尾缀覆盖模型标注——字面证据比模型判断可靠", () => {
  // 实测模型会把带"基地""产业园"的名字标成 legal，这里必须纠正回来。
  assert.equal(classifyEntity("巴斯夫（广东）一体化基地", "legal"), "project");
  assert.equal(classifyEntity("万洋众创城", "legal"), "site");
  assert.equal(classifyEntity("韶关数据中心集群", "legal"), "site");
  // 反向也要成立：真法人被模型误标成品牌时，尾缀把它救回来。
  assert.equal(classifyEntity("昆仑云晟（北京）科技有限公司", "brand"), "legal");
  assert.equal(classifyEntity("某某股份有限公司", "unknown"), "legal");
});

test("品牌名不因为出现在法人名的前缀里就被当成法人", () => {
  // 「昆仑云」是「昆仑云晟（北京）科技有限公司」的前缀，但它自己不是法人。
  assert.equal(classifyEntity("昆仑云", "brand"), "brand");
  assert.notEqual(classifyEntity("昆仑云", undefined), "legal");
});

test("行政区前缀不影响法人判定", () => {
  // 「惠州市惠阳区胜宏科技」缺"有限公司"尾缀，不能算 legal。
  assert.notEqual(classifyEntity("惠州市惠阳区胜宏科技", undefined), "legal");
  assert.equal(classifyEntity("惠州市某某科技有限公司", undefined), "legal");
});

test("ENTITY_KINDS 保持六类，且含 legal 与 unknown", () => {
  // 有人往枚举里加类型时提醒他同步 prompt 和前端 KIND_LABEL。
  assert.equal(ENTITY_KINDS.length, 6);
  assert.ok(ENTITY_KINDS.includes("legal"));
  assert.ok(ENTITY_KINDS.includes("unknown"));
});
