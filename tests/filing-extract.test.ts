// 抽取层的测试。语料是真年报和真 10-K 的节选（tests/fixtures/），
// 不是我编的样例文本——编的文本只能证明正则匹配自己写的字符串。
//
// 这里守的是三件事，坏掉任何一件都会让报告变得不可信：
//   1. 每条事实都带能回原文核对的逐字 quote
//   2. 抽不到就是抽不到，不拿相近的字段去顶（ratio 那条尤其）
//   3. 同样输入同样输出（否则定期重跑的「变更页」会满是假变更）

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, ".report-build");
execFileSync(resolve(root, "node_modules/.bin/tsc"), [
  "lib/fde-dimensions.ts", "lib/filing-extract.ts",
  "--outDir", ".report-build", "--module", "commonjs", "--moduleResolution", "node10",
  "--target", "es2022", "--strict", "--skipLibCheck",
], { cwd: root, stdio: "inherit" });
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "package.json"), '{"type":"commonjs"}');
const require = createRequire(import.meta.url);
const extract = require(`${outDir}/filing-extract.js`);

const CN = readFileSync(resolve(root, "tests/fixtures/annual-report-excerpt.txt"), "utf8");
const US = readFileSync(resolve(root, "tests/fixtures/10k-excerpt.txt"), "utf8");
const flat = text => text.replace(/\s+/g, " ");

test("年报能抽出实控人、员工数、客户集中度", () => {
  const items = extract.extractFromAnnualReport(CN);
  const get = key => items.find(item => item.key === key);
  assert.equal(get("controller")?.value, "刘庆峰");
  assert.match(get("headcount")?.value, /全员 16,818 人/);
  assert.equal(get("customers")?.value, "16.72%");
  assert.equal(get("majorHolders")?.value, "无控股主体");
});

test("勾选框必须翻成人话，不能把 □适用☑不适用 当值填进报告", () => {
  const items = extract.extractFromAnnualReport(CN);
  for (const item of items) {
    assert.doesNotMatch(item.value, /[□☑]/,
      `${item.key} 的值里带勾选框符号，报告里读不出它在回答什么：${item.value}`);
  }
  const litigation = items.find(item => item.key === "litigation");
  assert.match(litigation.value, /无重大诉讼/);
});

test("每条事实都带 quote，且 quote 逐字出现在原文里", () => {
  for (const [label, text, fn] of [["年报", CN, extract.extractFromAnnualReport], ["10-K", US, extract.extractFrom10K]]) {
    const items = fn(text);
    assert.ok(items.length > 0, `${label} 一条都没抽到`);
    for (const item of items) {
      assert.ok(item.quote?.trim(), `${label} ${item.key} 没有 quote——没法核对的「法定披露级」比空着危险`);
      // 有些值由原文两处拼出（如「技术人员 X / 全员 Y」来自专业构成表和员工总数两行），
      // quote 用 ｜ 分段保存。逐段校验，而不是把拼接串当成一段原文去找。
      for (const segment of item.quote.split("｜")) {
        if (!segment.trim()) continue;
        assert.ok(flat(text).includes(flat(segment)),
          `${label} ${item.key} 的 quote 有一段不是原文逐字：${segment.slice(0, 80)}`);
      }
    }
  }
});

// 这条是刻意的空缺，不是漏抽。年报披露研发人员占比（59.70%），
// 但 ratio 问的是「交付人数与客户数之比」——年报不披露客户数。
// 把 59.70% 填进去会让读报告的人以为我们拿到了人效数据。
test("交付人数与客户数之比必须留空，不许拿研发人员占比去顶", () => {
  const items = extract.extractFromAnnualReport(CN);
  const ratio = items.find(item => item.dimension === "fde" && item.key === "ratio");
  assert.equal(ratio, undefined, "ratio 被填上了——年报给不出客户数，这个比值只能是推断");
  // 研发占比本身应该被记下来，但记在别处并写明口径
  const kept = items.find(item => item.key === "productization");
  assert.match(kept.value, /59\.70%/);
  assert.match(kept.value, /年报口径/, "借用的数字必须写明口径，否则会被当成交付数据");
});

test("研发人员数不许标成「核心高管与分工」", () => {
  const items = extract.extractFromAnnualReport(CN);
  const execs = items.find(item => item.dimension === "team" && item.key === "execs");
  assert.equal(execs, undefined, "研发人员总数不回答「核心高管与分工」，填进去就是错标");
  const leads = items.find(item => item.key === "fdeLeads");
  assert.match(leads.value, /研发人员 10,040 人/);
  assert.match(leads.value, /非交付岗口径/);
});

// 词频核查命中与否都要产出一条事实。实测 Palantir 2025 年 10-K 里
// 「Forward Deployed」出现 0 次，而 FDE 这个说法本身出自这家公司——
// 这个 0 是结论，不是失败，沉默掉它等于把最有信息量的发现丢了。
test("岗位名一次都没出现时，也要产出一条写明检索范围的事实", () => {
  const audit = extract.termAudit("这份文件里完全没有相关字样。", ["前置部署", "驻场"]);
  assert.match(audit.value, /全文未出现/);
  assert.match(audit.value, /前置部署/);
  assert.match(audit.quote, /前置部署=0/, "quote 必须写清在多大范围里数出这个 0");
  assert.match(audit.quote, /字符内检索/);
});

test("命中时 quote 给的是原文上下文，不是统计说明", () => {
  const audit = extract.termAudit("公司推行 FDE 咨询实施一体化模式，通过驻场式、迭代式交付打通最后一公里。", ["驻场"]);
  assert.match(audit.value, /驻场×1/);
  assert.match(audit.quote, /咨询实施一体化/, "命中了却只给统计数字，等于让人无法判断这个词的语境");
});

