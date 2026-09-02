"use client";

import { useEffect, useMemo, useState } from "react";
import type { InvestigationSubjectType } from "../../lib/investigation/types";

type InvestigationListItem = {
  id: string; question: string; entity_name: string; subject_type?: InvestigationSubjectType;
  status: "researching" | "ready" | "partial" | "failed"; provider: string; updated_at: string;
};
type DeskStats = {
  claims: number; sources: number; verifiedSources: number; relations: number;
  bySubject: Record<InvestigationSubjectType, number>;
};
type DeskPayload = { investigations: InvestigationListItem[]; stats: DeskStats };
type WorkspacePayload = { signals?: unknown[]; people?: unknown[] };
type PresetsPayload = { total?: number };

const SUBJECTS: Array<{
  id: InvestigationSubjectType; number: string; label: string; sublabel: string; copy: string;
  prompt: string; action: string;
}> = [
  {
    id: "industry", number: "01", label: "行业", sublabel: "FDE / 交付模式", action: "研究一个行业",
    copy: "用行业定义观察范围：供需、交付模式、关键样本、技术迁移与尚未成立的判断。",
    prompt: "工业软件行业的 FDE 与 AI 交付正在怎样变化？",
  },
  {
    id: "company", number: "02", label: "公司", sublabel: "组织 / 产品 / 生态", action: "研究一家公司",
    copy: "把一家公司拆成当前动作、组织位置、产品部署、合作网络和可回溯来源。",
    prompt: "广联达最近在哪些环节推进 AI？",
  },
  {
    id: "person", number: "03", label: "人员", sublabel: "角色 / 任职 / 关联", action: "研究一个人",
    copy: "围绕公开角色、任职变化、职责边界和组织关系建立人员档案，不收集私人信息。",
    prompt: "某位行业负责人目前负责什么、和哪些业务有关？",
  },
];

function statusLabel(status: InvestigationListItem["status"]) {
  return status === "ready" ? "初稿已齐" : status === "researching" ? "研究中" : status === "partial" ? "部分完成" : "待重查";
}

function subjectLabel(subject: InvestigationSubjectType | undefined) {
  return subject === "industry" ? "行业" : subject === "person" ? "人员" : "公司";
}

