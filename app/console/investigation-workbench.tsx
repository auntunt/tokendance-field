"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { InvestigationDossier, InvestigationPass, InvestigationSource, InvestigationSubjectType } from "../../lib/investigation/types";

type InvestigationListItem = Pick<InvestigationDossier, "id" | "question" | "entityName" | "subjectType" | "status" | "updatedAt" | "provider">;

const PASS_STATUS: Record<InvestigationPass["status"], string> = {
  queued: "等待开始",
  researching: "正在联网研究",
  ready: "已有初稿",
  failed: "本轮未完成",
};
const SOURCE_STATUS: Record<InvestigationSource["checkStatus"], string> = {
  cited: "等待原文复核",
  fetching: "正在获取原文",
  verified: "原文已获取",
  failed: "原文未获取",
};

const SUBJECT_META: Record<InvestigationSubjectType, { label: string; eyebrow: string; placeholder: string; examples: string[] }> = {
  industry: {
    label: "行业", eyebrow: "INDUSTRY / FDE", placeholder: "例如：工业软件行业的 FDE 与 AI 交付正在怎样变化？",
    examples: ["工业软件行业的 FDE 与 AI 交付正在怎样变化？", "企业级 AI 在金融行业的落地和交付模式是什么？", "数据中心行业最近有哪些结构性变化？"],
  },
  company: {
    label: "公司", eyebrow: "COMPANY / ORGANIZATION", placeholder: "例如：广联达最近在哪些环节推进 AI？",
    examples: ["广联达最近在哪些环节推进 AI？", "世纪互联的数据中心业务最近有什么变化？", "北京人力 FESCO 的组织和业务重点是什么？"],
  },
  person: {
    label: "人员", eyebrow: "PERSON / ROLE", placeholder: "例如：某位负责人目前负责什么、和哪些业务有关？",
    examples: ["卞孟春目前负责哪些工业软件相关工作？", "某位行业负责人最近的任职和公开动作是什么？", "某家公司负责 AI 交付的关键人是谁？"],
  },
};

function statusCopy(status: InvestigationDossier["status"]) {
  if (status === "researching") return "研究员正依次从多个角度联网检索；每个角度会给足时间阅读来源，最先完成的段落会立即出现。";
  if (status === "ready") return "初稿已齐，引用原文仍会在后台逐条复核。";
  if (status === "partial") return "部分研究角度没有完成；已完成的初稿和来源仍然保留。";
  return "本轮未形成可用初稿。可以换一种说法或补一个明确的主体再试。";
}

function providerLabel(provider: InvestigationDossier["provider"]) {
  return provider === "xai" ? "Grok 联网研究" : provider === "openai" ? "OpenAI 联网研究" : provider === "anthropic" ? "Claude 联网研究" : "网页检索";
}

function investigationError(error: unknown) {
  return error instanceof Error ? error.message : "暂时无法读取调查档案";
}

function claimEvidenceLabel(claim: InvestigationDossier["claims"][number]) {
  if (claim.sourceCheckSummary.verified >= 2) return { label: "多源原文已获取", tone: "supported" };
  if (claim.sourceCheckSummary.verified === 1) return { label: "单源原文已获取", tone: "verified" };
  if (claim.sourceCheckSummary.failed > 0) return { label: "原文未获取", tone: "contested" };
  return { label: "联网初稿", tone: "lead" };
}

