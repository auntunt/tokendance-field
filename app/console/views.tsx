"use client";

import { Feedback, Signal, Snapshot, epistemicText, gateState, verdictText, verdictTone } from "../../lib/field-core";
import { DIMENSIONS, RELATIONS, palette } from "../../lib/ontology";
import { ViewHeader } from "./shared";

export function Library({ signals, selectedId, onSelect }: { signals: Signal[]; selectedId: string; onSelect: (id: string) => void }) {
  return <><ViewHeader kicker="INTELLIGENCE LIBRARY" title="情报库不是答案库" copy="观察、解释、假设和行动主张被明确分层；每条关系情报都保留来源谱系、有效期和它声称的边。" />
    <section className="library-table">
      <div className="library-head"><span>情报与依据</span><span>认识状态</span><span>过闸</span><span>状态</span></div>
      {signals.map(signal => { const gate = gateState(signal); return <button className={signal.id === selectedId ? "selected" : ""} key={signal.id} onClick={() => onSelect(signal.id)}>
        <div><small>{signal.source} · {signal.createdAt}{signal.origin && signal.origin !== "manual" ? ` · ${signal.origin}` : ""}</small><b>{signal.title}</b><p>{signal.evidence}</p></div>
        <div className="row-tags"><span>{epistemicText(signal.constraints.epistemicState)}</span><span>{signal.constraints.sourceType === "independent" ? "独立来源" : signal.constraints.sourceType === "related" ? "同源" : signal.constraints.sourceType === "internal" ? "人际渠道" : "谱系未标"}</span></div>
        <strong className="signal-score">{gate.passed}/6</strong>
        <i className={gate.executable ? "good" : "watching"}>{gate.executable ? "可执行" : "被拦截"}</i>
      </button>; })}
      {!signals.length && <div className="empty-log">没有匹配的情报。</div>}
    </section></>;
}

export type RelationSummary = typeof RELATIONS[number] & { evidence: Signal[]; admitted: Signal[]; confirmed: number; counter: number; confidence: number };

export function RelationClusters({ topics, onOpen }: { topics: RelationSummary[]; onOpen: (signal: Signal) => void }) {
  return <><ViewHeader kicker="RELATION TYPE CLUSTERS" title="关系置信度只接受过闸证据" copy="未声明主体范围、无法证伪或未经专家签署的关系可以被看见，但不会抬高该类型的置信度。" />
    <section className="topic-cluster-grid">{topics.map((topic, index) => <article key={topic.id}>
      <header><span style={{ background: palette[index % palette.length] }} /><div><small>CLUSTER / {topic.id.toUpperCase()}</small><h2>{topic.label}</h2></div><b>{topic.confidence || "—"}</b></header>
      <p>{topic.hint}。{topic.evidence.length} 条观察 · {topic.admitted.length} 条过闸 · {topic.confirmed} 次支持 · {topic.counter} 个反例</p>
      <div className="cluster-meter"><i><em style={{ width: `${topic.confidence}%`, background: palette[index % palette.length] }} /></i><span>校准概率</span></div>
      <div className="cluster-evidence">{topic.evidence.slice(0, 3).map(signal => <button key={signal.id} onClick={() => onOpen(signal)}>{gateState(signal).executable ? "●" : "○"} {signal.title}</button>)}{!topic.evidence.length && <span>等待情报进入</span>}</div>
    </article>)}</section></>;
}

export function EvidenceLedger({ signals, onSelect }: { signals: Signal[]; onSelect: (id: string) => void }) {
  return <><ViewHeader kicker="EVIDENCE + COUNTEREVIDENCE" title="证据与反例，必须同时入账" copy="专业性不来自支持材料的数量，而来自这条关系判断能否承受最强反证。" />
    <section className="ledger-grid">{signals.map(signal => <article key={signal.id}>
      <header><small>{signal.source} · {epistemicText(signal.constraints.epistemicState)}</small><b className={gateState(signal).executable ? "good" : "watching"}>{gateState(signal).passed}/6</b></header>
      <h3>{signal.title}</h3><p>{signal.evidence}</p>
      <div><span>证伪<b>{signal.constraints.falsifier ? "已写" : "缺失"}</b></span><span>反例<b>{signal.constraints.counterEvidence ? "已写" : "缺失"}</b></span><span>概率<b>{signal.constraints.probability}%</b></span></div>
      <button onClick={() => onSelect(signal.id)}>打开局部判断 →</button>
    </article>)}{!signals.length && <div className="empty-log">证据账本为空。</div>}</section></>;
}

