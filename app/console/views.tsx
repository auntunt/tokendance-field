"use client";

import { Feedback, Signal, Snapshot, epistemicText, gateState, verdictText, verdictTone } from "../../lib/field-core";
import { DIMENSIONS, RELATIONS, palette } from "../../lib/ontology";
import { ViewHeader } from "./shared";

export function Library({ signals, selectedId, onSelect }: { signals: Signal[]; selectedId: string; onSelect: (id: string) => void }) {
  return <><ViewHeader kicker="全部情报" title="手上有什么" copy="看到的、推的、猜的分开放。每条都留着来源和有效期。" />
    <section className="library-table">
      <div className="library-head"><span>情报与原文</span><span>性质 / 来源</span><span>还差</span><span>能不能用</span></div>
      {signals.map(signal => { const gate = gateState(signal); const left = 6 - gate.passed; return <button className={signal.id === selectedId ? "selected" : ""} key={signal.id} onClick={() => onSelect(signal.id)}>
        <div><small>{signal.source} · {signal.createdAt}</small><b>{signal.title}</b><p>{signal.evidence}</p></div>
        <div className="row-tags"><span>{epistemicText(signal.constraints.epistemicState)}</span><span>{signal.constraints.sourceType === "independent" ? "独立第三方" : signal.constraints.sourceType === "related" ? "当事人自己发的" : signal.constraints.sourceType === "internal" ? "自己打听的" : "来源未标"}</span></div>
        <strong className="signal-score">{left ? `${left} 项` : "—"}</strong>
        <i className={gate.executable ? "good" : "watching"}>{gate.executable ? "可以用" : "还不行"}</i>
      </button>; })}
      {!signals.length && <div className="empty-log">没有匹配的情报。</div>}
    </section></>;
}

export type RelationSummary = typeof RELATIONS[number] & { evidence: Signal[]; admitted: Signal[]; confirmed: number; counter: number; confidence: number };

export function RelationClusters({ topics, onOpen }: { topics: RelationSummary[]; onOpen: (signal: Signal) => void }) {
  return <><ViewHeader kicker="第 2 步 / 看关系" title="按关系类型分组看" copy="每一类的百分比只按已补齐的材料算。没补齐的照样列在下面，但抬不高这个数——看得见，不算数。" />
    <section className="topic-cluster-grid">{topics.map((topic, index) => <article key={topic.id}>
      <header><span style={{ background: palette[index % palette.length] }} /><div><small>{topic.evidence.length} 条</small><h2>{topic.label}</h2></div><b>{topic.confidence || "—"}</b></header>
      <p>{topic.hint}。共 {topic.evidence.length} 条，其中 {topic.admitted.length} 条已补齐 · 后来对了 {topic.confirmed} 次 · 出过 {topic.counter} 个反例</p>
      <div className="cluster-meter"><i><em style={{ width: `${topic.confidence}%`, background: palette[index % palette.length] }} /></i><span>按真实结果校准后的把握</span></div>
      <div className="cluster-evidence">{topic.evidence.slice(0, 3).map(signal => <button key={signal.id} onClick={() => onOpen(signal)}>{gateState(signal).executable ? "●" : "○"} {signal.title}</button>)}{!topic.evidence.length && <span>这一类还没有材料</span>}</div>
    </article>)}</section></>;
}

export function EvidenceLedger({ signals, onSelect }: { signals: Signal[]; onSelect: (id: string) => void }) {
  return <><ViewHeader kicker="第 3 步 / 下结论" title="有没有人查过反面" copy="支持材料堆多少都不算过硬。经得起最强反面证据的才算。" />
    <section className="ledger-grid">{signals.map(signal => <article key={signal.id}>
      <header><small>{signal.source}</small><b className={gateState(signal).executable ? "good" : "watching"}>{6 - gateState(signal).passed ? `还差 ${6 - gateState(signal).passed} 项` : "六项已齐"}</b></header>
      <h3>{signal.title}</h3>
      <div><span>什么情况不成立<b>{signal.constraints.falsifier ? "已写" : "没写"}</b></span><span>反面证据<b>{signal.constraints.counterEvidence ? "已写" : "没写"}</b></span><span>你给的概率<b>{signal.constraints.probability}%</b></span></div>
      <button onClick={() => onSelect(signal.id)}>去补 →</button>
    </article>)}{!signals.length && <div className="empty-log">还没有情报。</div>}</section></>;
}

