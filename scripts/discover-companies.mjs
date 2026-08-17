// 真去找：把公开渠道过一遍，产出候选公司 + 证据，落盘成 data/candidates.json。
//
// 用法：
//   node scripts/discover-companies.mjs              # 联网跑全部渠道
//   node scripts/discover-companies.mjs --cache-only # 不联网，只用已缓存的响应重算
//   node scripts/discover-companies.mjs --gh scaleai,databricks  # 额外补几个 Greenhouse 招聘板
//
// 产物：
//   .discover-cache/*.json    渠道原始响应 + 下载过的披露正文（不进 git）
//   data/candidates.json      候选 + 逐字证据 + 来源 URL —— 这份是给人读的
//
// ============ 这个脚本不写名单 ============
// 它绝不改 lib/fde-roster.ts。候选是机器搜到的字符串匹配，名单是经过判断的东西。
// 24 家往 100 家走的路径是「人读候选 → 挑出真的相关的 → 手写进名单」，
// 中间那个人不能省。省掉的结果已经见过一次：207 家里多数是普通交付商。
//
// ============ 为什么要缓存 ============
// 和 fetch-filings 同一个理由：噪音门和归一化规则会反复改，每改一次重下十几份
// SEC 文件既慢又是在白给别人的服务器加负载。响应落盘后 --cache-only 是秒级的，
// 且「同一批原始响应、规则改了之后候选变了哪些」可回溯。
//
// ============ 抓取礼貌 ============
// 全程顺序、每次请求间隔 ≥1.5 秒、真实 UA。三个渠道都是公开接口：
//   - efts.sec.gov / www.sec.gov：SEC 明文要求 UA 里带联系方式，照做。
//     实测坑：Archives 主机只认「名字 邮箱」格式，带括号的那种（lib/filing-sources.ts
//     里的 SEC_UA）会被判成 undeclared automated tool，返回一个 4.8KB 的告知页，
//     而不是 4xx——所以看起来「下到了文件但一个关键词都搜不到」。见 SEC_UA_DOC。
//   - hn.algolia.com：HN 官方公开搜索 API，无鉴权。
//   - boards-api.greenhouse.io：Greenhouse 给自家客户用的公开招聘板 API。
// 一律不碰需要登录的地方，不碰微信生态，不绕任何反爬。国内招聘平台实测全部
// 有反爬（见文件末尾的渠道结论），那就是取不到，不硬突破。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = resolve(root, ".discover-cache");
const outFile = resolve(root, "data/candidates.json");
const outDir = resolve(root, ".report-build");

execFileSync(resolve(root, "node_modules/.bin/tsc"), [
  "lib/fde-dimensions.ts", "lib/company-profile.ts", "lib/fde-roster.ts", "lib/company-discovery.ts",
  "--outDir", ".report-build", "--module", "commonjs", "--moduleResolution", "node10",
  "--target", "es2022", "--strict", "--skipLibCheck",
], { cwd: root, stdio: "inherit" });
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "package.json"), '{"type":"commonjs"}');

const require = createRequire(import.meta.url);
const D = require(`${outDir}/company-discovery.js`);
const roster = require(`${outDir}/fde-roster.js`);

const cacheOnly = process.argv.includes("--cache-only");
const today = new Date().toISOString().slice(0, 10);

/** SEC 要求 UA 能联系到人。这里用「标识 邮箱」的形式而不是 lib/filing-sources.ts
 *  里那种带括号的写法——实测 www.sec.gov/Archives 只接受前者，见文件头。 */
const SEC_UA = "intel-engine-field-research admin@intel-engine.local";
const HN_UA = "intel-engine-field/1.0 (FDE market research)";

const sleep = ms => new Promise(done => setTimeout(done, ms));
let lastRequestAt = 0;

/** 统一出口：所有网络请求都走这里，限速在这一个地方保证。
 *  分散到各渠道里写 sleep 的话，加一个渠道就会忘一次。 */
