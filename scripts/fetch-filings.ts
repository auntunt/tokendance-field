// 真去抓：把名单里的上市公司过一遍法定披露，抽出字段，落盘成事实缓存。
//
// 用法：
//   npx tsx scripts/fetch-filings.ts                 # 抓全部已配代码的公司
//   npx tsx scripts/fetch-filings.ts --only 002230   # 只抓一家（调试用）
//   npx tsx scripts/fetch-filings.ts --cache-only    # 不联网，只用已下载的原文重抽
//
// 产物：
//   .filing-cache/<id>.txt    原文（不进 git，几 MB 一份）
//   data/filing-facts.json    抽出的事实，带出处和逐字引语 —— 这份是报告要读的
//
// ============ 为什么原文要缓存 ============
// 抽取规则会反复改，而每改一次都重新下 8 份 PDF（最大的 8MB）要几分钟，
// 且是在给别人的服务器加无谓的负载。原文落盘之后 --cache-only 重抽是秒级的。
// 缓存也让「同一份原文、规则改了之后抽出什么变了」可回溯。
//
// ============ 关于抓取礼貌 ============
// 顺序抓、每家之间停 1.5 秒。这几个源都是公共披露平台，没有 robots 禁止，
// 但没有理由并发去压它们——一次全量也就 8 家，慢一点无所谓。
// SEC 明文要求 User-Agent 带联系方式，照做（见 lib/filing-sources.ts）。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = resolve(root, ".filing-cache");
const outFile = resolve(root, "data/filing-facts.json");

const outDir = resolve(root, ".report-build");
execFileSync(resolve(root, "node_modules/.bin/tsc"), [
  "lib/fde-dimensions.ts", "lib/company-profile.ts", "lib/fde-roster.ts",
  "lib/pdf-text.ts", "lib/filing-sources.ts", "lib/filing-extract.ts",
  "lib/holder-sources.ts", "lib/holder-extract.ts", "lib/filing-merge.ts",
  "lib/hk-holder-extract.ts", "lib/us-holder-extract.ts",
  "--outDir", ".report-build", "--module", "commonjs", "--moduleResolution", "node10",
  "--target", "es2022", "--strict", "--skipLibCheck",
], { cwd: root, stdio: "inherit" });
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "package.json"), '{"type":"commonjs"}');

const require = createRequire(import.meta.url);
const sources = require(`${outDir}/filing-sources.js`);
const extract = require(`${outDir}/filing-extract.js`);
const roster = require(`${outDir}/fde-roster.js`);
const holderSources = require(`${outDir}/holder-sources.js`);
const holderExtract = require(`${outDir}/holder-extract.js`);
const hkHolders = require(`${outDir}/hk-holder-extract.js`);
const usHolders = require(`${outDir}/us-holder-extract.js`);
const merge = require(`${outDir}/filing-merge.js`);

const only = (() => {
  const index = process.argv.indexOf("--only");
  return index >= 0 ? process.argv[index + 1] : null;
})();
const cacheOnly = process.argv.includes("--cache-only");
const today = new Date().toISOString().slice(0, 10);

// 美股公司要 CIK 才能查 EDGAR。ticker→CIK 是固定对照，写在这里而不是名单里，
// 因为它属于「怎么抓」而不是「这家公司是谁」。
const CIK = { PLTR: "1321655", SNOW: "1640147", AI: "1577526", PL: "1836833", APPN: "1441683", ACN: "1467373" };

const targets = roster.ROSTER.filter(entry => {
  if (only) return entry.ticker?.startsWith(only) || entry.id === only;
  if (entry.listing === "cn-a") return Boolean(entry.ticker);
  if (entry.listing === "us") return Boolean(CIK[entry.ticker ?? ""]);
  if (entry.listing === "hk") return Boolean(entry.ticker);
  return false; // 未上市的 7 家没有法定披露，这条路线覆盖不到它们
});

mkdirSync(cacheDir, { recursive: true });
mkdirSync(dirname(outFile), { recursive: true });