export function InvestigationWorkbench({ initialQuestion = "", initialSubjectType = "company", onImportMaterial }: { initialQuestion?: string; initialSubjectType?: InvestigationSubjectType; onImportMaterial: () => void }) {
  const [question, setQuestion] = useState(initialQuestion);
  const [subjectType, setSubjectType] = useState<InvestigationSubjectType>(initialSubjectType);
  const [dossier, setDossier] = useState<InvestigationDossier | null>(null);
  const [recent, setRecent] = useState<InvestigationListItem[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [selectedPass, setSelectedPass] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const loadDossier = async (id: string) => {
    const response = await fetch(`/api/investigations?id=${encodeURIComponent(id)}`);
    const data = await response.json() as { investigation?: InvestigationDossier; error?: string };
    if (!response.ok || !data.investigation) throw new Error(data.error || "调查档案读取失败");
    setDossier(data.investigation);
    setSelectedPass(current => current || data.investigation!.passes[0]?.id || "");
    return data.investigation;
  };

  const loadRecent = async () => {
    const response = await fetch("/api/investigations");
    const data = await response.json() as { investigations?: InvestigationListItem[] };
    if (response.ok) setRecent(data.investigations || []);
  };

  useEffect(() => {
    let active = true;
    void fetch("/api/investigations").then(async response => {
      const data = await response.json() as { investigations?: InvestigationListItem[] };
      if (active && response.ok) setRecent(data.investigations || []);
    }).catch(() => { /* Recent dossiers are convenience, not a blocker for new research. */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const investigationId = dossier?.status === "researching" ? dossier.id : "";
    if (!investigationId) return;
    const timer = window.setInterval(() => {
      void loadDossier(investigationId).catch(error => setError(investigationError(error)));
    }, 2200);
    return () => window.clearInterval(timer);
  }, [dossier?.id, dossier?.status]);

  async function start() {
    const trimmed = question.replace(/\s+/g, " ").trim();
    if (trimmed.length < 2) { setError("请写下一个公司、人物、项目或你听到的线索。"); return; }
    setStarting(true); setError(""); setDossier(null); setSelectedPass("");
    try {
      const response = await fetch("/api/investigations", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: trimmed, subjectType }),
      });
      const data = await response.json() as { id?: string; error?: string };
      if (!response.ok || !data.id) throw new Error(data.error || "无法创建调查档案");
      await loadDossier(data.id);
      await loadRecent();
    } catch (caught) {
      setError(investigationError(caught));
    } finally { setStarting(false); }
  }

  function openRecent(id: string) {
    setError("");
    void loadDossier(id).catch(error => setError(investigationError(error)));
  }

  function reset() {
    setDossier(null); setError(""); setSelectedPass("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  const selected = dossier?.passes.find(pass => pass.id === selectedPass) || dossier?.passes[0];
  const claims = useMemo(() => dossier?.claims.filter(claim => !selected || claim.passId === selected.id) || [], [dossier, selected]);
  const sourceMap = useMemo(() => new Map((dossier?.sources || []).map(source => [source.id, source])), [dossier?.sources]);
  const verified = dossier?.sources.filter(source => source.checkStatus === "verified").length || 0;
  const failed = dossier?.sources.filter(source => source.checkStatus === "failed").length || 0;
  const readyPasses = dossier?.passes.filter(pass => pass.status === "ready").length || 0;

  return <div className="investigation-workbench">
    <section className="investigation-hero">
      <div>
        <span className="investigation-kicker">{SUBJECT_META[subjectType].eyebrow} → INVESTIGATION DOSSIER</span>
        <h1>从一句模糊线索，<br /><span>开始一份可追溯的{SUBJECT_META[subjectType].label}调查。</span></h1>
        <p>系统会从多个角度联网研究，先给你可阅读的初稿；每一个引用再单独打开、保存和标记复核状态。没有“收下候选”或“签字”这一步。</p>
      </div>
      <aside>
        <small>这次会发生什么</small>
        <ol>
          <li><b>01</b><span>识别调查主体与问题</span></li>
            <li><b>02</b><span>依次研究时间、动作、组织、生态与反证</span></li>
          <li><b>03</b><span>把主张、关系和引用归入同一份档案</span></li>
          <li><b>04</b><span>后台复核每个可打开的原始页面</span></li>
        </ol>
      </aside>
    </section>

    {!dossier && <section className="investigation-start-card">
      <div className="subject-type-picker" role="group" aria-label="选择情报收集对象">
        {(Object.keys(SUBJECT_META) as InvestigationSubjectType[]).map(type => <button key={type} type="button" className={subjectType === type ? "active" : ""} onClick={() => setSubjectType(type)}>
          <b>{SUBJECT_META[type].label}</b><span>{type === "industry" ? "FDE / 行业" : type === "company" ? "主体 / 公司" : "关键人 / 角色"}</span>
        </button>)}
      </div>
      <label htmlFor="investigation-question">你想搞清楚什么？</label>
      <div className="investigation-query-row">
        <input id="investigation-question" ref={inputRef} value={question} autoFocus disabled={starting}
          onChange={event => setQuestion(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter" && !starting) void start(); }}
          placeholder={SUBJECT_META[subjectType].placeholder} />
        <button className="primary-action" disabled={starting} onClick={() => void start()}>{starting ? "正在创建档案…" : "开始调查"}</button>
      </div>
      <p>公司简称、错别字、半句话和听来的线索都可以。若主体不清楚，先把你知道的时间、场景或关联人也写进去。</p>
      <div className="investigation-examples">
        {SUBJECT_META[subjectType].examples.map(example => <button key={example} onClick={() => { setQuestion(example); inputRef.current?.focus(); }}>{example}</button>)}
      </div>
      {error && <div className="query-error" role="alert">⚠ {error}</div>}
    </section>}

    {!dossier && recent.length > 0 && <section className="investigation-recent">
      <header><span>最近的调查档案</span><small>查询不会消失；后续同类问题可以回到同一份档案。</small></header>
      <div>{recent.map(item => <button key={item.id} onClick={() => openRecent(item.id)}>
        <b>{item.entityName}</b><span>{item.question}</span><em>{item.status === "ready" ? "初稿已齐" : item.status === "researching" ? "研究中" : "部分完成"}</em>
      </button>)}</div>
    </section>}

    {dossier && <section className="investigation-dossier" aria-live="polite">
      <header className="dossier-header">
        <div><span>调查档案 · {providerLabel(dossier.provider)}</span><h2>{dossier.entityName}</h2><p>{dossier.question}</p></div>
        <div className={`dossier-status ${dossier.status}`}><b>{dossier.status === "researching" ? "联网研究中" : dossier.status === "ready" ? "初稿已齐" : dossier.status === "partial" ? "部分完成" : "未完成"}</b><span>{statusCopy(dossier.status)}</span></div>
        <button className="ghost-action" onClick={reset}>开始另一项调查</button>
      </header>

      <div className="dossier-metrics">
        <div><b>{readyPasses}/{dossier.passes.length}</b><span>研究角度已完成</span></div>
        <div><b>{dossier.claims.length}</b><span>可读主张</span></div>
        <div><b>{verified}/{dossier.sources.length}</b><span>引用原文已获取</span></div>
        <div className={failed ? "warning" : ""}><b>{failed}</b><span>原文未获取</span></div>
      </div>

      <div className="dossier-layout">
        <aside className="dossier-pass-list">
          <small>研究角度</small>
          {dossier.passes.map(pass => <button key={pass.id} className={selected?.id === pass.id ? "active" : ""} onClick={() => setSelectedPass(pass.id)}>
            <b>{pass.title}</b><span>{pass.description}</span><em className={pass.status}>{PASS_STATUS[pass.status]}</em>
          </button>)}
        </aside>

        <main className="dossier-reading">
          {selected && <>
            <header><span>{selected.title}</span><em className={selected.status}>{PASS_STATUS[selected.status]}</em></header>
            {selected.status === "researching" && <div className="dossier-pending"><i />正在使用这个角度联网检索、交叉阅读和整理引用。情报研究会给来源足够等待时间，不按实时搜索截断…</div>}
            {selected.status === "queued" && <div className="dossier-pending">这一角度排在研究队列中。</div>}
            {selected.status === "failed" && <div className="dossier-warning">这一轮没有完成：{selected.error || "没有可引用初稿"}</div>}
            {selected.summary && <div className="dossier-summary"><small>本轮初稿</small><p>{selected.summary}</p></div>}
            {claims.length > 0 && <div className="dossier-claims">
              {claims.map(claim => { const evidenceLabel = claimEvidenceLabel(claim); return <article key={claim.id}>
                <header><span>{claim.dimension}</span><em className={evidenceLabel.tone}>{evidenceLabel.label}</em></header>
                <h3>{claim.title}</h3><p>{claim.evidence}</p>
                {claim.relations.length > 0 && <div className="claim-relations">{claim.relations.map((relation, index) => <span key={index}><b>{relation.from}</b>{relation.direction === "mutual" ? " ↔ " : " → "}<b>{relation.to}</b><em>{relation.relation}</em></span>)}</div>}
                <div className="claim-sources">{claim.sourceIds.map(id => {
                  const source = sourceMap.get(id); if (!source) return null;
                  return <a key={source.id} href={source.url} target="_blank" rel="noreferrer"><i className={source.checkStatus} />{source.domain} · {SOURCE_STATUS[source.checkStatus]}</a>;
                })}</div>
              </article>; })}
            </div>}
            {selected.openQuestions.length > 0 && <div className="dossier-open-questions"><small>还需要追问</small>{selected.openQuestions.map(question => <p key={question}>? {question}</p>)}</div>}
          </>}
        </main>

        <aside className="dossier-source-ledger">
          <header><span>来源账本</span><small>引用和原文是两件事</small></header>
          <p>“联网初稿”只说明模型给出了链接；只有成功取得正文才标为“原文已获取”。</p>
          <div>{dossier.sources.slice(0, 9).map(source => <a key={source.id} href={source.url} target="_blank" rel="noreferrer"><i className={source.checkStatus} /><span><b>{source.title || source.domain}</b><em>{source.domain} · {SOURCE_STATUS[source.checkStatus]}</em></span></a>)}</div>
          {dossier.sources.length > 9 && <small>还有 {dossier.sources.length - 9} 个引用保存在档案中。</small>}
          <button className="material-link" onClick={onImportMaterial}>我有原文材料，直接导入 →</button>
        </aside>
      </div>
      {error && <div className="query-error" role="alert">⚠ {error}</div>}
    </section>}
  </div>;
}