async function politeFetch(url, headers) {
  const wait = 1500 - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 带磁盘缓存的取件。key 决定文件名，所以必须对同一请求稳定。 */
async function cached(key, url, headers) {
  const path = resolve(cacheDir, `${key}.txt`);
  if (existsSync(path)) return readFileSync(path, "utf8");
  if (cacheOnly) return null;
  const text = await politeFetch(url, headers);
  writeFileSync(path, text);
  return text;
}

/** HTML → 纯文本。和 lib/filing-sources.ts 的 htmlToPlain 同样的活儿，
 *  这里重写一遍是因为那个函数在 filing-sources 里，把它导出会让抓取层
 *  多一个反向依赖；十行代码不值得为它加耦合。 */
function htmlToPlain(raw) {
  return raw
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

mkdirSync(cacheDir, { recursive: true });
mkdirSync(dirname(outFile), { recursive: true });

const findings = [];
const rejected = [];
const channels = [];

console.log(`发现任务${cacheOnly ? "（仅用缓存）" : ""}｜短语：${D.DISCOVERY_TERMS.join(" / ")}\n`);

// ============ 渠道一：SEC EDGAR 全文检索 ============
// 这是唯一能「按短语枚举出公司」的法定披露渠道。
// 注意它命中的位置多为 CEO 引语和战略段落，不是组织披露——实测 Palantir 自己的
// 2025 年 10-K 里 "Forward Deployed" 出现 0 次，而这个词就是他们造的。
// 所以这个渠道的产出天然偏 org-description（弱证据），这不是 bug，是这类材料的性质。
{
  let ok = false;
  const detail = [];
  for (const term of D.DISCOVERY_TERMS) {
    const encoded = encodeURIComponent(`"${term}"`);
    const url = `https://efts.sec.gov/LATEST/search-index?q=${encoded}&startdt=2022-01-01&enddt=${today}`;
    let raw;
    try {
      raw = await cached(`edgar-${term.replace(/\s+/g, "-")}`, url, { "User-Agent": SEC_UA });
    } catch (error) {
      detail.push(`「${term}」检索失败：${String(error.message).slice(0, 80)}`);
      continue;
    }
    if (!raw) { detail.push(`「${term}」无缓存，跳过`); continue; }

    let plan;
    try {
      plan = D.planEdgarDocs(JSON.parse(raw), term);
    } catch (error) {
      detail.push(`「${term}」响应解析失败：${String(error.message).slice(0, 80)}`);
      continue;
    }
    ok = true;
    console.log(`· EDGAR「${term}」→ ${plan.length} 家待取原文`);

    for (const item of plan) {
      // 文件名用 URL 的后两段：同一家公司不同文件要分开缓存。
      const key = `secdoc-${item.url.split("/").slice(-2).join("-")}`;
      let doc;
      try {
        doc = await cached(key, item.url, { "User-Agent": SEC_UA });
      } catch (error) {
        rejected.push({ name: item.name, channel: "edgar-fts", why: `原文下载失败：${String(error.message).slice(0, 60)}` });
        continue;
      }
      if (!doc) continue;
      const plain = htmlToPlain(doc);
      const quote = D.extractQuote(plain, term);
      if (!quote) {
        // 检索说命中了，下载回来却搜不到——最常见的原因是被 SEC 拦了，
        // 返回的是那个 4.8KB 的告知页。把这条如实记下来，不当成「这家不相关」。
        const blocked = /Undeclared Automated Tool|Request Rate Threshold/i.test(plain);
        rejected.push({
          name: item.name,
          channel: "edgar-fts",
          why: blocked ? "SEC 返回了自动化访问告知页，没拿到真正文（删掉缓存重跑）" : `检索命中但原文里定位不到「${term}」，可能是版面把词拆开了`,
        });
        continue;
      }
      findings.push({
        name: item.name, listing: "us", ticker: item.ticker, cik: item.cik,
        channel: "edgar-fts", term, quote, sourceUrl: item.url, sourceTitle: item.title, fetchedAt: today,
      });
    }
  }
  channels.push({ id: "edgar-fts", ok, detail: detail.join("；") || "正常" });
}

// ============ 渠道二：HN Who-is-hiring ============
// 创业公司这一侧唯一走得通的公开渠道。它的材料是公司自己贴的 JD 原文——
// 按 fde-dimensions 的说法这属于「企业自述」，但它是一手的，
// 而且 JD 不像通稿那样修饰（招错了人要付代价，所以岗位描述通常是真的）。
{
  let ok = false;
  const detail = [];
  for (const term of D.DISCOVERY_TERMS) {
    // 只看近两年：招聘帖过期得快，2019 年招过 FDE 不代表现在还有这个组织。
    const since = Math.floor(Date.parse(`${new Date().getFullYear() - 2}-01-01`) / 1000);
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(`"${term}"`)}&tags=comment&hitsPerPage=100&numericFilters=created_at_i>${since}`;
    let raw;
    try {
      raw = await cached(`hn-${term.replace(/\s+/g, "-")}`, url, { "User-Agent": HN_UA });
    } catch (error) {
      detail.push(`「${term}」失败：${String(error.message).slice(0, 80)}`);
      continue;
    }
    if (!raw) { detail.push(`「${term}」无缓存，跳过`); continue; }
    let parsed;
    try {
      parsed = D.parseHnHits(JSON.parse(raw), term, today);
    } catch (error) {
      detail.push(`「${term}」解析失败：${String(error.message).slice(0, 80)}`);
      continue;
    }
    ok = true;
    findings.push(...parsed.findings);
    rejected.push(...parsed.rejected);
    console.log(`· HN「${term}」→ ${parsed.findings.length} 条命中，${parsed.rejected.length} 条弃用`);
  }
  channels.push({ id: "hn-hiring", ok, detail: detail.join("；") || "正常" });
}

// ============ 渠道三：Greenhouse 公开招聘板 ============
// 这个渠道**不能发现**公司：Greenhouse 的 slug 无法枚举，只能一个个猜。
// 实测猜 slug 的命中率很低（palantir / snowflake / openai / anduril 全是 404，
// 而 andurilindustries 才是对的）。所以它的定位是「补证据」：
// 已经从别的渠道知道了公司名，再来这里看它有没有在招岗位名带这个词的职位。
// 岗位名是最硬的一种证据，值得为它多跑一次。
{
  const extra = (() => {
    const index = process.argv.indexOf("--gh");
    return index >= 0 ? (process.argv[index + 1] ?? "").split(",").filter(Boolean) : [];
  })();
  // 默认这几个是实测确认存在且岗位名命中的板子。写死是因为它们属于「怎么抓」，
  // 不是「这家公司是谁」——和 fetch-filings.mjs 里的 CIK 表同一个道理。
  const SLUGS = ["scaleai", "databricks", "zoominfo", "andurilindustries", ...extra];
  let ok = false;
  const detail = [];
  for (const slug of SLUGS) {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`;
    let raw;
    try {
      raw = await cached(`gh-${slug}`, url, { "User-Agent": HN_UA });
    } catch (error) {
      detail.push(`${slug}：${String(error.message).slice(0, 40)}`);
      continue;
    }
    if (!raw) { detail.push(`${slug} 无缓存，跳过`); continue; }
    let jobs;
    try {
      jobs = JSON.parse(raw);
    } catch { detail.push(`${slug} 响应不是 JSON`); continue; }
    ok = true;
    // 公司名用 slug 本身——它是 URL 片段不是正式名称，但归一化之后能和
    // 别的渠道对上（scaleai → scaleai，Scale AI → scaleai）。
    const hits = D.parseGreenhouseJobs(jobs, slug, slug, today);
    findings.push(...hits);
    console.log(`· Greenhouse ${slug} → ${hits.length} 个岗位名命中`);
    if (!hits.length) detail.push(`${slug} 无岗位名命中`);
  }
  channels.push({ id: "greenhouse-jd", ok, detail: detail.join("；") || "正常" });
}

// ============ 合并、定级、落盘 ============
const known = D.rosterKeys(roster.ROSTER);
const merged = D.mergeFindings(findings, known);
rejected.push(...merged.rejected);
rejected.sort((a, b) => a.channel.localeCompare(b.channel) || a.name.localeCompare(b.name));

const file = D.buildCandidatesFile({ generatedAt: today, candidates: merged.candidates, rejected, channels });
writeFileSync(outFile, `${JSON.stringify(file, null, 2)}\n`);

const fresh = file.candidates.filter(item => !item.alreadyInRoster);
const tiers = [
  ["role-title", "岗位名命中｜最值得先读"],
  ["first-person-org", "第一人称自述｜主语明确是它自己"],
  ["org-description", "正文提及｜主语不明，可能在说别家"],
];
console.log(`\n候选 ${file.candidates.length} 家（其中 ${file.candidates.length - fresh.length} 家名单里已有）`);
console.log(`弃用 ${file.rejected.length} 条（原因写在 candidates.json 的 rejected 里，别只看候选）\n`);
for (const [signal, label] of tiers) {
  const bucket = fresh.filter(item => item.strongestSignal === signal);
  console.log(`— ${label}：${bucket.length} 家`);
  for (const item of bucket) console.log(`   · ${item.name}${item.ticker ? `（${item.ticker}）` : ""}　${item.evidence.length} 条证据`);
}
console.log(`\n写入 ${outFile.replace(`${root}/`, "")}`);
console.log("这里没有一条是结论：全部 relevance=unclear、证据全部 unverified 级。");
console.log("下一步是人读证据、挑出真相关的手写进 lib/fde-roster.ts。这个脚本不动名单。");
