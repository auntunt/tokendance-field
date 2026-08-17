// PDF 采集分支的行为测试。
//
// 背景：抓 7 篇公开报道，主体一半不是法人、关系类型被硬塞；换成交易所法定披露后
// 同一个抽取器 20 个主体里 19 个是法人全称。差别在语料不在抽取器——
// 披露规则强制写全称、强制说明利益冲突。而披露公告的载体是 PDF，不接就用不了。
//
// 这里锁两件事：PDF 的识别不能漏（交易所用大写 .PDF），
// 以及扫描件要给出能让人行动的错误，而不是静默返回空。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.mjs";

const outDir = buildKernel();
const require = createRequire(import.meta.url);
const { looksLikePdf, pdfToText } = require(`${outDir}/pdf-text.js`);

test("大写 .PDF 也要认出来——交易所就是这么写的", () => {
  // 实测的真实路径形状。只匹配小写会漏掉整个数据源。
  assert.ok(looksLikePdf("http://static.cninfo.com.cn/finalpage/2026-08-08/1225465157.PDF"));
  assert.ok(looksLikePdf("https://static.sse.com.cn/disclosure/x/605336_20260808_NQ5Y.pdf"));
  assert.ok(looksLikePdf("http://example.com/a.PdF"));
});

test("content-type 和 URL 两头都能判定", () => {
  // 有些站点给 PDF 发 octet-stream，URL 又没扩展名，反之也有。任一命中即可。
  assert.ok(looksLikePdf("http://example.com/download?id=9", "application/pdf"));
  assert.ok(looksLikePdf("http://example.com/x.PDF", "application/octet-stream"));
  assert.ok(looksLikePdf("http://example.com/x.PDF", undefined));
});

test("HTML 不能被误判成 PDF", () => {
  assert.equal(looksLikePdf("http://finance.people.com.cn/n1/2026/0807/c1004-40775835.html", "text/html"), false);
  // 路径里含 pdf 字样但不是扩展名的，不算。
  assert.equal(looksLikePdf("http://example.com/pdf-guide/intro.html", "text/html"), false);
  assert.equal(looksLikePdf("not a url at all"), false);
});

test("非 PDF 字节要报错，而不是返回空字符串静默通过", async () => {
  // 静默返回空的后果：采集器以为抓到了内容、写进台账、候选数 0，
  // 看日志的人以为"这篇确实没关系"，而实际是解析失败。
  await assert.rejects(
    () => pdfToText(new TextEncoder().encode("<html>这不是 PDF</html>")),
    /PDF 解析失败|未安装 pdftotext/,
  );
});

test("图片型 PDF 解出的文本长度不足，交给调用处拦", async () => {
  // 造一个结构合法但没有文字对象的最小 PDF。pdftotext 能解，但解出来是空的。
  // 这里只断言"不抛异常且几乎没有文本"——真正的拦截在 collect/route.ts 的
  // text.length < 40 检查里，会告诉人这可能是扫描件、需要 OCR。
  const minimal = [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj",
    "trailer<</Root 1 0 R>>",
    "%%EOF",
  ].join("\n");
  let text;
  try {
    text = await pdfToText(new TextEncoder().encode(minimal));
  } catch (error) {
    // pdftotext 缺失时跳过——本测试的目的不是验证 poppler 是否安装。
    if (/未安装 pdftotext/.test(String(error))) return;
    throw error;
  }
  assert.ok(text.length < 40, `无文字 PDF 应解出近空文本，实际 ${text.length} 字`);
});