const sleep = ms => new Promise(done => setTimeout(done, ms));
const results = [];
const holderResults = [];
const failures = [];

console.log(`目标 ${targets.length} 家${cacheOnly ? "（仅用缓存）" : ""}\n`);

for (const entry of targets) {
  const cachePath = resolve(cacheDir, `${entry.id}.txt`);
  const metaPath = resolve(cacheDir, `${entry.id}.json`);
  let filing = null;

  try {
    if (existsSync(cachePath) && existsSync(metaPath) && cacheOnly) {
      filing = { ...JSON.parse(readFileSync(metaPath, "utf8")), text: readFileSync(cachePath, "utf8") };
      console.log(`· ${entry.name}　用缓存：${filing.title}`);
    } else if (cacheOnly) {
      console.log(`· ${entry.name}　跳过（无缓存）`);
      continue;
    } else {
      process.stdout.write(`· ${entry.name}（${entry.ticker}）取件…`);
      filing = entry.listing === "cn-a"
        ? await sources.fetchLatestAnnualReport(entry.ticker)
        : entry.listing === "hk"
          ? await sources.fetchLatestHkAnnualReport(entry.ticker)
          : await sources.fetchLatest10K(CIK[entry.ticker]);
      if (!filing) { console.log(" 没找到年报/10-K"); failures.push({ id: entry.id, name: entry.name, why: "未找到披露文件" }); continue; }
      writeFileSync(cachePath, filing.text);
      writeFileSync(metaPath, JSON.stringify({ title: filing.title, date: filing.date, url: filing.url }));
      console.log(` ${filing.title}（${(filing.text.length / 1024).toFixed(0)}K 字符）`);
      await sleep(1500);
    }

    // 港股年报走 A 股那套规则还是 10-K 那套：都不完全对。
    // 港股年报是英文，措辞跟 10-K 更近（「we had N employees」这类），
    // 但章节结构随中国内地公司的习惯。实测 0020/6682 有 "we had"、0354/0268 没有，
    // 所以两套都跑，谁抽到算谁的——规则本身只在命中时产出事实，不会互相污染。
    const items = entry.listing === "cn-a"
      ? extract.extractFromAnnualReport(filing.text)
      : entry.listing === "hk"
        ? [...extract.extractFrom10K(filing.text), ...extract.extractFromAnnualReport(filing.text)]
        : extract.extractFrom10K(filing.text);

    // 岗位名词频核查：命中与否都记一条。这是这份报告要回答的核心问题，
    // 「法定披露里根本不提这个词」本身就是结论。
    // 港股要中英文都查：中软国际英文年报里 "Forward Deployed" 命中 2 次，
    // 金蝶的繁体年报里「實施」43 次、「交付」7 次——只查一种语言会漏掉真信号。
    const terms = entry.listing === "cn-a"
      ? ["前置部署", "驻场", "交付工程师", "解决方案架构师"]
      : entry.listing === "hk"
        ? ["Forward Deployed", "forward-deployed", "deployment strategist", "embed with",
           "on-site", "駐場", "驻场", "交付", "實施"]
        : ["Forward Deployed", "forward-deployed", "deployment strategist", "embed with"];
    const audit = extract.termAudit(filing.text, terms);

    const facts: Record<string, Record<string, any>> = {};
    for (const item of items) {
      (facts[item.dimension] ||= {})[item.key] =
        extract.toSourced(item, filing.title, filing.url, today, "statutory");
    }
    (facts.fde ||= {}).fdeNaming = extract.toSourced(
      { dimension: "fde", key: "fdeNaming", value: audit.value, quote: audit.quote },
      filing.title, filing.url, today, "statutory");

    const count = Object.values(facts).reduce((sum, dim) => sum + Object.keys(dim).length, 0);
    console.log(`    抽出 ${count} 条：${Object.entries(facts).map(([k, v]) => `${k}×${Object.keys(v).length}`).join(" ")}`);
    results.push({ id: entry.id, name: entry.name, ticker: entry.ticker, filing: { title: filing.title, date: filing.date, url: filing.url }, facts });
  } catch (error) {
    console.log(` 失败：${String(error.message).slice(0, 120)}`);
    failures.push({ id: entry.id, name: entry.name, why: String(error.message).slice(0, 200) });
  }
}

