// 反事实测算：0/207 是现状，但"要花多少工才能过闸"才是决策依据。
//
// 分四档逐步放行，每档只补一类缺口，看过闸数怎么变。
// 关键纪律：每一档补的都必须是**老数据里客观已有、只是没进字段**的东西，
// 或**机械可推导**的东西。凡是需要新判断的（证伪条件、我方杠杆、签署），
// 一律不代补——那些就是必须由人付出的成本，测算的目的正是把它量出来。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildKernel } from "../tests/build-kernel.mjs";
import { cardToSignal } from "./card-to-signal.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = buildKernel();
const require = createRequire(import.meta.url);
const core = require(`${outDir}/field-core.js`);
const onto = require(`${outDir}/ontology.js`);
const raw = JSON.parse(readFileSync("/Users/auntlee/Desktop/workspace/同行信息查找/dist/data.json", "utf8"));
const topicRules = onto.RELATIONS.map(r => ({ id: r.id, words: r.words }));
const n = raw.companies.length;
const out = [];
const say = s => { out.push(s); console.log(s); };
const pct = (a, b) => `${(a / b * 100).toFixed(1)}%`;

/** 档位定义。patch 只允许写"客观已有/机械可导"的字段。 */
const TIERS = [
  {
    name: "T0 现状",
    note: "原样映射，不补任何字段",
    patch: () => ({}),
  },
  {
    name: "T1 + 机械补录",
    note: "dataBasis 与 timeWindow：老数据客观已有，只是没进字段",
    patch: card => ({
      scope: {
        // 老数据每条都自报了发现渠道，渠道即口径（"这条信息按什么来源算出来的"）。
        dataBasis: `发现渠道口径：${card.channel_raw || card.channel_label}；数据为名单登记信息，非财务口径`,
        // meta.survey_date 是客观采集日，机械可导。
        timeWindow: `采集于 ${raw.meta.survey_date}`,
      },
    }),
  },
  {
    name: "T2 + 有效期",
    note: "validUntil 设为采集日 +90 天（名单类情报的常规半衰期）",
    patch: card => ({
      scope: {
        dataBasis: `发现渠道口径：${card.channel_raw || card.channel_label}；数据为名单登记信息，非财务口径`,
        timeWindow: `采集于 ${raw.meta.survey_date}`,
      },
      validUntil: "2026-10-29",
    }),
  },
  {
    name: "T3 + 我方杠杆",
    note: "ourAccess 假设全部填好（实际须逐家人工判断，此处仅测量上限）",
    patch: card => ({
      scope: {
        dataBasis: `发现渠道口径：${card.channel_raw || card.channel_label}；数据为名单登记信息，非财务口径`,
        timeWindow: `采集于 ${raw.meta.survey_date}`,
        ourAccess: "【测算假设】已填写我方通路",
      },
      validUntil: "2026-10-29",
    }),
  },
  {
    name: "T4 + 证伪·反例",
    note: "falsifier/counterEvidence 假设全部填好（须逐家人工判断，仅测上限）",
    patch: card => ({
      scope: {
        dataBasis: `发现渠道口径：${card.channel_raw || card.channel_label}；数据为名单登记信息，非财务口径`,
        timeWindow: `采集于 ${raw.meta.survey_date}`,
        ourAccess: "【测算假设】已填写我方通路",
      },
      validUntil: "2026-10-29",
      falsifier: "【测算假设】已填写证伪条件",
      counterEvidence: "【测算假设】已填写反例",
    }),
  },
  {
    name: "T5 + 专家签署",
    note: "signedOff=true（只能由人签，模型永不代签；此档纯属测量门的上限）",
    patch: card => ({
      scope: {
        dataBasis: `发现渠道口径：${card.channel_raw || card.channel_label}；数据为名单登记信息，非财务口径`,
        timeWindow: `采集于 ${raw.meta.survey_date}`,
        ourAccess: "【测算假设】已填写我方通路",
      },
      validUntil: "2026-10-29",
      falsifier: "【测算假设】已填写证伪条件",
      counterEvidence: "【测算假设】已填写反例",
      signedOff: true,
    }),
  },
];

say("反事实测算：逐档补齐后的过闸数");
say("（每档标注该档补的是 A 类机械劳动、还是 C 类判断劳动）");
say("");
const results = [];
for (const tier of TIERS) {
  let exec = 0;
  const gateHits = [0, 0, 0, 0, 0, 0];
  for (const card of raw.companies) {
    const seed = cardToSignal(card);
    const p = tier.patch(card);
    const merged = {
      ...seed,
      constraints: {
        ...seed.constraints, ...p,
        scope: { ...seed.constraints.scope, ...(p.scope || {}) },
      },
    };
    const sig = core.makeSignal(merged, core.initialWeights, topicRules, "历史记录");
    const g = core.gateState(sig);
    g.states.forEach((s, i) => { if (s) gateHits[i]++; });
    if (g.executable) exec++;
  }
  results.push({ tier: tier.name, exec, gateHits });
  say(`${tier.name.padEnd(14)} 过闸 ${String(exec).padStart(3)}/${n}  ${pct(exec, n).padStart(6)}   门命中 ${gateHits.join("/")}`);
  say(`${" ".repeat(15)}${tier.note}`);
}
say("");
say("═══ 结论 ═══");
const t2 = results[2].exec, t5 = results[5].exec;
say(`补完全部机械可补的字段（T2）：${t2}/${n} 过闸  ${pct(t2, n)}`);
say(`连人工判断也假设全部填好（T5）：${t5}/${n} 过闸  ${pct(t5, n)}`);
say(`→ 差额 ${t5 - t2} 家的过闸，完全取决于人工投入，机械手段一家也补不出来。`);
const stillFail = n - t5;
say(`→ 即使一切假设填满，仍有 ${stillFail} 家过不去：卡在门 1，没有证据正文，只有标签。`);

writeFileSync(resolve(here, "repair-cost.txt"), out.join("\n"));
