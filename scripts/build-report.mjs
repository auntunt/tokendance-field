// 定期重跑的入口。跑一次 = 读语料 + 读名单 → 合并 → 和上一版比 → 出一个 HTML。
//
// 用法：
//   node scripts/build-report.mjs                       # 用默认语料路径
//   node scripts/build-report.mjs --corpus /path/data.json
//   node scripts/build-report.mjs --no-corpus           # 只出名单（语料不在手边时）
//
// 为什么是脚本而不是页面：这份报告的用途是「发出去」。单文件 HTML 能拷进微信、
// 能当邮件附件、能双击打开；控制台那套要登录、要过六道门，是另一回事。
//
// 快照存在 reports/history/ 下。下次重跑时读最近一份来做 diff——
// 「本次更新」那一节靠它，没有快照就没有变更页，只能显示「首次生成」。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CORPUS = "/Users/auntlee/Desktop/workspace/同行信息查找/dist/data.json";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

// 和 tests/build-kernel.mjs 用同一个编译方式：直接调真实 TS 函数，
// 而不是在脚本里复制一份逻辑——复制的那份一定会和 lib 漂移。
const outDir = resolve(root, ".report-build");
execFileSync(resolve(root, "node_modules/.bin/tsc"), [
  "lib/fde-dimensions.ts", "lib/company-profile.ts", "lib/corpus-import.ts",
  "lib/fde-roster.ts", "lib/report-data.ts", "lib/report-html.ts", "lib/report-judgment.ts",
  "--outDir", ".report-build", "--module", "commonjs", "--moduleResolution", "node10",
  "--target", "es2022", "--strict",
], { cwd: root, stdio: "inherit" });
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "package.json"), '{"type":"commonjs"}');

const require = createRequire(import.meta.url);
const importer = require(`${outDir}/corpus-import.js`);
const roster = require(`${outDir}/fde-roster.js`);
const html = require(`${outDir}/report-html.js`);

const today = new Date().toISOString().slice(0, 10);
const historyDir = resolve(root, "reports/history");
mkdirSync(historyDir, { recursive: true });

// ---- 本版档案 ----
const profiles = [];
let network;
const corpusPath = arg("--corpus", DEFAULT_CORPUS);
const skipCorpus = process.argv.includes("--no-corpus");
if (!skipCorpus) {
  if (existsSync(corpusPath)) {
    const raw = JSON.parse(readFileSync(corpusPath, "utf8"));
    const companies = Array.isArray(raw) ? raw : raw.companies || [];
    network = raw.network || undefined;
    profiles.push(...importer.importCorpus(companies, today));
    console.log(`语料：${companies.length} 家 ← ${corpusPath}${network ? `；知识图谱 ${network.nodes?.length || 0} 节点 / ${network.links?.length || 0} 边` : ""}`);
  } else {
    console.log(`语料不在 ${corpusPath}，本次只出名单部分`);
  }
}
// 抓取产物。没有就照旧出空名单——报告不因为没抓过而生成失败，
// 只是那些格子显示成待办（本来就是待办）。
const filingPath = resolve(root, "data/filing-facts.json");
const filings = existsSync(filingPath) ? JSON.parse(readFileSync(filingPath, "utf8")) : undefined;
if (filings) {
  const count = filings.companies.reduce((sum, item) =>
    sum + Object.values(item.facts).reduce((n, dim) => n + Object.keys(dim).length, 0), 0);
  console.log(`法定披露：${filings.companies.length} 家 / ${count} 条（抓于 ${filings.fetchedAt}）`);
}
profiles.push(...importer.importRoster(roster.ROSTER, today, filings));
console.log(`名单：${roster.ROSTER.length} 家　合计 ${profiles.length} 家`);

// ---- 上一版快照 ----
// 只认比今天旧的快照。否则同一天重跑第二次会拿今天的自己做 diff，
// 变更页永远显示 0 项，看起来像「没变化」，其实是拿自己比自己。
const snapshots = readdirSync(historyDir).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
const older = snapshots.filter(name => name.slice(0, 10) < today);
const previousFile = older.length ? resolve(historyDir, older[older.length - 1]) : null;
const previous = previousFile ? JSON.parse(readFileSync(previousFile, "utf8")) : undefined;
console.log(previousFile ? `对比上一版：${older[older.length - 1]}` : "没有更早的快照，本次是首版");

// ---- 人写的判断 ----
// 算不出来的那类判断（「护城河在客户关系不在技术里」这种因果解释）只能人写。
// 放在文件里而不是写死在代码里：它每轮都要改，而且它不是确定性产物——
// 重跑不会自己更新，所以报告里给它单独标了「人工判断」。
//
// 格式：[{claim, confidence: "public"|"internal"|"lead", support, counter, implication?}]
const judgmentPath = arg("--judgments", resolve(root, "data/judgments.json"));
let manualJudgments = [];
if (existsSync(judgmentPath)) {
  const raw = JSON.parse(readFileSync(judgmentPath, "utf8"));
  manualJudgments = Array.isArray(raw) ? raw : raw.judgments || [];
  console.log(`人工判断：${manualJudgments.length} 条 ← ${judgmentPath}`);
} else {
  console.log(`没有 ${judgmentPath}，本次只出可计算的判断`);
}

// ---- 出报告 ----
const page = html.renderReport({
  profiles,
  previous,
  generatedAt: today,
  cardLimit: Number(arg("--cards", "60")),
  manualJudgments,
  network,
});

const outPath = resolve(root, `reports/fde-report-${today}.html`);
writeFileSync(outPath, page);
writeFileSync(resolve(historyDir, `${today}.json`), JSON.stringify(profiles));
console.log(`\n报告：${outPath}（${(page.length / 1024).toFixed(0)} KB）`);
console.log(`快照：reports/history/${today}.json`);