// ============ 第二趟：A 股股东数据 ============
// 为什么单独一趟而不是塞进上面的循环：年报路线和股东接口路线的失败是独立的。
// 年报没抓到不该连带丢掉股东数据（反过来也一样），分两趟每家各自记账最清楚。
// 定级钉死 independent —— 这是东方财富整理的二手结构化数据，不是法定披露原文。
//
// 港股和美股的股东数据不在这一趟：它们的股东表就在第一趟已经下载的
// 年报 / DEF 14A 原文里，是 statutory 级，不需要再打一次网络请求。
// 见下面的第三趟和第四趟。
const holderTargets = targets.filter(entry => entry.listing === "cn-a" && entry.ticker);
if (holderTargets.length) console.log(`\n股东数据 ${holderTargets.length} 家${cacheOnly ? "（仅用缓存）" : ""}`);

for (const entry of holderTargets) {
  const secucode = holderSources.toSecucode(entry.ticker);
  if (!secucode) { failures.push({ id: entry.id, name: entry.name, why: `ticker 不是交易所代码格式：${entry.ticker}` }); continue; }
  const rawPath = resolve(cacheDir, `${entry.id}.holders.json`);
  let rows = null;
  const url = holderSources.holderApiUrl(secucode);

  try {
    if (cacheOnly) {
      if (!existsSync(rawPath)) { console.log(`· ${entry.name}　跳过（无股东缓存）`); continue; }
      // 缓存里存的是接口原始响应体，离线重抽必须走同一个解析函数，
      // 否则「离线能过、在线炸」这类差异根本测不出来。
      rows = holderSources.rowsOfResponse(JSON.parse(readFileSync(rawPath, "utf8")));
      console.log(`· ${entry.name}　用股东缓存：${rows.length} 行`);
    } else {
      process.stdout.write(`· ${entry.name}（${secucode}）股东取件…`);
      const got = await holderSources.fetchHolders(secucode);
      if (!got) { console.log(" 没取到"); failures.push({ id: entry.id, name: entry.name, why: "东方财富股东接口未返回数据" }); await sleep(1500); continue; }
      // 存原始响应体而不是 rows：事后要能核对我们从哪一坨里挑出的报告期。
      writeFileSync(rawPath, JSON.stringify({ fetchedAt: today, secucode, url: got.url, result: { data: got.rows } }, null, 2));
      rows = got.rows;
      console.log(` ${rows.length} 行`);
      await sleep(1500);
    }

    const period = holderExtract.periodOf(rows);
    const items = holderExtract.extractHolderFacts(rows, secucode);
    if (!items.length) { failures.push({ id: entry.id, name: entry.name, why: "股东数据存在但抽不出带引语的事实" }); continue; }

    const facts = {};
    const source = `东方财富 F10 十大流通股东（${secucode}，报告期 ${period}）`;
    for (const item of items) {
      (facts[item.dimension] ||= {})[item.key] = holderExtract.toSourced(item, source, url, today, "independent");
    }
    console.log(`    抽出 ${items.length} 条独立第三方级事实（报告期 ${period}）`);
    holderResults.push({
      id: entry.id, name: entry.name, ticker: entry.ticker,
      filing: { title: source, date: period ?? today, url },
      facts,
      keepFiling: true, // 不许覆盖年报出处，见 lib/filing-merge.ts
    });
  } catch (error) {
    console.log(` 失败：${String(error.message).slice(0, 120)}`);
    failures.push({ id: entry.id, name: entry.name, why: String(error.message).slice(0, 200) });
  }
}