export function IntelligenceDesk({ onStart, onOpenPool, onOpenRelations }: {
  onStart: (subjectType: InvestigationSubjectType, question?: string) => void;
  onOpenPool: () => void;
  onOpenRelations: () => void;
}) {
  const [data, setData] = useState<DeskPayload | null>(null);
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [seedTotal, setSeedTotal] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetch("/api/investigations").then(async response => {
        if (!response.ok) throw new Error("调查档案读取失败");
        return response.json() as Promise<DeskPayload>;
      }),
      fetch("/api/workspace").then(async response => response.ok ? response.json() as Promise<WorkspacePayload> : null),
      fetch("/api/query/presets?scope=all&limit=1").then(async response => response.ok ? response.json() as Promise<PresetsPayload> : null),
    ]).then(([desk, workspaceData, presetData]) => {
      if (!active) return;
      setData(desk); setWorkspace(workspaceData); setSeedTotal(presetData?.total || 0); setError("");
    }).catch(caught => {
      if (active) setError(caught instanceof Error ? caught.message : "情报看台读取失败");
    });
    return () => { active = false; };
  }, []);

  const stats = data?.stats || { claims: 0, sources: 0, verifiedSources: 0, relations: 0, bySubject: { industry: 0, company: 0, person: 0 } };
  const recent = useMemo(() => (data?.investigations || []).slice(0, 5), [data]);
  const manualSignals = workspace?.signals?.length || 0;
  const people = workspace?.people?.length || 0;
  const verificationRate = stats.sources ? Math.round(stats.verifiedSources / stats.sources * 100) : 0;

  return <section className="intelligence-desk">
    <header className="desk-hero">
      <div>
        <span className="desk-kicker">FIELD / INTELLIGENCE DESK</span>
        <h1>不是一份报告。<br /><em>是一座持续生长的情报看台。</em></h1>
        <p>行业定义观察范围，公司提供具体样本，人员解释真实的组织与行动。每次查询都是新一批可追溯材料，而不是一次性汇报。</p>
      </div>
      <aside className="desk-live-card">
        <span><i /> 情报库状态</span>
        <strong>{data ? "已连接" : "正在读取"}</strong>
        <p>{stats.verifiedSources ? `${stats.verifiedSources} 个原文已复核；引用会继续补全。` : "先建立第一份行业、公司或人员调查。"}</p>
        <button type="button" onClick={() => onStart("company")}>新建一份调查 <b>↗</b></button>
      </aside>
    </header>

    {error && <div className="query-error" role="alert">⚠ {error}</div>}

    <div className="desk-metrics" aria-label="情报库概览">
      <div><b>{seedTotal || "—"}</b><span>首批行业样本</span></div>
      <div><b>{stats.claims}</b><span>可读主张</span></div>
      <div><b>{stats.relations}</b><span>有依据的关系</span></div>
      <div><b>{verificationRate}%</b><span>引用原文已复核</span></div>
    </div>

    <section className="desk-subjects" aria-label="选择情报收集对象">
      <header><span>从哪一种对象开始</span><small>三类档案共享来源账本与关系网络，但各自使用不同的研究角度。</small></header>
      <div>{SUBJECTS.map(subject => {
        const count = subject.id === "person" ? Math.max(stats.bySubject.person, people) : stats.bySubject[subject.id];
        return <article key={subject.id} className={`desk-subject ${subject.id}`}>
          <div className="desk-subject-number">{subject.number}</div>
          <header><span>{subject.sublabel}</span><h2>{subject.label}</h2></header>
          <p>{subject.copy}</p>
          <footer><b>{count}</b><small>{subject.id === "industry" ? "份行业调查" : subject.id === "company" ? "份公司调查" : "份人员档案"}</small></footer>
          <button type="button" onClick={() => onStart(subject.id, subject.prompt)}>{subject.action} <span>→</span></button>
        </article>;
      })}</div>
    </section>

    <section className="desk-lower-grid">
      <article className="desk-stream">
        <header><div><span>RECENT COLLECTION</span><h2>最近进入看台的情报</h2></div><button type="button" onClick={() => onStart("company")}>开始收集 →</button></header>
        {recent.length > 0 ? <div>{recent.map(item => <button key={item.id} type="button" onClick={() => onStart(item.subject_type || "company", item.question)}>
          <span className={`desk-stream-status ${item.status}`} />
          <div><small>{subjectLabel(item.subject_type)} · {statusLabel(item.status)}</small><b>{item.entity_name}</b><p>{item.question}</p></div>
          <em>↗</em>
        </button>)}</div> : <div className="desk-empty"><b>还没有调查档案。</b><p>从一个行业、公司或人员线索开始；首次结果会作为情报库的第一批材料保留下来。</p></div>}
      </article>

      <article className="desk-relations-card">
        <span>RELATION FIELD</span>
        <h2>先看关系，<br />再回到证据。</h2>
        <p>图谱不是装饰。每一条线都应能回到一条主张和原始链接；没有依据，就不画线。</p>
        <div><b>{stats.relations}</b><small>条显式关系</small><b>{manualSignals}</b><small>条已存情报</small></div>
        <button type="button" onClick={onOpenRelations}>打开关系看台 <span>↗</span></button>
      </article>
    </section>

    <section className="desk-seed-note">
      <div><span>FIRST BATCH / 已保留的基础数据</span><h2>首批行业样本不再被封存在报告里。</h2><p>它们现在是行业观察的起点：可以筛选样本、发起公司调查、补人员档案，再让关系随来源逐步生长。</p></div>
      <button type="button" onClick={onOpenPool}>打开行业样本池 →</button>
    </section>
  </section>;
}
