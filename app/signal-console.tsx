"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Constraints, Feedback, ModelAnalysis, Signal, Snapshot, Verdict,
  attribute, emptyConstraints, gateState, initialWeights,
  makeSignal, missingGates, normalizeSignal, normalizeWeights,
} from "../lib/field-core";
import { proposeConstraints } from "../lib/auto-propose";
import { RELATIONS, relationLabel } from "../lib/ontology";
import { ConstraintPanel } from "./console/constraint-panel";
import { InvestigationGraph } from "./console/investigation-graph";
import { Calibration, EvidenceLedger, Library, Rules } from "./console/views";
import { AIReview, Draft, EvidenceModal, ModelConfig, ModelModal } from "./console/modals";
import { Candidate, Intake } from "./console/intake";
import { InvestigationWorkbench } from "./console/investigation-workbench";
import { IntelligenceDesk } from "./console/intelligence-desk";
import { FdeQueryPack } from "./console/fde-query-pack";
import { PersonNode } from "../lib/people";
import type { InvestigationSubjectType } from "../lib/investigation/types";
import { Sandbox } from "./console/sandbox";
import { EmptyField } from "./console/shared";

/**
 * 主路径只有两件事：先研究，再看关系。旧版“六道门判断/签字”不再出现在
 * 用户流程中；情报的可靠性改由来源、引用与跨来源印证表达。
 */
type Section = "desk" | "collect" | "relations" | "judgment";
const SECTIONS: Array<{ id: Section; label: string; hint: string }> = [
  { id: "desk", label: "情报看台", hint: "DESK / FLOW" },
  { id: "collect", label: "开始收集", hint: "ASK / VERIFY" },
  { id: "relations", label: "看关系", hint: "ENTITIES / EDGES" },
];
type JudgmentTab = "逐条判断" | "全部情报" | "校准记录" | "推演" | "设置";
/**
 * 「收集」里的三种入口，区别在于你手上已经有什么：
 *   开始研究 —— 只有一句听来的话。系统负责纠错、消歧、拆维度、去搜。
 *   导入材料 —— 已经有 URL 或正文了，直接抽。
 *   选择客户 —— 从上一份报告台账里挑下一家重点公司去查。
 * 它们出的候选走同一个 acceptCandidates，六道门一视同仁。
 */
type CollectTab = "开始研究" | "行业样本" | "导入材料";
const TOPIC_RULES = RELATIONS.map(item => ({ id: item.id, words: item.words }));
const emptyDraft = (): Draft => ({ title: "", evidence: "", source: "人工录入", sourceUrl: "", from: "", to: "", relation: "equity", direction: "forward" });