// ============ 第三趟：港股主要股东（复用第一趟已下载的年报原文） ============
// 不再打网络请求：股东表就在第一趟下载的年报 PDF 文本里。
// 定级 statutory —— 这是 SFO 第XV部第2、3分部下、按第336条存置的登记册所载权益，
// 是法定披露原文，比 A 股那条东方财富路线（independent）高一级。
const hkTargets = targets.filter(entry => entry.listing === "hk" && entry.ticker);
if (hkTargets.length) console.log(`\n港股主要股东 ${hkTargets.length} 家`);

for (const entry of hkTargets) {
  const cachePath = resolve(cacheDir, `${entry.id}.txt`);
  const metaPath = resolve(cacheDir, `${entry.id}.json`);
  if (!existsSync(cachePath) || !existsSync(metaPath)) {
    console.log(`· ${entry.name}　跳过（第一趟没拿到年报）`);
    continue;
  }
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const text = readFileSync(cachePath, "utf8");
    const facts = hkHolders.extractHkHolderFacts(text, meta.title, meta.url, today);
    if (!facts.majorHolders) {
      // 抽不到就记失败，不写空壳。报告里显示成待办，比显示一个猜的数好。
      failures.push({ id: entry.id, name: entry.name, why: "港股年报里未定位到主要股东表" });
      console.log(`· ${entry.name}　未定位到主要股东表`);
      continue;
    }
    const rows = hkHolders.extractHkHolderRows(text);
    console.log(`· ${entry.name}　${rows.length} 名主要股东（截至 ${hkHolders.asAtDate(text) ?? "未标注"}）`);
    holderResults.push({
      id: entry.id, name: entry.name, ticker: entry.ticker,
      filing: { title: meta.title, date: meta.date, url: meta.url },
      facts: { shareholders: { majorHolders: facts.majorHolders } },
      keepFiling: true, // 出处就是年报本身，跟第一趟同源，不该互相覆盖
    });
  } catch (error) {
    console.log(`· ${entry.name}　失败：${String(error.message).slice(0, 120)}`);
    failures.push({ id: entry.id, name: entry.name, why: String(error.message).slice(0, 200) });
  }
}

// ============ 第四趟：美股 5% 以上股东（DEF 14A） ============
// 为什么要单独取一份文件：股东表不在 10-K 里，在委托书（DEF 14A）里。
// 定级 statutory —— Schedule 14A Item 6 / Reg S-K Item 403 下的法定披露。
// 注意缓存后缀是 .proxy.htm 而不是 .txt：这里存的是**原始 HTML**，
// 因为表格结构必须保留（htmlToPlain 会把表格压成一串数字，名字和比例再也配不上）。
const usTargets = targets.filter(entry => entry.listing === "us" && CIK[entry.ticker ?? ""]);
if (usTargets.length) console.log(`\n美股 5% 以上股东 ${usTargets.length} 家${cacheOnly ? "（仅用缓存）" : ""}`);

