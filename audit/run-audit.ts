// 用真实的 gateState() 审计「同行信息查找」全部 207 家公司。
// 调的是编译后的 field-core.js 本体，不是复刻的判定逻辑——
// 否则测出来的是我对门的理解，不是门本身。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildKernel } from "../tests/build-kernel.ts";
import { cardToSignal, classifySourceUrl } from "./card-to-signal.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DATA = "/Users/auntlee/Desktop/workspace/同行信息查找/dist/data.json";

const outDir = buildKernel();
const require = createRequire(import.meta.url);
const core = require(`${outDir}/field-core.js`);
const onto = require(`${outDir}/ontology.js`);
const { classifyEntity } = require(`${outDir}/extractor.js`);

const raw = JSON.parse(readFileSync(DATA, "utf8"));
const companies = raw.companies;
const topicRules = onto.RELATIONS.map(r => ({ id: r.id, words: r.words }));

const rows = companies.map(card => {
  const seed = cardToSignal(card);
  const signal = core.makeSignal(seed, core.initialWeights, topicRules, "历史记录");
  const gate = core.gateState(signal);
  return {
    id: card.id,
    name: card.name,
    group: card.group,
    channel: card.channel_code,
    stars: card.confidence,
    hasCard: card.has_card,
    kind: classifyEntity(card.name_raw || card.name, undefined),
    states: gate.states,
    passed: gate.passed,
    executable: gate.executable,
    epistemic: signal.constraints.epistemicState,
    sourceType: signal.constraints.sourceType,
    sourceGrades: seed._audit.sourceGrades,
    evidenceLen: signal.evidence.length,
    candidateScore: signal.candidateScore,
  };
});

const GL = core.GATE_LABELS;
const n = rows.length;
const carded = rows.filter(r => r.hasCard);
const bare = rows.filter(r => !r.hasCard);

const pct = (a, b) => `${(a / b * 100).toFixed(1)}%`;
const out = [];
const say = s => { out.push(s); console.log(s); };

say(`语料：${DATA}`);
say(`采集时间：${raw.meta.survey_date}    今天：${new Date().toISOString().slice(0, 10)}`);
say(`主体总数：${n}（有卡片 ${carded.length} / 仅表行 ${bare.length}）`);
say("");
say("═══ 逐门通过率（全部 207 家）═══");
GL.forEach((label, i) => {
  const all = rows.filter(r => r.states[i]).length;
  const c = carded.filter(r => r.states[i]).length;
  const b = bare.filter(r => r.states[i]).length;
  say(`  门${i + 1} ${label.padEnd(9, "　")}  全体 ${String(all).padStart(3)}/${n} ${pct(all, n).padStart(6)}   卡片 ${String(c).padStart(2)}/${carded.length}   表行 ${String(b).padStart(3)}/${bare.length}`);
});
say("");
const exec = rows.filter(r => r.executable).length;
say(`═══ 全六门通过（executable）：${exec}/${n}  ${pct(exec, n)} ═══`);
say("");
say("═══ 过闸门数分布 ═══");
for (let k = 0; k <= 6; k++) {
  const g = rows.filter(r => r.passed === k);
  if (!g.length) continue;
  const bar = "█".repeat(Math.round(g.length / n * 60));
  say(`  过 ${k} 门：${String(g.length).padStart(3)} 家  ${bar}`);
}

writeFileSync(resolve(here, "audit-result.json"), JSON.stringify({ meta: raw.meta, auditedAt: new Date().toISOString(), rows }, null, 1));
writeFileSync(resolve(here, "audit-report.txt"), out.join("\n"));
export { rows, core, GL };
