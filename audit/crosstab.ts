// 交叉表：老数据的 ★ 星级 vs 六道门的实际判定。
// 这是整场审计的核心产出——它回答"半年前那套印象分，和一套强制的证据纪律，分歧有多大"。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildKernel } from "../tests/build-kernel.ts";
import { cardToSignal } from "./card-to-signal.ts";
import { gradeSources } from "./source-grade.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = buildKernel();
const require = createRequire(import.meta.url);
const core = require(`${outDir}/field-core.js`);
const onto = require(`${outDir}/ontology.js`);
const raw = JSON.parse(readFileSync("/Users/auntlee/Desktop/workspace/同行信息查找/dist/data.json", "utf8")) as { companies: any[] };
const topicRules = onto.RELATIONS.map(r => ({ id: r.id, words: r.words }));
const n = raw.companies.length;
const out = [];
const say = s => { out.push(s); console.log(s); };
const pct = (a, b) => b ? `${(a / b * 100).toFixed(0)}%` : "—";

// 每家算：老星级、来源级别、是否有证据正文
const rows = raw.companies.map(card => {
  const seed = cardToSignal(card);
  const sig = core.makeSignal(seed, core.initialWeights, topicRules, "历史记录");
  const g = core.gateState(sig);
  const src = gradeSources(card.sources);
  return {
    id: card.id, name: card.name, group: card.group, stars: card.confidence,
    channel: card.channel_code, channelLabel: card.channel_label,
    hasEvidence: g.states[0], srcType: src.type,
    // 「可救」= 门1 过（有证据正文）且 门5 的来源子条件过（来源可判级）。
    // 这两道是唯一无法靠人工意志补上的门——没有原文就是没有，来源判不出就是判不出。
    salvageable: g.states[0] && src.type !== "unknown",
  };
});

say("═══ 交叉表 1：老 ★ 星级 × 是否可救 ═══");
say("（可救 = 有证据正文 且 来源可判级；这两项无法靠人工意志补出）");
say("");
say("  ★级    家数   可救   可救率   其中 independent   老数据自评");
const starOrder = [5, 4.5, 4, 3.5, 3, 2.5, 2, null];
for (const s of starOrder) {
  const g = rows.filter(r => r.stars === s);
  if (!g.length) continue;
  const ok = g.filter(r => r.salvageable);
  const ind = g.filter(r => r.srcType === "independent");
  const label = s === null ? "未评" : `${s}★`;
  say(`  ${label.padEnd(6)} ${String(g.length).padStart(4)}  ${String(ok.length).padStart(5)}  ${pct(ok.length, g.length).padStart(6)}   ${String(ind.length).padStart(14)}   ${s >= 4 ? "「高可信」" : ""}`);
}
say("");
const high = rows.filter(r => (r.stars ?? 0) >= 4);
const highOk = high.filter(r => r.salvageable);
say(`  ★★★★ 及以上共 ${high.length} 家，其中仅 ${highOk.length} 家可救（${pct(highOk.length, high.length)}）。`);
say(`  → 老数据判定"高可信"的 ${high.length} 家里，${high.length - highOk.length} 家连原始证据或可判级来源都没有。`);
say(`     星级衡量的是"我相信这家存在且靠谱"，门衡量的是"这个判断能不能被第三方复核"。`);
say(`     两者不是一回事，实测分歧 ${pct(high.length - highOk.length, high.length)}。`);
say("");

// ⚠️ 混淆已核查：全表比较渠道会得到伪相关——L 轮渠道 100% 有卡片，
// 早期 G/K 轮 0% 有卡片，"可救率"几乎就是"卡片覆盖率"的复读。
// 卡片是当时人工写深的，与渠道产出质量无关。故只在 65 张卡片内部比较。
say("═══ 交叉表 2：发现渠道 × 来源质量（仅限 65 张有卡片者）═══");
say("（全表比较会被卡片覆盖率混淆，见代码注释；此处已控制该变量）");
say("");
const carded = rows.filter(r => r.hasEvidence);
type ChannelCount = { all: number; ind: number; rel: number; unk: number };
const byChannel: Record<string, ChannelCount> = {};
carded.forEach(r => {
  const b = (byChannel[r.channelLabel] ||= { all: 0, ind: 0, rel: 0, unk: 0 });
  b.all++; b[r.srcType === "independent" ? "ind" : r.srcType === "related" ? "rel" : "unk"]++;
});
say("  渠道                        卡片数  独立源  自述源  判不出  独立源占比");
Object.entries(byChannel).sort((a, b) => b[1].ind / b[1].all - a[1].ind / a[1].all)
  .forEach(([k, v]) => say(`  ${k.padEnd(26, "　").slice(0, 26)} ${String(v.all).padStart(5)} ${String(v.ind).padStart(6)} ${String(v.rel).padStart(6)} ${String(v.unk).padStart(6)} ${pct(v.ind, v.all).padStart(8)}`));
say("");
say(`  → 142 家无卡片主体的渠道质量，本次数据无法判定（它们从未被写深过）。`);
say(`     这不是渠道差，是当时没为它们采原文。诚实标注为未知，不推断。`);
say("");

say("═══ 名单：60 家可救主体（门 1+5 已具备，只缺人工投入）═══");
const salv = rows.filter(r => r.salvageable).sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
salv.forEach((r, i) => say(`  ${String(i + 1).padStart(2)}. [${r.group}组 ${r.stars ?? "?"}★ ${r.srcType.padEnd(11)}] ${r.name}`));
say("");
say(`═══ 名单：${65 - salv.filter(r => r.hasEvidence).length} 家有正文但来源判不出 ═══`);
rows.filter(r => r.hasEvidence && r.srcType === "unknown").forEach(r => say(`  [${r.group}组 ${r.stars}★] ${r.name}`));

writeFileSync(resolve(here, "crosstab.txt"), out.join("\n"));
writeFileSync(resolve(here, "salvageable.json"), JSON.stringify(salv, null, 1));