export function Calibration({ feedback, signals, weights, snapshots, onSnapshot }: { feedback: Feedback[]; signals: Signal[]; weights: number[]; snapshots: Snapshot[]; onSnapshot: () => void }) {
  const scored = feedback.filter(item => item.executionQuality >= 60 && item.verdict !== "watching");
  const meanError = scored.length ? Math.round(scored.reduce((sum, item) => sum + item.brierScore, 0) / scored.length) : null;
  return <><ViewHeader kicker="第 3 步 / 下结论" title="判断错了，和事情办差了，是两回事" copy="只有办到位、结果又明确的那些，才拿来校准概率。办差了的照样记下来，但不算你判断错。" action="存一个快照" onAction={onSnapshot} />
    <div className="calibration-layout">
      <section className="calibration-chart"><small>当前模型</small><h2>概率平均偏了 {meanError === null ? "—" : meanError}</h2>
        {DIMENSIONS.map((dimension, index) => <div key={dimension.dimension} className="weight-row"><span>{dimension.dimension}</span><i><em style={{ width: `${weights[index]}%`, background: palette[index + 1] }} /></i><b>{weights[index]}%</b></div>)}
        <p>这个数越小，说明你说「七成」的时候，长期真的差不多有七成。</p></section>
      <section className="feedback-log"><small>后来实际发生了什么</small>
        {feedback.length ? feedback.map(item => { const signal = signals.find(value => value.id === item.signalId); return <article key={item.id}>
          <i className={verdictTone(item.verdict)} />
          <div><b>{verdictText(item.verdict)} · {signal?.title || "已删除情报"}</b><p>{item.note}</p>
            <span>当时说 {item.predictedProbability ?? "—"}% · 执行 {item.executionQuality ?? "—"} 分 · 偏了 {item.brierScore ?? "—"} · {item.weightChange}</span></div>
        </article>; }) : <div className="empty-log">还没记过真实结果。不记结果，这里就永远是空的——系统不会自己变准。</div>}</section>
    </div>
    {snapshots.length > 0 && <section className="snapshot-row"><small>存过的快照</small>{snapshots.map(snapshot => <article key={snapshot.id}><b>{snapshot.title}</b><span>{snapshot.signalCount} 条情报 · {snapshot.feedbackCount} 次结果</span><time>{snapshot.createdAt}</time></article>)}</section>}</>;
}

export function Rules({ weights, setWeights, onReset, normalize }: { weights: number[]; setWeights: (weights: number[]) => void; onReset: () => void; normalize: (values: number[]) => number[] }) {
  return <><ViewHeader kicker="第 3 步 / 下结论" title="排序规则在这里调" copy="下面这些权重只决定「先看哪一条」，不决定「哪一条能用」。能不能用，只看那六项写齐了没有——权重调成什么样都改不了这件事。" />
    <section className="rules-grid">{DIMENSIONS.map((rule, index) => <article key={rule.dimension}>
      <small>排序维度 {index + 1}</small><h2>{rule.dimension}</h2><p>{rule.reason}</p>
      <div className="rule-keywords">{rule.words.map(word => <span key={word}>{word}</span>)}</div>
      <label>当前权重 <b>{weights[index]}%</b><input type="range" min="12" max="40" value={weights[index]} onChange={event => { const next = [...weights]; next[index] = Number(event.target.value); setWeights(normalize(next)); }} /></label>
    </article>)}</section>
    <section className="rules-grid" style={{ marginTop: 14 }}>{RELATIONS.map((relation, index) => <article key={relation.id}>
      <small>关系类型</small><h2>{relation.label}</h2><p>{relation.hint}</p>
      <div className="rule-keywords">{relation.words.map(word => <span key={word}>{word}</span>)}</div>
      <label style={{ color: "#7a8b9b" }}>这些词只决定归到哪一类，不影响能不能用<b style={{ color: palette[index % palette.length] }}>●</b></label>
    </article>)}</section>
    <section className="rule-note"><div><small>这条不能调</small><h3>适用范围、这句话的性质、什么情况下不成立、反面证据、谁说的和何时过期、签字——缺一项就不放行。</h3><p>能调的是「先看哪种关系」，不能调的是「一条判断算不算站得住」。</p></div><button onClick={onReset}>权重调回平均</button></section></>;
}
