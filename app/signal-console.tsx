"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Constraints, Feedback, ModelAnalysis, Signal, Snapshot, Verdict,
  attribute, emptyConstraints, gateState, initialWeights, isExpired,
  makeSignal, normalizeSignal, normalizeWeights, verdictText,
} from "../lib/field-core";
import { DIMENSIONS, PersonRole, RELATIONS, palette, relationLabel } from "../lib/ontology";
import { ConstraintPanel } from "./console/constraint-panel";
import { RelationGraph } from "./console/relation-graph";
import { Calibration, EvidenceLedger, Library, RelationClusters, RelationSummary, Rules } from "./console/views";
import { AIReview, Draft, EvidenceModal, ModelConfig, ModelModal } from "./console/modals";
import { Candidate, Intake } from "./console/intake";
import { PeopleView } from "./console/people-view";
import { PersonNode } from "../lib/people";
import { Sandbox } from "./console/sandbox";
import { EmptyField, Step, ViewHeader } from "./console/shared";

type View = "本地判断" | "关系图" | "人物测绘" | "供给管线" | "情报库" | "关系簇" | "证据账本" | "校准记录" | "规则设置" | "沙盘推演";
const NAV: View[] = ["本地判断", "关系图", "人物测绘", "供给管线", "情报库", "关系簇", "证据账本", "校准记录", "规则设置", "沙盘推演"];
const TOPIC_RULES = RELATIONS.map(item => ({ id: item.id, words: item.words }));
const emptyDraft = (): Draft => ({ title: "", evidence: "", source: "人工录入", sourceUrl: "", from: "", to: "", relation: "equity", direction: "forward" });

