"use client";

import { useState } from "react";
import { relationLabel } from "../../lib/ontology";
import { ViewHeader } from "./shared";
import type { Candidate } from "./intake";

/**
 * Phase 5 沙盘推演。
 *
 * 这个视图的存在意义是把"我猜的"和"我查到的"分开放：推演产出的每条候选
 * 都带 [推演] 前缀、origin=simulation，写入后仍是 0/6。
 * 它不能替代情报，只能告诉你该去找什么情报。
 */
export function Sandbox({ onAccept }: { onAccept: (candidates: Candidate[]) => void }) {
  const [scenario, setScenario] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState("");

  async function simulate() {
    if (scenario.trim().length < 15) { setError("场景描述太短，至少 15 字才推演得动"); return; }
    setRunning(true); setError(""); setCandidates([]); setPicked(new Set());
    try {
      const response = await fetch("/api/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario }) });
      const data = await response.json() as { candidates?: Candidate[]; notice?: string; error?: string; detail?: string };
      if (!response.ok) throw new Error(data.error || data.detail || "推演失败");
      if (!data.candidates?.length) { setError("场景太模糊，推不出可核查的信号。试着写清楚：谁、做什么、在什么市场。"); return; }
      setCandidates(data.candidates);
      setNotice(data.notice || "");
      setPicked(new Set());
    } catch (caught) { setError(caught instanceof Error ? caught.message : "推演失败"); }
    finally { setRunning(false); }
  }

  function toggle(index: number) {
    setPicked(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; });
  }

  function write() {
    onAccept(candidates.filter((_, index) => picked.has(index)));
    setCandidates([]); setPicked(new Set()); setScenario("");
  }

  return <>
    <ViewHeader kicker="第 3 步 / 下结论" title="推演只告诉你该去找什么" copy="写一个假设场景，它会列出「如果这事真的，应该能看到哪些迹象」。这是一份待查清单，不是情报——每一条进来都是六项全空的。" />
    <div className="sandbox-warn">
      <b>推演出来的不是事实</b>
      <span>每条都带 [推演] 前缀，六项全空。想让它变成能用的判断，只有一条路：去找到真实出处，再把六项补齐。这是代码写死的，不是一句提醒。</span>
    </div>
    <div className="intake-grid">
      <section className="intake-input">
        <small>先写场景</small>
        <label htmlFor="sandbox-scenario">写下一个假设场景
          <textarea id="sandbox-scenario" value={scenario} onChange={event => setScenario(event.target.value)} placeholder="例：某头部电池厂在 2026 下半年切入固态电池，并绑定一家整车厂做独家配套。&#10;写清楚：谁、做什么、在什么市场、什么时间窗口。" />
        </label>
        {error && <p className="intake-error" role="alert">● {error}</p>}
        <button className="primary-action" disabled={running} onClick={simulate}>{running ? "推演中…" : "推演应能观察到的信号"}</button>
        <p className="intake-note">推演出来的每条也是「谁—对谁—什么关系」，跟收集里挑出来的长得一样。唯一的区别：出处那一栏写的是「该去哪找、找什么」，而不是一段原文。</p>
      </section>
      <section className="intake-output">
        <small>该能看到的迹象</small>
        <h3>{candidates.length ? `${candidates.length} 条待验证信号` : "等待推演"}</h3>
        {notice && candidates.length > 0 && <p className="intake-note sandbox-notice">{notice}</p>}
        <div className="candidate-list">
          {candidates.map((candidate, index) => <article key={index} className={`sim ${picked.has(index) ? "picked" : ""}`}>
            <header>
              <input type="checkbox" id={`sim-${index}`} checked={picked.has(index)} onChange={() => toggle(index)} />
              <h4><label htmlFor={`sim-${index}`}>{candidate.title}</label></h4>
            </header>
            <p>{candidate.evidence}</p>
            <div className="candidate-edges">{candidate.edges.map((edge, edgeIndex) => <div key={edgeIndex}>
              <b>{edge.from}</b>{edge.direction === "mutual" ? "↔" : "→"}<b>{edge.to}</b><small>{relationLabel(edge.relation)}</small>
            </div>)}</div>
            {candidate.edges[0]?.quote && <blockquote className="sim-quote">待核查：{candidate.edges[0].quote}</blockquote>}
          </article>)}
          {!candidates.length && <div className="empty-log">推演结果会显示在这里。默认全部不勾选——要不要把假设放进情报库，是你的决定。</div>}
        </div>
        {candidates.length > 0 && <button className="primary-action" disabled={!picked.size} onClick={write}>写入 {picked.size} 条待验证假设（0/6，标记为推演）</button>}
      </section>
    </div>
  </>;
}
