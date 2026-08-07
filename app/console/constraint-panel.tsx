"use client";

import { Constraints, EpistemicState, GATE_LABELS, Signal, SourceType, epistemicText, gateState } from "../../lib/field-core";
import { LocalScope, SCOPE_FIELDS } from "../../lib/ontology";

export function ConstraintPanel({ signal, onChange }: { signal: Signal; onChange: (value: Constraints) => void }) {
  const value = signal.constraints;
  const gate = gateState(signal);
  // 任何一次约束编辑都撤销专家签署。这是代码级硬约束，不是提示语。
  const setScope = (key: keyof LocalScope, next: string) => onChange({ ...value, signedOff: false, scope: { ...value.scope, [key]: next } });
  return <section className="constraint-system">
    <header>
      <div><small>RELATION JUDGMENT GATE / HARD CONSTRAINTS</small><h2>先说清“这条关系在哪成立”，再谈“它是否正确”。</h2></div>
      <div className={gate.executable ? "gate-score pass" : "gate-score"}><b>{gate.passed}</b><span>/ 6</span><em>{gate.executable ? "允许执行" : "保持拦截"}</em></div>
    </header>
    <div className="gate-rail">{GATE_LABELS.map((label, index) => <span className={gate.states[index] ? "pass" : ""} key={label}><i>{gate.states[index] ? "✓" : index + 1}</i>{label}</span>)}</div>
    <div className="constraint-grid">
      <article>
        <small>01 / SCOPE ENVELOPE</small><h3>局部边界</h3>
        <div className="scope-inputs">{SCOPE_FIELDS.map(field => <label key={field.key}>{field.label}<input value={value.scope[field.key] || ""} onChange={e => setScope(field.key, e.target.value)} placeholder={field.placeholder} /></label>)}</div>
      </article>
      <article>
        <small>02 / EPISTEMIC STATE</small><h3>这句话究竟是什么？</h3>
        <div className="state-switch">{(["observation", "interpretation", "hypothesis", "action"] as EpistemicState[]).map(state => <button className={value.epistemicState === state ? "active" : ""} onClick={() => onChange({ ...value, epistemicState: state, signedOff: false })} key={state}>{epistemicText(state)}</button>)}</div>
        <label>来源谱系<select value={value.sourceType} onChange={e => onChange({ ...value, sourceType: e.target.value as SourceType, signedOff: false })}><option value="unknown">尚未判断</option><option value="independent">独立来源</option><option value="related">同源 / 转述</option><option value="internal">我方人际渠道</option></select></label>
        {value.sourceType === "internal" && <>
          <label>人际出处<input value={value.humanSource || ""} onChange={e => onChange({ ...value, humanSource: e.target.value, signedOff: false })} placeholder="客户方采购经理在 7/20 复盘会上口头提及" /></label>
          <p className="source-note">只记职务与场合，不记私生活。私下消息不因“亲耳听到”获得豁免，仍要写证伪条件与有效期——单一人际来源没有第三方可核查渠道，天然是弱来源，它提示方向而不给结论。</p>
        </>}
        <label>有效期<input type="date" value={value.validUntil} onChange={e => onChange({ ...value, validUntil: e.target.value, signedOff: false })} /></label>
      </article>
      <article>
        <small>03 / FALSIFIABILITY</small><h3>什么会证明这条关系不成立？</h3>
        <label>证伪条件<textarea value={value.falsifier} onChange={e => onChange({ ...value, falsifier: e.target.value, signedOff: false })} placeholder="出现什么公开事实，这条关系判断必须被推翻？" /></label>
        <label>当前反例<textarea value={value.counterEvidence} onChange={e => onChange({ ...value, counterEvidence: e.target.value, signedOff: false })} placeholder="最强的不支持证据是什么？没有也要写明为什么没有。" /></label>
      </article>
      <article className="signoff-card">
        <small>04 / EXPERT SIGN-OFF</small><h3>专家概率，而不是模糊高分</h3>
        <label className="probability-control"><span>关系成立概率</span><b>{value.probability}%</b><input type="range" min="5" max="95" step="5" value={value.probability} onChange={e => onChange({ ...value, probability: Number(e.target.value), signedOff: false })} /></label>
        <p>“70%”意味着：在相同主体范围、口径和时间窗口下，十次中约七次能被后续事实支持。</p>
        <button className={value.signedOff ? "signed" : ""} disabled={!gate.states.slice(0, 5).every(Boolean)} onClick={() => onChange({ ...value, signedOff: !value.signedOff })}>{value.signedOff ? "✓ 已由专家签署" : "签署这次关系判断"}</button>
      </article>
    </div>
  </section>;
}
