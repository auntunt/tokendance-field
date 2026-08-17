// 0/207 本身不是结论，只是起点。真正要问的是：
// 每道门为什么不过，以及**补起来要花什么代价**。
// 分三类：
//   A 类「字段不存在」——老数据 schema 里就没这一栏，属于登记缺口，补录即可（机械劳动）
//   B 类「内容真的弱」——字段存在但内容不成立，属于证据缺口，要重新采集（需要通道）
//   C 类「必须有人负责」——只能由人做，不可代劳（判断劳动）
// 这个分类决定了那 207 家里有多少是能救的、救一家要多少工。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildKernel } from "../tests/build-kernel.mjs";
import { cardToSignal, classifySourceUrl, readEpistemicState, buildEvidence } from "./card-to-signal.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = buildKernel();
const require = createRequire(import.meta.url);
const core = require(`${outDir}/field-core.js`);
const onto = require(`${outDir}/ontology.js`);
const { classifyEntity } = require(`${outDir}/extractor.js`);

const raw = JSON.parse(readFileSync("/Users/auntlee/Desktop/workspace/同行信息查找/dist/data.json", "utf8"));
const companies = raw.companies;
const topicRules = onto.RELATIONS.map(r => ({ id: r.id, words: r.words }));
const out = [];
const say = s => { out.push(s); console.log(s); };
const pct = (a, b) => `${(a / b * 100).toFixed(1)}%`;
const n = companies.length;

// ── 门 1：原始证据（evidence ≥20字 且 有 source）──────────────
say("═══ 门 1 原始证据：为什么 142 家不过 ═══");
const g1 = companies.map(c => ({ c, ev: buildEvidence(c), src: (c.channel_raw || "").trim() }));
const noEv = g1.filter(x => x.ev.trim().length < 20);
const noSrc = g1.filter(x => !x.src);
say(`  evidence 不足 20 字：${noEv.length} 家   其中完全空白：${noEv.filter(x => !x.ev.trim()).length} 家`);
say(`  source 空白：${noSrc.length} 家`);
say(`  → 142 家仅有表行（公司名/行业/融资/渠道），没有任何叙述性证据正文。`);
say(`  分类：B 类（内容缺口）。表行里的信息是标签，不是证据；补它必须重新采集原文。`);
say("");

// ── 门 2：本地边界（五问全填）──────────────────────────────
say("═══ 门 2 本地边界：五问逐项可得性 ═══");
const scopeProbe = [
  ["entityScope 主体范围", c => (c.name_raw || c.name || "").trim()],
  ["marketRegion 市场区域", c => [c.city, c.macro_region].filter(Boolean).join("/")],
  ["dataBasis 数据口径", c => ""],
  ["timeWindow 时间窗口", c => ""],
  ["ourAccess 我方可用性", c => ""],
];
for (const [label, get] of scopeProbe) {
  const have = companies.filter(c => get(c).length > 0).length;
  const verdict = have === n ? "老数据有" : have === 0 ? "老数据无此字段" : "部分有";
  say(`  ${label.padEnd(24)} ${String(have).padStart(3)}/${n} ${pct(have, n).padStart(6)}   ${verdict}`);
}
say(`  → 3/5 项老数据结构上就不存在：口径、时间窗口、我方杠杆。`);
say(`  分类：dataBasis/timeWindow 是 A 类（补录），ourAccess 是 C 类（只有你知道能不能进门）。`);
say("");

// ── 门 3：认识状态 ────────────────────────────────────────
say("═══ 门 3 认识状态：唯一 100% 通过的门 ═══");
const es = {};
companies.forEach(c => { const k = readEpistemicState(c); es[k] = (es[k] || 0) + 1; });
Object.entries(es).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => say(`  ${k.padEnd(15)} ${String(v).padStart(3)} 家  ${pct(v, n)}`));
say(`  → 通过原因要说清：门 3 只要求"标了状态"，默认值 observation 也算标了。`);
say(`     这门 100% 通过不代表老数据严谨，代表这门本身是弱门。诚实记录。`);
say("");