export function SignalConsole() {
  const [view, setView] = useState<View>("本地判断");
  const [weights, setWeights] = useState(initialWeights);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [people, setPeople] = useState<PersonNode[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [feedbackNote, setFeedbackNote] = useState("");
  const [executionQuality, setExecutionQuality] = useState(70);
  const [toast, setToast] = useState("");
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [workspaceStatus, setWorkspaceStatus] = useState("正在连接团队账本");
  const [showModel, setShowModel] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [model, setModel] = useState<ModelConfig>({ provider: "compatible", model: "", endpoint: "", apiKey: "" });
  const importer = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void fetch("/api/workspace").then(async response => {
      const data = await response.json() as Partial<{ initialized: boolean; weights: number[]; signals: Signal[]; feedback: Feedback[]; snapshots: Snapshot[]; people: PersonNode[]; error: string }>;
      if (!response.ok) throw new Error(data.error || "团队账本暂时不可用");
      if (data.initialized && Array.isArray(data.signals)) {
        const nextWeights = normalizeWeights(data.weights || initialWeights);
        const restored = data.signals.map(signal => normalizeSignal(signal, nextWeights, TOPIC_RULES));
        setWeights(nextWeights); setSignals(restored); setFeedback(data.feedback || []); setSnapshots(data.snapshots || []);
        setPeople(data.people || []);
        if (restored[0]) setSelectedId(restored[0].id);
      }
      setWorkspaceReady(true);
      setWorkspaceStatus(data.initialized ? "团队账本已连接" : "正在建立首个团队账本");
    }).catch(error => setWorkspaceStatus(error instanceof Error ? error.message : "团队账本连接失败"));
  }, []);

  useEffect(() => {
    if (!workspaceReady) return;
    const timer = window.setTimeout(() => {
      void fetch("/api/workspace", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ weights, signals, feedback, snapshots, people }) })
        .then(async response => {
          if (!response.ok) { const data = await response.json() as { error?: string }; throw new Error(data.error || "保存失败"); }
          setWorkspaceStatus("团队账本已同步");
        }).catch(error => setWorkspaceStatus(error instanceof Error ? error.message : "同步失败"));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [weights, signals, feedback, snapshots, people, workspaceReady]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(""), 2800); return () => window.clearTimeout(timer); }, [toast]);

  const selected = signals.find(signal => signal.id === selectedId) || signals[0];
  const visibleSignals = useMemo(() => {
    const key = query.trim().toLowerCase();
    if (!key) return signals;
    return signals.filter(signal => `${signal.title} ${signal.evidence} ${signal.source} ${signal.topics.join(" ")} ${(signal.edges || []).map(edge => `${edge.from} ${edge.to}`).join(" ")}`.toLowerCase().includes(key));
  }, [signals, query]);

  const relationSummary = useMemo<RelationSummary[]>(() => RELATIONS.map(relation => {
    const evidence = signals.filter(signal => signal.topics.includes(relation.id));
    const admitted = evidence.filter(signal => gateState(signal).executable && !isExpired(signal));
    const relatedFeedback = feedback.filter(item => item.topicId === relation.id && item.executionQuality >= 60);
    const score = admitted.length ? Math.round(admitted.reduce((sum, item) => sum + item.constraints.probability, 0) / admitted.length) : 0;
    const confirmed = relatedFeedback.filter(item => item.verdict === "confirmed").length;
    const counter = relatedFeedback.filter(item => item.verdict === "counter").length;
    return { ...relation, evidence, admitted, confirmed, counter, confidence: Math.max(0, Math.min(99, score + confirmed * 3 - counter * 5)) };
  }), [signals, feedback]);

  /** 名册是事实清单：加错了就删，不需要过闸也不需要签署。
   *  关于这个人的判断另走六道门——名册本身不主张任何东西。 */
  function addPerson(role: PersonRole) {
    const person: PersonNode = { ...role, id: `person-${Date.now()}-${Math.random().toString(16).slice(2)}`, createdAt: new Date().toISOString() };
    setPeople(items => [person, ...items]);
    setToast(`${person.name} 已入册：接下来录一条关于他的可核查判断`);
  }
  function removePerson(id: string) {
    setPeople(items => items.filter(item => item.id !== id));
  }

  function updateConstraints(next: Constraints) {
    if (!selected) return;
    setSignals(items => items.map(item => item.id === selected.id ? { ...item, constraints: next } : item));
  }

  function addSignal() {
    if (!draft.title.trim() || !draft.evidence.trim()) { setToast("请至少填写情报标题和原始依据"); return; }
    const edges = draft.from.trim() && draft.to.trim() ? [{ from: draft.from.trim(), to: draft.to.trim(), relation: draft.relation, direction: draft.direction }] : [];
    const signal = makeSignal({ ...draft, edges, origin: "manual" }, weights, TOPIC_RULES);
    setSignals(items => [signal, ...items]);
    setSelectedId(signal.id); setDraft(emptyDraft()); setShowAdd(false); setView("本地判断");
    setToast("情报已入场：下一步补齐主体范围与证伪条件");
  }

  /**
   * 管线与沙盘写入：一律 hypothesis + related，六道门全空，结构性卡在第 5 道门。
   * origin 保留候选自带的标记（pipeline / simulation），缺省才算 pipeline——
   * 推演产物必须能在库里被认出来，不能混进抓取来的东西里。
   *
   * 私有情报（origin=private）是唯一改这两项的入口：它是人手录的，认识状态确实是
   * 观察（你听到了这句话），来源谱系是人际渠道。只允许覆盖这三个字段，
   * 其余门一个不预填——模型和采集器永远碰不到约束门。
   */
  function acceptCandidates(candidates: Candidate[]) {
    const created = candidates.map(candidate => makeSignal({
      title: candidate.title, evidence: candidate.evidence, source: candidate.source, sourceUrl: candidate.sourceUrl,
      edges: candidate.edges.map(edge => ({ from: edge.from, to: edge.to, relation: edge.relation, direction: edge.direction })),
      origin: candidate.origin || "pipeline",
      constraints: candidate.origin === "private"
        ? { ...emptyConstraints(), epistemicState: candidate.constraints?.epistemicState || "observation", sourceType: "internal", humanSource: candidate.constraints?.humanSource || "" }
        : { ...emptyConstraints(), epistemicState: "hypothesis", sourceType: "related" },
    }, weights, TOPIC_RULES));
    setSignals(items => [...created, ...items]);
    if (created[0]) setSelectedId(created[0].id);
    const privateCount = created.filter(item => item.origin === "private").length;
    const simulated = created.filter(item => item.origin === "simulation").length;
    setToast(privateCount
      ? `已写入 ${created.length} 条私有情报：人际渠道属于弱来源，仍需补齐边界、证伪与有效期`
      : simulated
        ? `已写入 ${created.length} 条待验证假设：推演态，卡在第 5 道门，需补真实来源`
        : `已写入 ${created.length} 条候选：假设态 + 同源，卡在第 5 道门等待人工补齐`);
  }

  function recordFeedback(verdict: Verdict) {
    if (!selected) return;
    if (!gateState(selected).executable) { setToast("约束门尚未全部通过，不能让结果改写评分体系"); return; }
    const { attributable, nextWeights, weightChange, brierScore } = attribute(selected, weights, verdict, executionQuality);
    const topicId = selected.topics.find(topic => topic !== "unclustered") || "unclustered";
    setWeights(nextWeights);
    setSignals(items => items.map(item => item.id === selected.id ? { ...item, outcome: verdict } : item));
    setFeedback(items => [{ id: `feedback-${Date.now()}`, signalId: selected.id, topicId, verdict, note: feedbackNote.trim() || "未填写补充说明", createdAt: "刚刚", weightChange, executionQuality, predictedProbability: selected.constraints.probability, brierScore }, ...items]);
    setFeedbackNote("");
    setToast(!attributable ? "结果已记录，但执行质量不足：本轮不校准判断" : verdict === "confirmed" ? "结果支持判断，已完成一次校准" : verdict === "counter" ? "反例已入账，判断权重已反向修正" : "继续观察，本轮不改动权重");
  }

  function saveSnapshot() {
    setSnapshots(items => [{ id: `snapshot-${Date.now()}`, title: selected ? `${selected.title.slice(0, 16)} · 关系判断` : "关系判断", createdAt: "刚刚", signalCount: signals.length, feedbackCount: feedback.length, note: `当前权重 ${weights.join(" / ")}` }, ...items]);
    setToast("当前关系模型已保存");
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), weights, signals, feedback, snapshots }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = "intel-engine-workspace.json"; link.click(); URL.revokeObjectURL(url);
    setToast("工作区数据已导出");
  }

  function importData(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as Partial<{ weights: number[]; signals: Signal[]; feedback: Feedback[]; snapshots: Snapshot[] }>;
        if (!Array.isArray(data.signals)) throw new Error();
        const nextWeights = Array.isArray(data.weights) && data.weights.length === 4 ? normalizeWeights(data.weights) : weights;
        const incoming = data.signals.map(signal => normalizeSignal(signal, nextWeights, TOPIC_RULES));
        setWeights(nextWeights); setSignals(incoming); setFeedback(data.feedback || []); setSnapshots(data.snapshots || []); setSelectedId(incoming[0]?.id || "");
        setToast(`已导入 ${incoming.length} 条情报`);
      } catch { setToast("无法识别该 JSON 文件"); }
    };
    reader.readAsText(file); event.target.value = "";
  }

  async function runModelAnalysis() {
    if (!selected) return;
    if (!model.apiKey.trim()) { setShowModel(true); setToast("先在模型连接器中输入本次会话密钥"); return; }
    setAnalyzing(true);
    // 推理类模型经常要 30 秒以上。先告诉用户在等什么，别让它看起来像卡死了。
    setToast("正在请求模型批评，推理类模型可能需要 30 秒以上…");
    try {
      const response = await fetch("/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: model.provider, model: model.model, endpoint: model.endpoint, apiKey: model.apiKey, title: selected.title, evidence: selected.evidence, source: selected.source }) });
      const data = await response.json() as { analysis?: Omit<ModelAnalysis, "provider" | "model" | "generatedAt">; provider?: string; model?: string; generatedAt?: string; error?: string; detail?: string };
      if (!response.ok || !data.analysis) throw new Error(data.error || data.detail || "模型没有返回有效判断");
      const aiAnalysis: ModelAnalysis = { ...data.analysis, provider: data.provider || model.provider, model: data.model || model.model, generatedAt: data.generatedAt || new Date().toISOString() };
      setSignals(items => items.map(item => item.id === selected.id ? { ...item, aiAnalysis } : item));
      setToast("模型已提出局部解释与反证建议，等待专家审阅");
    } catch (error) { setToast(error instanceof Error ? error.message : "模型分析失败"); }
    finally { setAnalyzing(false); }
  }

  /** 采纳模型建议只写草稿，并强制清空签署。 */
  function adoptModelAnalysis() {
    if (!selected?.aiAnalysis) return;
    const analysis = selected.aiAnalysis;
    const dimensions = selected.dimensions.map(item => {
      const suggestion = analysis.dimensions?.find(candidate => candidate.dimension === item.dimension);
      return suggestion ? { ...item, score: Math.max(0, Math.min(100, Math.round(suggestion.score))), matches: suggestion.evidence?.slice(0, 5) || item.matches, reason: suggestion.reason || item.reason } : item;
    });
    const topics = (analysis.candidate_topics || []).map(candidate => RELATIONS.find(item => item.label === candidate.label)?.id).filter((value): value is NonNullable<typeof value> => Boolean(value));
    const candidateScore = Math.round(dimensions.reduce((sum, item, index) => sum + item.score * weights[index], 0) / 100);
    const current = selected.constraints;
    const constraints: Constraints = {
      ...current,
      epistemicState: analysis.epistemic_state || current.epistemicState,
      falsifier: current.falsifier || analysis.falsifiers?.join("；") || "",
      counterEvidence: current.counterEvidence || analysis.counterevidence?.join("；") || "",
      probability: Math.max(5, Math.min(95, Math.round(analysis.confidence || current.probability))),
      scope: { ...current.scope, ...(analysis.local_context || {}) },
      signedOff: false,
    };
    setSignals(items => items.map(item => item.id === selected.id ? { ...item, dimensions, topics: topics.length ? topics : item.topics, candidateScore, constraints } : item));
    setToast("模型建议已填入草稿；专家签署仍被清空，需要重新审阅");
  }

  const admittedCount = signals.filter(signal => gateState(signal).executable).length;
  const edgeCount = signals.reduce((sum, signal) => sum + (signal.edges?.length || 0), 0);

  return <main className="console-app core-app field-app">
    <header className="console-topbar">
      <button className="console-brand" onClick={() => setView("本地判断")}><span>TD</span><b>INTEL ENGINE</b></button>
      <label className="console-search"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索主体、关系或原始依据" /><kbd>⌘ K</kbd></label>
      <div className="console-actions">
        <button className="model-action" onClick={() => setShowModel(true)}>◈ {model.provider} / {model.model || "未设置"}</button>
        <button className="ghost-action" onClick={() => importer.current?.click()}>导入</button>
        <button className="ghost-action" onClick={exportData}>导出</button>
        <button className="primary-action" onClick={() => setShowAdd(true)}>＋ 录入情报</button>
        <input ref={importer} className="file-input" type="file" accept="application/json" onChange={importData} />
      </div>
    </header>
    <aside className="console-sidebar">
      <div className="workspace-name"><small>ENTERPRISE RELATION</small><strong>局部关系模型</strong><span>intelligence → judgment</span></div>
      <nav>{NAV.map(item => <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}><i />{item}</button>)}</nav>
      <div className="console-health"><i /> {workspaceReady ? "LOCAL MODEL" : "CONNECTING"}<br /><span>{workspaceStatus}</span></div>
    </aside>
    <section className="console-main">
      {view === "本地判断" && selected && <Workbench signal={selected} weights={weights} feedbackNote={feedbackNote} setFeedbackNote={setFeedbackNote} executionQuality={executionQuality} setExecutionQuality={setExecutionQuality} onFeedback={recordFeedback} onOpen={() => setShowAdd(true)} onAnalyze={runModelAnalysis} analyzing={analyzing} onAdopt={adoptModelAnalysis} onConstraints={updateConstraints} />}
      {view === "本地判断" && !selected && <EmptyField ready={workspaceReady} onOpen={() => setShowAdd(true)} />}
      {view === "关系图" && <RelationGraph signals={signals} onOpenSignal={id => { setSelectedId(id); setView("本地判断"); }} />}
      {view === "人物测绘" && <PeopleView people={people} signals={signals} onAdd={addPerson} onRemove={removePerson} onOpenSignal={signal => { setSelectedId(signal.id); setView("本地判断"); }} />}
      {view === "供给管线" && <Intake existing={signals} onAccept={acceptCandidates} />}
      {view === "沙盘推演" && <Sandbox onAccept={acceptCandidates} />}
      {view === "情报库" && <Library signals={visibleSignals} selectedId={selectedId} onSelect={id => { setSelectedId(id); setView("本地判断"); }} />}
      {view === "关系簇" && <RelationClusters topics={relationSummary} onOpen={signal => { setSelectedId(signal.id); setView("本地判断"); }} />}
      {view === "证据账本" && <EvidenceLedger signals={signals} onSelect={id => { setSelectedId(id); setView("本地判断"); }} />}
      {view === "校准记录" && <Calibration feedback={feedback} signals={signals} weights={weights} snapshots={snapshots} onSnapshot={saveSnapshot} />}
      {view === "规则设置" && <Rules weights={weights} setWeights={setWeights} normalize={normalizeWeights} onReset={() => { setWeights(initialWeights); setToast("权重已恢复为均衡初始值"); }} />}
    </section>
    <footer className="console-status">
      <span><b>{signals.length}</b> INTELLIGENCE</span>
      <span><b>{edgeCount}</b> RELATIONS</span>
      <span><b>{admittedCount}</b> ADMITTED</span>
      <span><b>{feedback.length}</b> OUTCOMES</span>
      <span className="status-spacer">有边界 · 可证伪 · 会校准</span>
      <span className="online-dot">● intel engine</span>
    </footer>
    {showAdd && <EvidenceModal draft={draft} setDraft={setDraft} onClose={() => setShowAdd(false)} onSubmit={addSignal} />}
    {showModel && <ModelModal model={model} setModel={setModel} onClose={() => setShowModel(false)} />}
    {toast && <div className="toast">● {toast}</div>}
  </main>;
}