export function Calibration({ feedback, signals, weights, snapshots, onSnapshot }: { feedback: Feedback[]; signals: Signal[]; weights: number[]; snapshots: Snapshot[]; onSnapshot: () => void }) {
  const scored = feedback.filter(item => item.executionQuality >= 60 && item.verdict !== "watching");
  const meanError = scored.length ? Math.round(scored.reduce((sum, item) => sum + item.brierScore, 0) / scored.length) : null;
  return <><ViewHeader kicker="CALIBRATION HISTORY" title="判断正确与执行成功，分开归因" copy="只有执行质量足够、结果明确的样本才校准概率；其余结果保留，但不污染专家判断。" action="保存模型快照" onAction={onSnapshot} />
    <div className="calibration-layout">
      <section className="calibration-chart"><small>RELATION MODEL / CURRENT</small><h2>平均概率误差 {meanError === null ? "—" : meanError}</h2>
        {DIMENSIONS.map((dimension, index) => <div key={dimension.dimension} className="weight-row"><span>{dimension.dimension}</span><i><em style={{ width: `${weights[index]}%`, background: palette[index + 1] }} /></i><b>{weights[index]}%</b></div>)}
        <p>误差越低，专家给出的关系成立概率越接近长期真实命中率。</p></section>
      <section className="feedback-log"><small>OUTCOME + ATTRIBUTION LOG</small>
        {feedback.length ? feedback.map(item => { const signal = signals.find(value => value.id === item.signalId); return <article key={item.id}>
          <i className={verdictTone(item.verdict)} />
          <div><b>{verdictText(item.verdict)} · {signal?.title || "已删除情报"}</b><p>{item.note}</p>
            <span>预测 {item.predictedProbability ?? "—"}% · 执行质量 {item.executionQuality ?? "—"} · 概率误差 {item.brierScore ?? "—"} · {item.weightChange}</span></div>
        </article>; }) : <div className="empty-log">还没有真实结果。关系模型不会在无反馈时自行进化。</div>}</section>
    </div>
    {snapshots.length > 0 && <section className="snapshot-row"><small>关系模型快照</small>{snapshots.map(snapshot => <article key={snapshot.id}><b>{snapshot.title}</b><span>{snapshot.signalCount} 条情报 · {snapshot.feedbackCount} 次反馈</span><time>{snapshot.createdAt}</time></article>)}</section>}</>;
}

export function Rules({ weights, setWeights, onReset, normalize }: { weights: number[]; setWeights: (weights: number[]) => void; onReset: () => void; normalize: (values: number[]) => number[] }) {
  return <><ViewHeader kicker="INTEL ENGINE / GOVERNANCE" title="评分给方向，约束决定能否行动" copy="四维评分负责发现值得优先拷问的关系；六道约束门负责阻止没有边界的自信。" />
    <section className="rules-grid">{DIMENSIONS.map((rule, index) => <article key={rule.dimension}>
      <small>DIRECTION / {String(index + 1).padStart(2, "0")}</small><h2>{rule.dimension}</h2><p>{rule.reason}</p>
      <div className="rule-keywords">{rule.words.map(word => <span key={word}>{word}</span>)}</div>
      <label>当前权重 <b>{weights[index]}%</b><input type="range" min="12" max="40" value={weights[index]} onChange={event => { const next = [...weights]; next[index] = Number(event.target.value); setWeights(normalize(next)); }} /></label>
    </article>)}</section>
    <section className="rules-grid" style={{ marginTop: 14 }}>{RELATIONS.map((relation, index) => <article key={relation.id}>
      <small>RELATION / {relation.id.toUpperCase()}</small><h2>{relation.label}</h2><p>{relation.hint}</p>
      <div className="rule-keywords">{relation.words.map(word => <span key={word}>{word}</span>)}</div>
      <label style={{ color: "#5d6d7c" }}>聚类关键词只影响归簇，不影响过闸<b style={{ color: palette[index % palette.length] }}>●</b></label>
    </article>)}</section>
    <section className="rule-note"><div><small>NON-NEGOTIABLE</small><h3>主体范围、认识状态、证伪、反例、来源时效、专家签署：缺一项，不进入执行。</h3><p>换掉的是“看什么关系”，没换的是“如何在具体世界里判断”。</p></div><button onClick={onReset}>恢复均衡初始权重</button></section></>;
}