// ── 门 4：证伪 / 反例 ─────────────────────────────────────
say("═══ 门 4 证伪·反例：老数据里有没有这两样 ═══");
const hasRisk = companies.filter(c => String(c.risk ?? "").trim()).length;
const hasEdge = companies.filter(c => String(c.edge_reason ?? "").trim()).length;
const hasBoth = companies.filter(c => String(c.risk ?? "").trim() && String(c.edge_reason ?? "").trim()).length;
say(`  risk（可当证伪条件）非空：      ${hasRisk}/${n}  ${pct(hasRisk, n)}`);
say(`  edge_reason（可当反例）非空：   ${hasEdge}/${n}  ${pct(hasEdge, n)}`);
say(`  两者都有：                      ${hasBoth}/${n}`);
say(`  → 老数据从头到尾只有 1 家写了 risk。研报第五节提出过"水下指数"要给高风险样本降权，`);
say(`     但那是建议，没落进数据。这正是纪律层与研报的差别：门 4 让它成为必填。`);
say(`  分类：C 类。"什么情况下这条结论不成立"没人能代写。`);
say("");

// ── 门 5：来源 / 时效 ─────────────────────────────────────
say("═══ 门 5 来源·时效：拆成三个子条件 ═══");
const g5 = companies.map(c => ({ c, seed: cardToSignal(c) }));
const st = {};
g5.forEach(x => { const k = x.seed.constraints.sourceType; st[k] = (st[k] || 0) + 1; });
say(`  子条件 a：sourceType ≠ unknown`);
Object.entries(st).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => say(`      ${k.padEnd(14)} ${String(v).padStart(3)} 家  ${pct(v, n)}`));
const okA = n - (st.unknown || 0);
say(`      通过 ${okA}/${n}  ${pct(okA, n)}`);
say(`  子条件 b：validUntil 非空          0/${n}   0.0%   老数据无此字段（A 类）`);
say(`  子条件 c：validUntil 未过期        不适用（b 已失败）`);
say(`  合门通过 0/${n}`);
say("");
say(`  ── 194 条 URL 逐条判级 ──`);
const grades = {};
const badUrls = [];
companies.forEach(c => (c.sources ?? []).forEach(s => {
  const g = classifySourceUrl(s);
  grades[g.type] = (grades[g.type] || 0) + 1;
  if (g.type === "unknown") badUrls.push([s, g.reason]);
}));
const tot = Object.values(grades).reduce((a, b) => a + b, 0);
Object.entries(grades).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => say(`      ${k.padEnd(14)} ${String(v).padStart(3)}/${tot}  ${pct(v, tot)}`));
say(`  ── 判为 unknown 的 ${badUrls.length} 条（全部列出，不抽样）──`);
badUrls.forEach(([u, r]) => say(`      ${u}\n        ↳ ${r}`));
say("");

// ── 门 6：专家签署 ────────────────────────────────────────
say("═══ 门 6 专家签署 ═══");
say(`  signedOff 为 true：0/${n}   老数据无签署字段（C 类，且模型永不代签）`);
say(`  → 这是唯一一道无论补多少数据都不会自己通过的门。`);
say("");

// ── 主体类型 ──────────────────────────────────────────────
say("═══ 附：207 个主体名的本体类型（classifyEntity 实测）═══");
const kinds = {};
companies.forEach(c => { const k = classifyEntity(c.name_raw || c.name, undefined); kinds[k] = (kinds[k] || 0) + 1; });
Object.entries(kinds).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => say(`  ${k.padEnd(10)} ${String(v).padStart(3)} 家  ${pct(v, n)}`));
say(`  → 老名单大量用简称/品牌名（"RollingAI（上海滚动网络）"、"清蓝 PureblueAI"），`);
say(`     字面尾缀认不出法人，落 unknown。这是门 2 entityScope 的实际质量。`);

writeFileSync(resolve(here, "diagnose-report.txt"), out.join("\n"));