for (const entry of usTargets) {
  const proxyPath = resolve(cacheDir, `${entry.id}.proxy.htm`);
  const proxyMetaPath = resolve(cacheDir, `${entry.id}.proxy.json`);
  let proxy = null;

  try {
    if (existsSync(proxyPath) && existsSync(proxyMetaPath) && cacheOnly) {
      proxy = { ...JSON.parse(readFileSync(proxyMetaPath, "utf8")), text: readFileSync(proxyPath, "utf8") };
      console.log(`· ${entry.name}　用缓存：${proxy.title}`);
    } else if (cacheOnly) {
      console.log(`· ${entry.name}　跳过（无委托书缓存）`);
      continue;
    } else {
      process.stdout.write(`· ${entry.name}（${entry.ticker}）委托书取件…`);
      proxy = await sources.fetchLatestProxy(CIK[entry.ticker]);
      if (!proxy) {
        console.log(" 没找到 DEF 14A");
        failures.push({ id: entry.id, name: entry.name, why: "未找到 DEF 14A" });
        await sleep(1500);
        continue;
      }
      writeFileSync(proxyPath, proxy.text);
      writeFileSync(proxyMetaPath, JSON.stringify({ title: proxy.title, date: proxy.date, url: proxy.url }));
      console.log(` ${proxy.title}（${(proxy.text.length / 1024).toFixed(0)}K 字符）`);
      await sleep(1500);
    }

    const facts = usHolders.extractUsHolderFacts(proxy.text, proxy.title, proxy.url, today);
    if (!facts.majorHolders) {
      failures.push({ id: entry.id, name: entry.name, why: "DEF 14A 里未定位到 5% 以上股东段" });
      console.log(`    未定位到 5% 以上股东段`);
      continue;
    }
    const main = usHolders.findOwnershipTables(proxy.text)[0];
    const sliced = main ? usHolders.sliceFivePercentRows(main.cells) : null;
    const standalone = sliced ? null : usHolders.findStandaloneFivePercentTable(proxy.text);
    const rows = usHolders.parseUsHolderRows(sliced ?? standalone.cells);
    console.log(`    ${rows.length} 名 5% 以上股东（${standalone ? "独立小表" : "主表分段"}）`);

    holderResults.push({
      id: entry.id, name: entry.name, ticker: entry.ticker,
      filing: { title: proxy.title, date: proxy.date, url: proxy.url },
      facts: { shareholders: { majorHolders: facts.majorHolders } },
      keepFiling: true, // 第一趟的出处是 10-K，别被委托书顶掉
    });
  } catch (error) {
    console.log(` 失败：${String(error.message).slice(0, 120)}`);
    failures.push({ id: entry.id, name: entry.name, why: String(error.message).slice(0, 200) });
  }
}

// ============ 落盘：合并，不是替换 ============
// 原来这里直接写本次结果，于是 `--only 301236` 把 13 家的产物覆盖成 1 家。
// 抹掉不报错也不留痕，只有下次 build-report 覆盖率暴跌才会发现。见 lib/filing-merge.ts。
const previous = existsSync(outFile)
  ? JSON.parse(readFileSync(outFile, "utf8"))
  : merge.EMPTY_FILING_FACTS;
// 四趟都要进 touchedIds：漏掉哪一趟，合并层就会把那一趟的公司当成「这次没碰过」，
// 于是它的旧事实既不更新也不标记过期——一个不报错的静默陈旧。
const touchedIds = [...new Set([...targets, ...holderTargets, ...hkTargets, ...usTargets].map(entry => entry.id))];
const merged = merge.mergeFilingFacts(previous, [...results, ...holderResults], failures, today, touchedIds);
writeFileSync(outFile, JSON.stringify(merged, null, 2));

const total = results.reduce((sum, item) => sum + Object.values(item.facts as Record<string, object>).reduce((n, dim) => n + Object.keys(dim).length, 0), 0);
const holderTotal = holderResults.reduce((sum, item) => sum + Object.values(item.facts as Record<string, object>).reduce((n, dim) => n + Object.keys(dim).length, 0), 0);
console.log(`\n成功 ${results.length}/${targets.length} 家，共 ${total} 条法定披露级事实`);
// holderResults 现在混了三条路线（A股 independent、港股/美股 statutory），
// 所以这里不能再说「共 N 条独立第三方级事实」——那会把港美两条也说成二手数据。
console.log(`股东数据 ${holderResults.length}/${holderTargets.length + hkTargets.length + usTargets.length} 家，共 ${holderTotal} 条（A股 independent，港股/美股 statutory）`);
console.log(`合并后产物：${merged.companies.length} 家，statutory ${merge.countByGrade(merged, "statutory")} 条 / independent ${merge.countByGrade(merged, "independent")} 条`);
if (failures.length) {
  console.log(`失败 ${failures.length} 家：`);
  for (const item of failures) console.log(`  - ${item.name}：${item.why}`);
}
console.log(`写入 ${outFile.replace(root + "/", "")}`);