export function SignalConsole() {
  const [section, setSection] = useState<Section>(() => {
    if (typeof window === "undefined") return "desk";
    const value = new URLSearchParams(window.location.search).get("section");
    return value === "desk" || value === "collect" || value === "relations" ? value : "desk";
  });
  const [collectTab, setCollectTab] = useState<CollectTab>(() => {
    if (typeof window === "undefined") return "开始研究";
    const value = new URLSearchParams(window.location.search).get("tab");
    return value === "开始研究" || value === "导入材料" || value === "行业样本" || value === "选择客户" ? value === "选择客户" ? "行业样本" : value : "开始研究";
  });
  const [judgmentTab, setJudgmentTab] = useState<JudgmentTab>("逐条判断");
  /** 约束面板当前展开的分组。放在这里而不是面板内部：从别的视图跳过来时要能直接指定展开哪一组。 */
  const [openGroup, setOpenGroup] = useState("");
  const [weights, setWeights] = useState(initialWeights);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [people, setPeople] = useState<PersonNode[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  // 支持从报告等外部页面直接带参数打开：/?section=collect&tab=选择客户&q=某公司 FDE
  const [querySeed, setQuerySeed] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("q") || "";
  });
  const [querySeedNonce, setQuerySeedNonce] = useState(0);
  const [investigationSubject, setInvestigationSubject] = useState<InvestigationSubjectType>("company");
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
  const mainScroller = useRef<HTMLElement>(null);


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
  useEffect(() => {
    // 主导航切换的是完整工作面；回到顶部可以避免浏览器的滚动恢复把新面板的标题藏起来。
    mainScroller.current?.scrollTo({ top: 0 });
  }, [section]);

  const selected = signals.find(signal => signal.id === selectedId) || signals[0];
  const visibleSignals = useMemo(() => {
    const key = query.trim().toLowerCase();
    if (!key) return signals;
    return signals.filter(signal => `${signal.title} ${signal.evidence} ${signal.source} ${signal.topics.join(" ")} ${(signal.edges || []).map(edge => `${edge.from} ${edge.to}`).join(" ")}`.toLowerCase().includes(key));
  }, [signals, query]);

  /** 从任何地方跳到某条情报的判断页。第二个参数可直接展开某个待补分组。 */
  function openJudgment(id: string, where = "") {
    // 旧的“逐条判断”已从产品流程退出。保留选中项，方便未来在关系视图里
    // 展开来源，但不再把用户送进签字/过闸界面。
    setSelectedId(id); setSection("relations"); setOpenGroup(where);
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
    setSelectedId(signal.id); setDraft(emptyDraft()); setShowAdd(false);
    setSection("relations");
    setToast("已收下，正在让模型把范围和证伪草稿补上…");
    void autoEnrichCreated([signal]).then(ok => setToast(ok ? "模型已起草六项草稿，你只需要检查并签字" : "模型起草失败，字段仍可手动补"));
  }

  /**
   * 自动起草 / 口语修改。
   * 同一个端点两种模式：不给 instruction 就是完整起草；给了就按口语修改当前草稿。
   * 模型只能填草稿，signedOff 永远置回 false——最后一下必须由人签。
   */
  async function enrichSignal(signal: Signal, instruction = "") {
    const response = await fetch("/api/enrich", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        signal: {
          id: signal.id, title: signal.title, evidence: signal.evidence, source: signal.source,
          sourceUrl: signal.sourceUrl, origin: signal.origin, edges: signal.edges,
          constraints: signal.constraints,
        },
        instruction: instruction.trim(),
        mode: instruction.trim() ? "patch" : "propose",
      }),
    });
    const data = await response.json() as { constraints?: Partial<Constraints>; error?: string; detail?: string };
    if (!response.ok || !data.constraints) throw new Error(data.error || data.detail || "自动起草失败");
    const next = data.constraints;
    setSignals(items => items.map(item => item.id === signal.id ? {
      ...item,
      constraints: {
        ...item.constraints,
        ...next,
        scope: { ...item.constraints.scope, ...(next.scope || {}) },
        signedOff: false,
      },
    } : item));
    return next;
  }

  async function autoEnrichCreated(items: Signal[]) {
    let ok = 0;
    for (const item of items) {
      try { await enrichSignal(item); ok++; }
      catch { /* 单条失败不阻断其余条目 */ }
    }
    return ok;
  }

  async function patchSignal(signal: Signal, instruction: string) {
    try {
      await enrichSignal(signal, instruction);
      setToast("模型已按你的话改好草稿。检查一下，然后签字");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "口语修改失败");
      throw error;
    }
  }

  /**
   * 管线写入。以前这里把六道门全留空，结果实测 60 条真实情报 0 条过闸——
   * 卡点不是纪律，是门 5 要的 validUntil 全项目没有任何自动来源，
   * 人不手打日期就永远进不去。现在改成：机器把能从语料和 URL 算出来的都提议掉
   * （范围里的四项、来源类型、有效期），推不出来的仍然留空让门继续挡。
   *
   * 三条边界，不许放宽：
   * 1. signedOff 永远不预填。机器提议 ≠ 人已确认，门 6 只能由人过。
   * 2. 推不出来的字段留空，不填「未知」——门 2 现在把占位词与空值同等对待，
   *    填「未知」是假过闸，比空着有害。
   * 3. 沙盘推演（origin=simulation）不参与提议。它是假设产物，没有真实来源，
   *    给它编一个有效期就是把虚构包装成情报。它继续卡在门 5，符合预期。
   */
  function acceptCandidates(candidates: Candidate[]) {
    const created = candidates.map(candidate => {
      const isSimulation = candidate.origin === "simulation";
      const isPrivate = candidate.origin === "private";
      const proposed = isSimulation ? null : proposeConstraints({
        title: candidate.title, evidence: candidate.evidence, source: candidate.source,
        sourceUrl: candidate.sourceUrl, edges: candidate.edges,
        suggestedRelation: candidate.suggestedRelation, origin: candidate.origin,
      });
      return makeSignal({
        title: candidate.title, evidence: candidate.evidence, source: candidate.source, sourceUrl: candidate.sourceUrl,
        edges: candidate.edges.map(edge => ({ from: edge.from, to: edge.to, relation: edge.relation, direction: edge.direction })),
        origin: candidate.origin || "pipeline",
        constraints: {
          ...emptyConstraints(),
          ...(proposed?.constraints || {}),
          // 来源谱系仍然由这里定，提议器碰不到：机器只会看 URL 长什么样，
          // 而 independent 不只影响门 5，市场版图还按它筛可信来源——
          // 让管线自己标 independent 就是自我认证强来源。一律先隔离成 related，
          // 是不是独立第三方由人在面板上点（提议器只在旁边给一句提示）。
          ...(isPrivate
            ? { epistemicState: candidate.constraints?.epistemicState || "observation", sourceType: "internal" as const, humanSource: candidate.constraints?.humanSource || "" }
            : { epistemicState: "hypothesis" as const, sourceType: "related" as const }),
        },
      }, weights, TOPIC_RULES);
    });
    setSignals(items => [...created, ...items]);
    if (created[0]) setSelectedId(created[0].id);
    const simulated = created.filter(item => item.origin === "simulation").length;
    const enrichable = created.filter(item => item.origin !== "simulation").slice(0, 4);
    if (!enrichable.length) {
      setToast(`收下 ${created.length} 条推演结果。它们是假设，需要补真实来源`);
      return;
    }
    setToast(`收下 ${created.length} 条，正在让模型自动起草 ${enrichable.length} 条的范围、证伪与反例…`);
    void autoEnrichCreated(enrichable).then(ok => {
      setToast(simulated
        ? `已自动起草 ${ok} 条；另有 ${simulated} 条推演结果保持假设状态`
        : `已自动起草 ${ok} 条。现在只需要检查、口语修改、签字`);
    });
  }

  function recordFeedback(verdict: Verdict) {
    if (!selected) return;
    if (!gateState(selected).executable) { setToast("六项还没齐，这条结果不能拿来改评分"); return; }
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


  return <main className="console-app core-app field-app flat-nav">
    <a className="skip-link" href="#main-workspace">跳到主要内容</a>
    <header className="console-topbar">
      <button className="console-brand" onClick={() => setSection("desk")} aria-label="回到情报看台">
        <span>F</span><span className="brand-copy"><b>FIELD</b><small>EVIDENCE OS</small></span>
      </button>
      <nav className="section-nav">{SECTIONS.map((item, index) => <button key={item.id}
        className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}>
        <i>{String(index + 1).padStart(2, "0")}</i><span><b>{item.label}</b><small>{item.hint}</small></span>
      </button>)}</nav>
      <div className="console-search">
        <span>⌕</span>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜已收情报：公司名 / 原文 / 关系" aria-label="搜索已收情报" />
        {query && <button className="search-clear" onClick={() => setQuery("")} aria-label="清空搜索">×</button>}
      </div>
      <div className="console-actions">
        <button className="ghost-action model-action" onClick={() => setShowModel(true)}><i />模型连接{model.model ? " · 已配置" : ""}</button>
        <details className="console-more">
          <summary aria-label="更多操作">•••</summary>
          <div>
            <button onClick={() => importer.current?.click()}>导入工作区</button>
            <button onClick={exportData}>导出工作区</button>
            {/* 整页跳转而不是 router.push：票据是 httpOnly cookie，客户端路由不重新过 proxy。 */}
            <button onClick={async () => {
              await fetch("/api/login", { method: "DELETE" });
              window.location.assign("/login");
            }}>退出登录</button>
          </div>
        </details>
        <input ref={importer} className="file-input" type="file" accept="application/json" onChange={importData} />
      </div>
    </header>
    <section className="console-main wide" id="main-workspace" ref={mainScroller}>
      {section === "desk" && <IntelligenceDesk
        onStart={(subjectType, question = "") => {
          setInvestigationSubject(subjectType);
          setQuerySeed(question); setQuerySeedNonce(n => n + 1);
          setCollectTab("开始研究"); setSection("collect");
        }}
        onOpenPool={() => { setCollectTab("行业样本"); setSection("collect"); }}
        onOpenRelations={() => setSection("relations")}
      />}

      {section === "collect" && <>
        <TabBar tabs={["开始研究", "行业样本", "导入材料"] as CollectTab[]} active={collectTab} onPick={setCollectTab}
          note="行业、公司与人员共享一套来源账本，但各自建立独立档案。" />
        {collectTab === "开始研究" && <InvestigationWorkbench key={`seed-${investigationSubject}-${querySeedNonce}`} initialQuestion={querySeed} initialSubjectType={investigationSubject} onImportMaterial={() => setCollectTab("导入材料")} />}
        {collectTab === "导入材料" && <Intake onAccept={acceptCandidates} onManual={() => setShowAdd(true)} />}
        {collectTab === "行业样本" && <FdeQueryPack onPick={(presetQuery, name) => {
          setInvestigationSubject("company");
          setQuerySeed(presetQuery);
          setQuerySeedNonce(n => n + 1);
          setCollectTab("开始研究");
          setToast(`已从行业样本池选中「${name}」，现在开始建立公司档案`);
        }} />}
      </>}

      {section === "relations" && <>
        <InvestigationGraph onStartResearch={question => {
          setQuerySeed(question);
          setInvestigationSubject("company");
          setQuerySeedNonce(n => n + 1);
          setSection("collect");
          setCollectTab("开始研究");
        }} />
      </>}

      {section === "judgment" && <>
        <TabBar tabs={["逐条判断", "全部情报", "校准记录", "推演", "设置"] as JudgmentTab[]} active={judgmentTab} onPick={setJudgmentTab}
          note="这一段判单条够不够硬。和关系图互不影响——不上图也能判，上了图也不算判过。" />
        {judgmentTab === "逐条判断" && (selected
          ? <Workbench signal={selected} signals={signals} openGroup={openGroup} setOpenGroup={setOpenGroup}
              feedbackNote={feedbackNote} setFeedbackNote={setFeedbackNote}
              executionQuality={executionQuality} setExecutionQuality={setExecutionQuality}
              onFeedback={recordFeedback} onPick={id => openJudgment(id)}
              onAnalyze={runModelAnalysis} analyzing={analyzing} onAdopt={adoptModelAnalysis}
              onPatch={patchSignal} onConstraints={updateConstraints} />
          : <EmptyField ready={workspaceReady} onOpen={() => setSection("collect")} />)}
        {judgmentTab === "全部情报" && <>
          <Library signals={visibleSignals} selectedId={selectedId} onSelect={id => openJudgment(id)} />
          <EvidenceLedger signals={visibleSignals} onSelect={id => openJudgment(id)} />
        </>}
        {judgmentTab === "校准记录" && <Calibration feedback={feedback} signals={signals} weights={weights} snapshots={snapshots} onSnapshot={saveSnapshot} />}
        {judgmentTab === "推演" && <Sandbox onAccept={acceptCandidates} />}
        {judgmentTab === "设置" && <Rules weights={weights} setWeights={setWeights} normalize={normalizeWeights} onReset={() => { setWeights(initialWeights); setToast("权重已恢复为均衡初始值"); }} />}
      </>}
    </section>
    <footer className="console-status">
      <span><b>调查档案</b> 独立保存</span>
      <span><b>主张</b> 保留引用来源</span>
      <span><b>原文</b> 后台逐条复核</span>
      <span className="status-spacer">{workspaceStatus}</span>
    </footer>
    {showAdd && <EvidenceModal draft={draft} setDraft={setDraft} onClose={() => setShowAdd(false)} onSubmit={addSignal} />}
    {showModel && <ModelModal model={model} setModel={setModel} onClose={() => setShowModel(false)} />}
    {toast && <div className="toast">● {toast}</div>}
  </main>;
}