function Workbench({ signal, weights, feedbackNote, setFeedbackNote, executionQuality, setExecutionQuality, onFeedback, onOpen, onAnalyze, analyzing, onAdopt, onConstraints }: {
  signal: Signal; weights: number[]; feedbackNote: string; setFeedbackNote: (value: string) => void;
  executionQuality: number; setExecutionQuality: (value: number) => void; onFeedback: (value: Verdict) => void;
  onOpen: () => void; onAnalyze: () => void; analyzing: boolean; onAdopt: () => void; onConstraints: (value: Constraints) => void;
}) {
  const gate = gateState(signal);
  return <>
    <ViewHeader kicker="INTEL ENGINE / LOCAL RELATION JUDGMENT" title="情报不直接生成关系结论。" copy="它先进入具体的主体范围、市场区域、数据口径和时间窗口，再形成可以被真实世界修正的判断。" action="录入新情报" onAction={onOpen} />
    <div className="field-loop">
      <Step number="01" label="情报" value="原始事实" /><span>→</span>
      <Step number="02" label="局部世界" value="边界与口径" /><span>→</span>
      <Step number="03" label="判断" value={`${signal.constraints.probability}%`} /><span>→</span>
      <Step number="04" label="行动" value={gate.executable ? "允许进入" : "约束拦截"} /><span>→</span>
      <Step number="05" label="结果" value={verdictText(signal.outcome)} />
      <b>↺</b><em>修正局部模型</em>
    </div>
    <div className="workbench-grid">
      <section className="evidence-card">
        <div className="card-kicker">RAW INTELLIGENCE / {signal.id.slice(-6).toUpperCase()}{signal.origin === "pipeline" ? " · PIPELINE" : signal.origin === "simulation" ? " · SANDBOX" : ""}</div>
        <h2>{signal.title}</h2><p>{signal.evidence}</p>
        <div className="evidence-meta"><span>{signal.source}</span>{signal.sourceUrl && <a href={signal.sourceUrl} target="_blank" rel="noreferrer">原始链接 ↗</a>}<time>{signal.createdAt}</time></div>
        {(signal.edges?.length ?? 0) > 0 && <div className="signal-edges">{signal.edges!.map((edge, index) => <span key={index}>{edge.from} {edge.direction === "mutual" ? "↔" : "→"} {edge.to}<small>{relationLabel(edge.relation)}</small></span>)}</div>}
        <div className="topic-pills">{signal.topics.map(id => <span key={id}>{relationLabel(id)}</span>)}</div>
      </section>
      <section className="trace-card">
        <div className="card-kicker">DIRECTIONAL SCORE / NOT A VERDICT</div>
        <div className="score-total"><div><small>候选度</small><b>{signal.candidateScore}</b><span>只决定拷问优先级，不决定行动</span></div><div className="score-orbit"><i /><b>{signal.candidateScore}</b></div></div>
        <div className="dimension-trace">{signal.dimensions.map((item, index) => <article key={item.dimension}>
          <div><b>{item.dimension}</b><span>{item.reason}</span></div><strong>{item.score}</strong>
          <i><em style={{ width: `${item.score}%`, background: palette[index + 1] }} /></i>
          <p>{item.matches.length ? `命中：${item.matches.join(" · ")}` : "缺少明确线索"}</p>
        </article>)}</div>
      </section>
    </div>
    <ConstraintPanel signal={signal} onChange={onConstraints} />
    <AIReview analysis={signal.aiAnalysis} onAnalyze={onAnalyze} analyzing={analyzing} onAdopt={onAdopt} />
    <section className={`feedback-deck field-feedback ${gate.executable ? "ready" : "locked"}`}>
      <div><small>REAL-WORLD FEEDBACK / ATTRIBUTION</small><h3>{gate.executable ? "真实结果，支持这次关系判断吗？" : `约束门 ${gate.passed}/6：尚不能进入执行`}</h3><p>执行质量低于 60 时只记录结果，不改写判断权重。</p></div>
      <label>执行质量 <b>{executionQuality}</b><input type="range" min="0" max="100" value={executionQuality} onChange={event => setExecutionQuality(Number(event.target.value))} /></label>
      <label>结果证据<input value={feedbackNote} onChange={event => setFeedbackNote(event.target.value)} placeholder="发生了什么，而不是如何解释" /></label>
      <div className="verdict-actions">
        <button disabled={!gate.executable} className="confirm" onClick={() => onFeedback("confirmed")}>✓ 支持</button>
        <button disabled={!gate.executable} onClick={() => onFeedback("watching")}>○ 观察</button>
        <button disabled={!gate.executable} className="counter" onClick={() => onFeedback("counter")}>× 反例</button>
      </div>
    </section>
    <section className="weight-ribbon">
      <span>当前权重</span>
      {DIMENSIONS.map((item, index) => <div key={item.dimension}><b>{item.dimension}</b><i><em style={{ width: `${weights[index]}%` }} /></i><strong>{weights[index]}%</strong></div>)}
      <small>只接受可归因的真实结果</small>
    </section>
  </>;
}