test("同一份原文抽两次结果完全一样", () => {
  const a = JSON.stringify(extract.extractFromAnnualReport(CN));
  const b = JSON.stringify(extract.extractFromAnnualReport(CN));
  assert.equal(a, b, "抽取不确定的话，定期重跑的变更页会满是假变更");
});

test("空文本和垃圾文本不抽出任何东西，也不抛异常", () => {
  for (const text of ["", "   \n\n  ", "毫不相关的一段话，什么字段都没有。", "%%%%".repeat(500)]) {
    assert.deepEqual(extract.extractFromAnnualReport(text), []);
    assert.deepEqual(extract.extractFrom10K(text), []);
  }
});

test("窗口不许跨到下一个标签的值上去", () => {
  // 标签后面紧跟的不是值、而是下一个标签时，应该抽空而不是把下一个字段的值拿来
  const text = "报告期末在职员工的数量合计（人）\n\n\n\n下一个完全无关的标题\n\n研发人员数量（人） 999";
  const items = extract.extractFromAnnualReport(text);
  const headcount = items.find(item => item.key === "headcount");
  assert.notEqual(headcount?.value, "999", "抽到了下一个字段的值——错位的值看着有值，其实是错的");
});

test("10-K 的员工数不会被前面无关的 we had 句子带偏", () => {
  const items = extract.extractFrom10K(US);
  const headcount = items.find(item => item.key === "headcount");
  assert.match(headcount.value, /4,429 full-time employees/);
});

// 下面三条守的是同一件事的三个面：交付团队规模这一格必须是「交付人力」，
// 而不是随便一个凑巧在「技术人员」四个字后面的数字。
// 三种误配都真实发生过，值都是逐字来自原文的——所以 quote 校验拦不住，
// 只有针对口径本身的断言能拦。

test("技术人员必须从「专业构成」表里取，不许匹配到正文套话", () => {
  // 科大讯飞年报里「核心技术人员、持股 5%以上股东…」出现在专业构成表之前，
  // 全文找第一处会抽出「5」（来自「5%」），报告里就成了「技术人员 5 人」。
  const items = extract.extractFromAnnualReport(CN);
  const headcount = items.find(item => item.key === "headcount");
  assert.match(headcount.value, /技术人员 10,040 人/);
  assert.match(headcount.value, /全员 16,818 人/, "要同时给出分母，否则读的人无法判断这个数的分量");
});

test("技术人员数不许超过全员数——超了就是抽错，退回只报全员", () => {
  const text = readFileSync(resolve(root, "tests/fixtures/bonc-staff.txt"), "utf8");
  const items = extract.extractFromAnnualReport(text);
  const headcount = items.find(item => item.key === "headcount");
  // 这份原文里「为技术人员提供专业开发环境…大模型智能体平台 6,166,665.17」
  // 那个数是产品收入金额。抽成人数的话是 616 万技术人员、7,034 全员。
  assert.ok(headcount, "该抽到 headcount");
  assert.doesNotMatch(headcount.value, /6,166,665/, "把产品收入金额抽成了技术人员数");
  assert.match(headcount.value, /技术人员 6,598 人 \/ 全员 7,034 人/);
});

test("披露了「现场实施」的公司要优先取它，并标明是哪一类口径", () => {
  // 恒生电子的专业构成表直接有「现场实施 1,567」——
  // 那是字面意义的驻场交付人数，比「产品技术 6,953」更接近这份报告要问的东西。
  const text = readFileSync(resolve(root, "tests/fixtures/hundsun-staff.txt"), "utf8");
  const items = extract.extractFromAnnualReport(text);
  const headcount = items.find(item => item.key === "headcount");
  assert.match(headcount.value, /现场实施 1,567 人/, "有现场实施口径却没优先取");
  assert.match(headcount.value, /全员 10,276 人/);
  assert.doesNotMatch(headcount.value, /^技术人员/, "取的是现场实施，标签却写技术人员会误导");
});

// 下面两条守的是 afterLabel 的窗口语义：window 限定「值从哪里开始」，
// 不限定「值能延伸到哪里」。两件事混在一起会以两种方式出错，
// 都真实发生过，都带着逐字 quote 和「法定披露」级别出现在报告里。

test("pdftotext -layout 的宽表格行里，数字不许被窗口切成半截", () => {
  // 这条要用保留列对齐的语料。lib/pdf-text.ts 不再合并连续空格之后，
  // 「现场实施 … 1,567」这一行超过 60 字符，窗口正好切在数字中间，
  // 抽出「1,56」——它看上去仍然像一个人数，比抽空危险得多。
  const text = readFileSync(resolve(root, "tests/fixtures/hundsun-staff-layout.txt"), "utf8");
  const items = extract.extractFromAnnualReport(text);
  const headcount = items.find(item => item.key === "headcount");
  assert.match(headcount.value, /现场实施 1,567 人/, "数字被窗口截断了");
  assert.doesNotMatch(headcount.value, /1,56 人/, "抽出了半截数字");
  assert.match(headcount.value, /全员 10,276 人/);
});

test("实控人必须紧跟标签，不许扫到几行之后的无关短语", () => {
  // 用友网络年报里「本企业最终控制方是王文京」后面直接换行。
  // 值的模式只认标点作终止符时，真名被跳过，而扫描继续往后走，
  // 会撞上「子公司详见附注十」并把它当成实控人写进报告。
  const text = readFileSync(resolve(root, "tests/fixtures/yonyou-controller.txt"), "utf8");
  const items = extract.extractFromAnnualReport(text);
  const controller = items.find(item => item.key === "controller");
  assert.equal(controller?.value, "王文京");
  assert.doesNotMatch(controller.value, /附注|子公司/, "把无关短语当成了实控人");
});