function TabBar<T extends string>({ tabs, active, onPick, note }: {
  tabs: T[]; active: T; onPick: (value: T) => void; note: string;
}) {
  return <div className="tab-bar">
    <div>{tabs.map(tab => <button key={tab} className={active === tab ? "active" : ""} onClick={() => onPick(tab)}>{tab}</button>)}</div>
    <small>{note}</small>
  </div>;
}

/**
 * 逐条判断。左边是待办队列（缺得最少的排前面——最快能推完的先推），右边是这一条。
 *
 * 刻意不显示的东西：
 *   候选度 —— 它是四维加权的"先看哪条"排序值，显示成 0–100 大分数会被当成可信度。
 *             现在只用它排序（见 queue），不给数字。
 *   四维 trace / 权重带 —— 关键词命中数，看了不能做任何决定，收到「设置」里。
 *   五步流程图 —— 流程已经是导航本身了，不用再画一遍。
 */
function Workbench({ signal, signals, feedbackNote, setFeedbackNote, executionQuality, setExecutionQuality, onFeedback, onPick, onAnalyze, analyzing, onAdopt, onPatch, onConstraints, openGroup, setOpenGroup }: {
  signal: Signal; signals: Signal[]; openGroup: string; setOpenGroup: (value: string) => void;
  feedbackNote: string; setFeedbackNote: (value: string) => void;
  executionQuality: number; setExecutionQuality: (value: number) => void; onFeedback: (value: Verdict) => void;
  onPick: (id: string) => void; onAnalyze: () => void; analyzing: boolean; onAdopt: () => void;
  onPatch: (signal: Signal, instruction: string) => Promise<void>; onConstraints: (value: Constraints) => void;
}) {
  const gate = gateState(signal);
  const [patchText, setPatchText] = useState("");
  const [patching, setPatching] = useState(false);
  // 缺得少的排前面：先把快要成的推完，而不是从最难的开始。
  const queue = [...signals].sort((a, b) => {
    const left = missingGates(a).length, right = missingGates(b).length;
    return left === right ? b.candidateScore - a.candidateScore : left - right;
  });

  async function submitPatch(instruction: string) {
    if (!instruction.trim() || patching) return;
    setPatching(true);
    try { await onPatch(signal, instruction); setPatchText(""); }
    catch { /* patchSignal 内部已 toast */ }
    finally { setPatching(false); }
  }

  return <div className="judge-layout">
    <aside className="judge-queue">
      <small>{signals.length} 条待判断 · 差得少的在前</small>
      {queue.map(item => {
        const left = missingGates(item).length;
        return <button key={item.id} className={item.id === signal.id ? "active" : ""} onClick={() => onPick(item.id)}>
          <b>{item.title || "未命名"}</b>
          <span className={left ? "" : "done"}>{left ? `还差 ${left} 项` : "✓ 六项已齐"}</span>
          <em>{item.source}</em>
        </button>;
      })}
    </aside>
    <div className="judge-main">
      <section className="evidence-card">
        <div className="card-kicker">原始材料{signal.origin === "pipeline" ? " · 机器抓的" : signal.origin === "simulation" ? " · 推演产物，不是真事" : signal.origin === "private" ? " · 自己打听的" : ""}</div>
        <h2>{signal.title}</h2><p>{signal.evidence}</p>
        <div className="evidence-meta"><span>{signal.source}</span>{signal.sourceUrl && <a href={signal.sourceUrl} target="_blank" rel="noreferrer">原始链接 ↗</a>}<time>{signal.createdAt}</time></div>
        {(signal.edges?.length ?? 0) > 0 && <div className="signal-edges">{signal.edges!.map((edge, index) => <span key={index}>{edge.from} {edge.direction === "mutual" ? "↔" : "→"} {edge.to}<small>{relationLabel(edge.relation)}</small></span>)}</div>}
      </section>
      <section className="voice-patch">
        <div className="voice-patch-copy">
          <b>让模型改参数</b>
          <small>说一句人话，剩下的大模型来改。例：「概率改成70，有效期到12月底」「反例补一条：没有中标公告」</small>
        </div>
        <div className="voice-patch-row">
          <input
            value={patchText}
            onChange={event => setPatchText(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter") void submitPatch(patchText); }}
            placeholder="口语说一句怎么改…"
            disabled={patching}
            aria-label="口语修改参数"
          />
          <button className="primary-action" disabled={patching || !patchText.trim()} onClick={() => void submitPatch(patchText)}>
            {patching ? "模型修改中…" : "按这句话改"}
          </button>
          {gate.passed < 5 && <button className="ghost-action" disabled={patching} onClick={() => void submitPatch("把还缺的几项都补上，推不出的就写查过哪里")}>补全缺失项</button>}
        </div>
      </section>
      <ConstraintPanel signal={signal} onChange={onConstraints} open={openGroup} setOpen={setOpenGroup} />
      <AIReview analysis={signal.aiAnalysis} onAnalyze={onAnalyze} analyzing={analyzing} onAdopt={onAdopt} />
      <section className={`feedback-deck field-feedback ${gate.executable ? "ready" : "locked"}`}>
        <div><h3>{gate.executable ? "后来实际发生了什么？" : "六项还没齐，先补完再回来记结果"}</h3>
          <p>执行没做到位的话（下面这条低于 60），结果只记下来，不改评分——判断错和执行差得分开算。</p></div>
        <label>这件事执行得怎么样 <b>{executionQuality}</b><input type="range" min="0" max="100" value={executionQuality} onChange={event => setExecutionQuality(Number(event.target.value))} /></label>
        <label>实际发生了什么<input value={feedbackNote} onChange={event => setFeedbackNote(event.target.value)} placeholder="写发生的事，不写你怎么解释它" /></label>
        <div className="verdict-actions">
          <button disabled={!gate.executable} className="confirm" onClick={() => onFeedback("confirmed")}>✓ 判断对了</button>
          <button disabled={!gate.executable} onClick={() => onFeedback("watching")}>○ 还看不出</button>
          <button disabled={!gate.executable} className="counter" onClick={() => onFeedback("counter")}>× 判断错了</button>
        </div>
      </section>
    </div>
  </div>;
}
