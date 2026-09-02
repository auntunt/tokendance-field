"use client";

import { useRef, useState } from "react";
import type { Candidate } from "./intake";
import type { ResolverResult } from "../../lib/company-resolver";

/**
 * 主动查询入口。三步：输入 → 确认（纠错/消歧/维度）→ 结果。
 *
 * 为什么要中间那一步确认：
 * 「世纪互联」这个查询同时踩到两个坑——OPC 是 OCP 的字母顺序错，
 * 而「世纪互联」在工商登记里对应两个不同法人（世纪互联数据中心有限公司 /
 * 北京世纪互联宽带数据中心有限公司）。机器把这两件事默默替用户决定了，
 * 用户就不知道自己查的是哪个。所以纠错和消歧一律显式展示，用户点过才继续。
 *
 * 结果和 paste/url 模式出来的候选卡走同一条路（onAccept → acceptCandidates），
 * 不建第二套流程，不绕过六道门。
 */

type SearchTaskView = { query: string; kind: "anchor" | "salient" | "dimension" | "clue"; dimension: string };
type ResearchProvider = "xai" | "openai" | "anthropic" | "bing";

type ParsePhase = {
  phase: "parse";
  needsConfirmation: boolean;
  correction: { fragment: string; corrections: Array<{ original: string; corrected: string; note: string }>; changed: boolean };
  /** 规则从片段里抽出来的实体名（还没经名单确认） */
  extractedName: string;
  entityName: string;
  disambiguation: { query: string; kind: string; candidates: Array<{ id: string; name: string; legalName?: string; listing?: string; similarity: number; source: string }> };
  dimensions: Array<{ id: string; reason: string; confidence: string }>;
  /** 片段自己的关键词，会被带进搜索 */
  salient: string[];
  searchTasks: Array<SearchTaskView & { entityName: string }>;
  /** 模糊消歧结果：线索、候选、搜索词。 */
  resolver?: ResolverResult;
  searchQueries?: string[];
  /** 因为要避开搜索引擎限流，预计要等多久 */
  estimatedSeconds: number;
  provider?: ResearchProvider;
};

type FailedPage = { url: string; stage: "fetch" | "extract"; reason: string };
type SkippedResult = { url: string; title: string };

type ResultPhase = {
  phase: "results";
  entityName: string;
  fragment: string;
  dimensions: Array<{ id: string; reason: string; confidence: string }>;
  searchTasks: SearchTaskView[];
  /** 被判定为「引擎降级」整批丢掉的搜索词 */
  degradedQueries: string[];
  /** 抓到了但抽取失败的页面 */
  failedPages: FailedPage[];
  skippedResults: SkippedResult[];
  urlsFetched: number;
  candidates: Array<Candidate & {
    _grade?: string; _duplicate?: boolean; _duplicateNote?: string; _dimension?: string;
    _claimId?: string; _validation?: "single-source" | "corroborated" | "repeated-copy"; _sourceCount?: number;
  }>;
  gradeSummary: Record<string, number>;
  validationSummary?: Record<string, number>;
  researchMemo?: {
    summary: string;
    findings: Array<{ title: string; evidence: string; sourceUrl: string; sourceTitle: string; dimension: string; edges: Array<{ from: string; to: string }> }>;
    openQuestions: string[];
    sourceUrls: string[];
    provider: ResearchProvider;
  };
  brief?: {
    verdict: "corroborated" | "provisional" | "insufficient";
    headline: string;
    usable: Array<{ title: string; evidence: string; source: string; sourceUrl?: string }>;
    needsValidation: Array<{ title: string; evidence: string; source: string; sourceUrl?: string }>;
    repeatedCopies: number;
    evidenceGaps: string[];
    nextActions: string[];
  };
  provider?: ResearchProvider;
};

type StartedPhase = {
  phase: "started";
  jobId: string;
  entityName: string;
  fragment: string;
  dimensions: Array<{ id: string; reason: string; confidence: string }>;
  searchTasks: SearchTaskView[];
  estimatedSeconds: number;
  provider?: ResearchProvider;
};

type JobStatus = {
  id: string;
  status: "running" | "done" | "error";
  progressText: string;
  currentQuery: string;
  completedTasks: number;
  totalTasks: number;
  urlsFetched: number;
  elapsedSeconds: number;
  result?: ResultPhase;
  error?: string;
};

const TASK_KIND_LABEL: Record<string, string> = {
  anchor: "锚定", salient: "你问的那件事", dimension: "维度补齐", clue: "线索追踪",
};

const DIMENSION_LABEL: Record<string, string> = {
  shareholders: "股东结构", team: "团队", funding: "融资",
  business: "业务", fde: "FDE / 交付", background: "背景",
};

const GRADE_LABEL: Record<string, { short: string; tone: string }> = {
  statutory: { short: "法定", tone: "hard" },
  independent: { short: "三方", tone: "mid" },
  self: { short: "自述", tone: "soft" },
  unverified: { short: "未核", tone: "none" },
};

const CONFIDENCE_LABEL: Record<string, string> = { high: "强信号", medium: "弱信号", default: "默认" };
const PROVIDER_LABEL: Record<string, string> = { xai: "Grok 联网搜索", openai: "OpenAI 联网搜索", anthropic: "Claude 联网搜索", bing: "Bing 网页检索" };
const VALIDATION_LABEL: Record<string, { label: string; tone: string }> = {
  corroborated: { label: "多源印证", tone: "verified" },
  "repeated-copy": { label: "同稿转载", tone: "repeated" },
  "single-source": { label: "单一来源", tone: "single" },
};

const EXAMPLES = [
  { label: "世纪互联 OPC", text: "世纪互联最近启动了opc设计建设" },
  { label: "广联达 控股", text: "广联达控股 上市" },
  { label: "供应商更换", text: "听说A客户在换掉现在的电芯供应商" },
];

export function QueryIntake({ onAccept, onImportMaterial, initialFragment = "" }: {
  onAccept: (candidates: Candidate[]) => void;
  onImportMaterial: () => void;
  initialFragment?: string;
}) {
  const [fragment, setFragment] = useState(initialFragment);
  const [parsed, setParsed] = useState<ParsePhase | null>(null);
  const [results, setResults] = useState<ResultPhase | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [acceptCorrections, setAcceptCorrections] = useState(true);
  const [pickedEntity, setPickedEntity] = useState("");
  const [pickedDimensions, setPickedDimensions] = useState<Set<string>>(new Set());
  const [pickedCandidates, setPickedCandidates] = useState<Set<number>>(new Set());
  const [elapsed, setElapsed] = useState(0);
  const [progressText, setProgressText] = useState("");
  const [jobProgress, setJobProgress] = useState<JobStatus | null>(null);
  const [acceptedCount, setAcceptedCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  async function runParse() {
    if (fragment.trim().length < 2) { setError("查询词太短"); return; }
    setRunning(true); setError(""); setResults(null); setAcceptedCount(0); setProgressText("正在解析你的问题…"); setJobProgress(null);
    try {
      const resp = await fetch("/api/query", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ fragment: fragment.trim() }),
      });
      const data = await resp.json() as ParsePhase & { error?: string };
      if (!resp.ok) throw new Error(data.error || "解析失败");
      setParsed(data);
      setPickedEntity(data.entityName);
      setPickedDimensions(new Set(data.dimensions.map(d => d.id)));
      // 没有需要确认的东西就直接执行
      if (!data.needsConfirmation) {
        await runSearch(data.correction.fragment, data.entityName, data.dimensions.map(d => d.id), data.searchQueries || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "解析失败");
    } finally { setRunning(false); }
  }

  async function runSearch(frag: string, entityName: string, dimensions: string[], searchQueries: string[] = []) {
    setRunning(true); setError(""); setElapsed(0); setProgressText("正在创建查询任务…"); setJobProgress(null); setResults(null);
    const ticker = setInterval(() => setElapsed(s => s + 1), 1000);
    try {
      const resp = await fetch("/api/query", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ fragment: frag, confirmed: true, entityName, dimensions, searchQueries }),
      });
      const data = await resp.json() as (StartedPhase | ResultPhase) & { error?: string };
      if (!resp.ok) throw new Error(data.error || "查询失败");

      if (data.phase === "started") {
        await pollJob(data.jobId);
      } else {
        setResults(data);
        setPickedCandidates(new Set(data.candidates.map((_, i) => i).filter(i => !data.candidates[i]._duplicate)));
        window.dispatchEvent(new Event("field:research-updated"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "查询失败");
    } finally { clearInterval(ticker); setRunning(false); setProgressText(""); }
  }

  async function pollJob(jobId: string) {
    // 每 2.5 秒探一次。单次请求很快，不会被反向代理或浏览器超时杀掉。
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      const resp = await fetch(`/api/query/jobs?id=${encodeURIComponent(jobId)}`);
      const job = await resp.json() as JobStatus & { error?: string };
      if (!resp.ok) throw new Error(job.error || "查询任务读取失败");
      setJobProgress(job);
      setProgressText(job.progressText || "查询进行中…");
      if (job.status === "error") throw new Error(job.error || "查询失败");
      if (job.status === "done" && job.result) {
        setResults(job.result);
        setPickedCandidates(new Set(job.result.candidates.map((_, i) => i).filter(i => !job.result!.candidates[i]._duplicate)));
        window.dispatchEvent(new Event("field:research-updated"));
        return;
      }
    }
  }

  function confirmAndSearch() {
    if (!parsed) return;
    const frag = acceptCorrections ? parsed.correction.fragment : fragment.trim();
    void runSearch(frag, pickedEntity, [...pickedDimensions], parsed.searchQueries || []);
  }

  function acceptPicked() {
    if (!results) return;
    const chosen = [...pickedCandidates].map(i => results.candidates[i]).filter(Boolean);
    if (!chosen.length) return;
    // 把内部字段剥掉再交出去：acceptCandidates 的契约是 Candidate，
    // _grade / _dimension 是这一层的展示辅助，不进 Signal。
    onAccept(chosen.map(c => ({
      title: c.title, evidence: c.evidence, source: c.source, sourceUrl: c.sourceUrl,
      edges: c.edges || [], suggestedRelation: c.suggestedRelation, origin: "pipeline",
    })));
    setAcceptedCount(count => count + chosen.length);
    setPickedCandidates(new Set());
  }

  function toggleDimension(id: string) {
    setPickedDimensions(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleCandidate(index: number) {
    setPickedCandidates(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }

  function applyExample(text: string) {
    setFragment(text);
    setParsed(null); setResults(null); setError(""); setAcceptedCount(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function startOver() {
    setFragment("");
    setParsed(null); setResults(null); setError(""); setPickedCandidates(new Set()); setAcceptedCount(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function retryResults() {
    if (!results) return;
    void runSearch(
      results.fragment,
      results.entityName,
      results.dimensions.map(dimension => dimension.id),
      results.searchTasks.map(task => task.query),
    );
  }

  const showConfirm = Boolean(parsed && parsed.needsConfirmation && !results);
  const currentStep: 1 | 2 | 3 = results ? 3 : showConfirm || (running && parsed) ? 2 : 1;
  const nonDuplicateIndexes = (results?.candidates || []).map((candidate, index) => candidate._duplicate ? null : index).filter((index): index is number => index !== null);
  const allPicked = nonDuplicateIndexes.length > 0 && pickedCandidates.size === nonDuplicateIndexes.length;
  const hasSearchIssues = Boolean(results && (results.degradedQueries.length || results.failedPages.length || results.skippedResults?.length));
  const fetchFailures = results?.failedPages.filter(page => page.stage === "fetch") || [];
  const extractFailures = results?.failedPages.filter(page => page.stage === "extract") || [];
  const estimatedSeconds = parsed?.estimatedSeconds || 20;

  return <div className="query-intake">
    <section className="research-start">
      <span>开始研究</span>
      <h1>你想核实什么？</h1>
      <p>写下公司、人物或事件。系统会找原始来源、打开正文，再告诉你哪些能说、哪些还需要验证。</p>
    </section>
    <div className="query-workbench">
      <section className="query-stage">
        <QuerySteps step={currentStep} />

        <div className="query-box">
          <label>
            <span className="query-label">问题 / 线索</span>
            <input
              ref={inputRef}
              value={fragment}
              onChange={e => setFragment(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !running) void runParse(); }}
              placeholder="例如：广联达最近在哪些环节推进 AI？"
              disabled={running}
              autoFocus
            />
          </label>
          <button className="primary-action" onClick={() => void runParse()} disabled={running || fragment.trim().length < 2}>
            {running ? "处理中…" : "开始查"}
          </button>
        </div>
        <div className="query-underbox">
          <small className="query-hint">半句话、错别字、听来的线索都可以。下一步会让你确认主体和范围，不会直接把猜测当结论。</small>
          {!running && !results && !showConfirm && <div className="query-examples">
            <span>试一个：</span>
            {EXAMPLES.map(example => <button key={example.label} onClick={() => applyExample(example.text)}>{example.label}</button>)}
          </div>}
        </div>

        {error && <div className="query-error" role="alert">⚠ {error}</div>}

    {showConfirm && parsed && <section className="query-confirm">
      <h3>确认一下再搜</h3>

      {parsed.correction.changed && <div className="confirm-row">
        <b>术语纠错</b>
        <div className="confirm-body">
          {parsed.correction.corrections.map((c, i) => <div key={i} className="correction-item">
            <code>{c.original}</code> → <code>{c.corrected}</code>
            <em>{c.note}</em>
          </div>)}
          <label className="inline-check">
            <input type="checkbox" checked={acceptCorrections} onChange={e => setAcceptCorrections(e.target.checked)} />
            采用纠错后的写法
          </label>
        </div>
      </div>}

      {parsed.resolver && parsed.resolver.clues.filter(c => c.kind !== "name").length > 0 && <div className="confirm-row">
        <b>识别到的线索</b>
        <div className="confirm-body">
          <div className="resolver-clues">
            {parsed.resolver.clues.filter(c => c.kind !== "name").map((clue, i) => <span key={i} className={`clue-chip clue-${clue.kind}`}>{clue.label} · {clue.text}</span>)}
          </div>
          {parsed.resolver.llmUsed && parsed.resolver.llmNote && <small className="kind-note">模型判断：{parsed.resolver.llmNote}</small>}
        </div>
      </div>}

      <div className="confirm-row">
        <b>查哪个主体</b>
        <div className="confirm-body">
          {(parsed.resolver?.candidates?.length ?? 0) > 0
            ? parsed.resolver!.candidates.map(c => <label key={`${c.source}-${c.id}`} className="entity-pick">
                <input type="radio" name="entity" checked={pickedEntity === c.name} onChange={() => setPickedEntity(c.name)} />
                <span>
                  <b>{c.name}</b>
                  {c.legalName && c.legalName !== c.name && <em>{c.legalName}</em>}
                  <small>
                    置信 {(c.score * 100).toFixed(0)}% · {c.source === "llm" ? "模型猜测" : "本地台账"}
                    {c.city ? ` · ${c.city}` : ""}{c.listing ? ` · ${c.listing}` : ""}{c.watchlist ? " · 重点" : ""}
                  </small>
                  {c.reason && <em className="resolver-reason">{c.reason}</em>}
                </span>
              </label>)
            : parsed.disambiguation.candidates.length > 0
              ? parsed.disambiguation.candidates.map(c => <label key={c.id} className="entity-pick">
                  <input type="radio" name="entity" checked={pickedEntity === c.name} onChange={() => setPickedEntity(c.name)} />
                  <span>
                    <b>{c.name}</b>
                    {c.legalName && c.legalName !== c.name && <em>{c.legalName}</em>}
                    <small>相似度 {(c.similarity * 100).toFixed(0)}% · {c.source === "roster" ? "名单内" : "查过"}{c.listing ? ` · ${c.listing}` : ""}</small>
                  </span>
                </label>)
              : <p className="confirm-none">名单和历史里都没有相近主体。将按输入原文去搜。</p>}
          {/* 名单外的实体：抽出来的名字就是唯一线索，必须让用户能改。
              原来这里给的是「按原文搜」——把整句话当公司名去搜，什么都搜不到。

              只在抽出来的名字跟上面每个候选都不同时才显示。
              名字撞上了还并排列出来，用户看到的是两个一模一样的「世纪互联」，
              得靠副标题才能分辨——那不是选择，那是谜题。 */}
          {!(parsed.resolver?.candidates ?? parsed.disambiguation.candidates).some(c => c.name === parsed.extractedName) &&
            <label className="entity-pick">
              <input type="radio" name="entity" checked={pickedEntity === parsed.extractedName} onChange={() => setPickedEntity(parsed.extractedName)} />
              <span>
                <b>{parsed.extractedName}</b>
                <small>从你这句话里截出来的名字{((parsed.resolver?.candidates?.length ?? 0) || parsed.disambiguation.candidates.length) ? "（不在上面几个里）" : ""}</small>
              </span>
            </label>}
          <label className="entity-edit">
            <span>名字不对就直接改</span>
            <input value={pickedEntity} onChange={e => setPickedEntity(e.target.value)} placeholder="公司全称最准" />
          </label>
          <small className="kind-note">识别实体类型：{parsed.disambiguation.kind}</small>
        </div>
      </div>

      <div className="confirm-row">
        <b>查哪几个维度</b>
        <div className="confirm-body">
          <div className="dimension-picks">
            {parsed.dimensions.map(d => <label key={d.id} className={pickedDimensions.has(d.id) ? "dim-pick on" : "dim-pick"}>
              <input type="checkbox" checked={pickedDimensions.has(d.id)} onChange={() => toggleDimension(d.id)} />
              <b>{DIMENSION_LABEL[d.id] || d.id}</b>
              <small>{CONFIDENCE_LABEL[d.confidence] || d.confidence} · {d.reason}</small>
            </label>)}
          </div>
        </div>
      </div>

      {parsed.salient.length > 0 && <div className="confirm-row">
        <b>会带进搜索的关键词</b>
        <div className="confirm-body">
          <div className="salient-list">
            {parsed.salient.map(t => <code key={t}>{t}</code>)}
          </div>
          <small className="kind-note">
            维度提示词是通用的，这几个词才是你真正问的那件事——所以它们会单独搜一遍。
          </small>
        </div>
      </div>}

      <div className="confirm-actions">
        <button className="primary-action" onClick={confirmAndSearch} disabled={running || !pickedDimensions.size || !pickedEntity.trim()}>
          {running ? `搜索中… ${elapsed}s` : `开始查询（${pickedDimensions.size} 个维度）`}
        </button>
        <button className="ghost-action" onClick={() => { setParsed(null); setError(""); }}>取消</button>
        {/* 情报研究会等待模型阅读网页和形成带引用初稿；这不是即时关键词搜索。 */}
        <small className="wait-note">
          {parsed.provider === "bing"
            ? `预计 ${parsed.estimatedSeconds || 20} 秒起。网页回退通道会主动错开请求，避免搜索引擎静默返回无关结果。`
            : `${PROVIDER_LABEL[parsed.provider || ""] || "联网检索"}会先阅读来源、形成带引用初稿，再逐页抓取和抽取；首次初稿通常需要 1–3 分钟。`}
        </small>
      </div>
    </section>}

    {running && !results && <div className="query-progress" role="status">
      <div className="query-progress-head">
        <span>{jobProgress ? jobProgress.progressText : parsed ? `正在搜索… 已用 ${elapsed}s` : progressText || "正在解析你的问题…"}</span>
        {jobProgress && jobProgress.totalTasks > 0
          ? <b>{Math.min(99, Math.round(jobProgress.completedTasks / jobProgress.totalTasks * 100))}%</b>
          : parsed ? <b>{Math.min(99, Math.round(elapsed / Math.max(estimatedSeconds, 1) * 100))}%</b> : null}
      </div>
      <div className="query-progress-track"><i style={{ width: jobProgress && jobProgress.totalTasks > 0
        ? `${Math.min(99, Math.round(jobProgress.completedTasks / jobProgress.totalTasks * 100))}%`
        : parsed ? `${Math.min(99, Math.round(elapsed / Math.max(estimatedSeconds, 1) * 100))}%` : "8%" }} /></div>
      <small>
        {jobProgress
          ? `第 ${Math.min(jobProgress.completedTasks + 1, jobProgress.totalTasks)} / ${jobProgress.totalTasks} 组搜索词 · 已抓 ${jobProgress.urlsFetched} 个页面 · 已用 ${elapsed}s。任务在后台跑，页面关掉也不会被中断。`
          : parsed ? `${PROVIDER_LABEL[parsed.provider || ""] || "联网检索"} · 预计至少 ${estimatedSeconds}s。优先等待带引用初稿，页面随后会逐一经过安全抓取、去重与抽取。` : "规则解析通常几秒钟完成。"}
      </small>
    </div>}

    {results && <section className="query-results">
      <header className="results-head">
        <div>
          <h3>{results.entityName}</h3>
          <small>
            抓了 {results.urlsFetched} 个页面 · 出 {results.candidates.length} 条候选 ·
            维度 {results.dimensions.map(d => DIMENSION_LABEL[d.id] || d.id).join(" / ")}
            {results.provider && ` · ${PROVIDER_LABEL[results.provider]}`}
            {acceptedCount > 0 && ` · 本轮已收下 ${acceptedCount} 条`}
          </small>
        </div>
        <div className="results-actions">
          <div className="grade-summary">
            {(results.validationSummary?.corroborated || 0) > 0 && <span className="validation-chip verified">多源印证 {results.validationSummary?.corroborated}</span>}
            {(results.validationSummary?.repeatedCopy || 0) > 0 && <span className="validation-chip repeated">同稿转载 {results.validationSummary?.repeatedCopy}</span>}
            {Object.entries(results.gradeSummary).filter(([, n]) => n > 0).map(([grade, n]) =>
              <span key={grade} className={`grade-chip ${GRADE_LABEL[grade]?.tone || "none"}`}>
                {GRADE_LABEL[grade]?.short || grade} {n}
              </span>)}
          </div>
          <button className="ghost-action" onClick={startOver}>重新查</button>
        </div>
      </header>

      <details className="search-detail">
        <summary>用了这些搜索词（{results.searchTasks.length} 条）</summary>
        <ul>{results.searchTasks.map((t, i) => <li key={i}>
          <code>{t.query}</code>
          <em>{TASK_KIND_LABEL[t.kind] || t.kind}</em>
        </li>)}</ul>
      </details>

      {results.researchMemo && <section className="research-memo" aria-label="Grok 联网研究初稿">
        <header>
          <div><small>RESEARCH DRAFT · {PROVIDER_LABEL[results.researchMemo.provider]}</small><h4>这轮搜索先得到了什么</h4></div>
          <span>{results.researchMemo.sourceUrls.length} 个引用来源</span>
        </header>
        <p className="memo-summary">{results.researchMemo.summary}</p>
        <div className="memo-findings">
          {results.researchMemo.findings.map((finding, index) => <article key={`${finding.sourceUrl}-${index}`}>
            <b>{finding.title}</b>
            <p>{finding.evidence}</p>
            <a href={finding.sourceUrl} target="_blank" rel="noreferrer">{finding.sourceTitle || new URL(finding.sourceUrl).hostname} ↗</a>
          </article>)}
        </div>
        {results.researchMemo.openQuestions.length > 0 && <div className="memo-questions"><b>仍待确认</b>{results.researchMemo.openQuestions.map((question, index) => <span key={index}>{question}</span>)}</div>}
        <small className="memo-note">这是带来源的研究初稿；每条来源仍会进入账本，等待原文复核与第二来源印证。</small>
      </section>}

      {results.brief && <section className={`intelligence-brief ${results.brief.verdict}`} aria-label="本轮情报简报">
        <header>
          <div><small>INTELLIGENCE BRIEF</small><h4>{results.brief.headline}</h4></div>
          <span>{results.brief.verdict === "corroborated" ? "可暂用" : results.brief.verdict === "provisional" ? "待验证" : "证据不足"}</span>
        </header>
        <div className="brief-grid">
          <div>
            <b>现在能说什么</b>
            {results.brief.usable.length
              ? <ul>{results.brief.usable.map((item, index) => <li key={index}><strong>{item.title}</strong><span>{item.source}</span></li>)}</ul>
              : <p>没有。系统不会把单一来源或转载包装成已证实结论。</p>}
          </div>
          <div>
            <b>还缺什么</b>
            <ul>{results.brief.evidenceGaps.map((item, index) => <li key={index}>{item}</li>)}</ul>
          </div>
          <div>
            <b>下一步动作</b>
            <ol>{results.brief.nextActions.map((item, index) => <li key={index}>{item}</li>)}</ol>
          </div>
        </div>
      </section>}

      {!results.candidates.length && <section className="query-recovery" aria-label="下一步怎么做">
        <small>这次暂时没有拿到可用证据</small>
        <h4>{extractFailures.length
          ? `${extractFailures.length} 个页面已抓到，但关系抽取没有完成。`
          : fetchFailures.length
            ? `${fetchFailures.length} 个候选页面没有成功打开。`
            : "搜索结果不足以支持这个判断。"}</h4>
        <p>这不是结论被否定，而是还没有足够可核验的原始材料。你可以直接重试、换一种说法，或提供一个你确认有内容的链接。</p>
        <div>
          <button type="button" className="primary-action" disabled={running} onClick={retryResults}>再试一次</button>
          <button type="button" className="ghost-action" onClick={startOver}>换个说法</button>
          <button type="button" className="ghost-action" onClick={onImportMaterial}>粘贴链接</button>
        </div>
      </section>}

      {hasSearchIssues && <details className="search-issues">
        <summary>查看本次检索详情</summary>
        {results.degradedQueries.length > 0 && <p>有 {results.degradedQueries.length} 条搜索词的结果与「{results.entityName}」无关，已排除。</p>}
        {fetchFailures.length > 0 && <p>有 {fetchFailures.length} 个页面无法抓取；它们没有写入证据库。</p>}
        {extractFailures.length > 0 && <p>有 {extractFailures.length} 个页面已抓取但抽取失败；正文已留存，可在服务恢复后重试。</p>}
        {results.failedPages.length > 0 && <ul>{results.failedPages.map((page, index) => <li key={index}><code>{page.url}</code><span>{page.stage === "fetch" ? "抓取失败" : "抽取失败"} · {page.reason}</span></li>)}</ul>}
        {results.skippedResults?.length > 0 && <p>另有 {results.skippedResults.length} 条结果在抓取前被判定为与主体无关。</p>}
      </details>}

      {results.candidates.length > 0 && <>
        <div className="results-toolbar">
          <button className="ghost-action" onClick={() => setPickedCandidates(allPicked ? new Set() : new Set(nonDuplicateIndexes))}>
            {allPicked ? "清空选择" : "全选非重复"}
          </button>
          <span>已选 {pickedCandidates.size} / {nonDuplicateIndexes.length} 条可收</span>
          <small>重复材料默认不选。分级只说明来源，不代表已核实。</small>
        </div>
        <div className="candidate-list">
          {results.candidates.map((c, i) => <label key={i} className={pickedCandidates.has(i) ? "candidate-card on" : "candidate-card"}>
            <input type="checkbox" checked={pickedCandidates.has(i)} onChange={() => toggleCandidate(i)} />
            <div className="candidate-body">
              <div className="candidate-head">
                <b>{c.title || "未命名"}</b>
                {c._grade && <span className={`grade-chip ${GRADE_LABEL[c._grade]?.tone || "none"}`}>
                  {GRADE_LABEL[c._grade]?.short || c._grade}
                </span>}
                {c._dimension && <em className="dim-tag">{DIMENSION_LABEL[c._dimension] || c._dimension}</em>}
                {c._validation && <em className={`validation-chip ${VALIDATION_LABEL[c._validation]?.tone || "single"}`}>
                  {VALIDATION_LABEL[c._validation]?.label || c._validation}{(c._sourceCount || 0) > 1 ? ` · ${c._sourceCount} 源` : ""}
                </em>}
                {c._duplicate && <em className="dup-tag">重复</em>}
              </div>
              <p>{c.evidence}</p>
              <div className="candidate-meta">
                <span>{c.source}</span>
                {c.sourceUrl && <a href={c.sourceUrl} target="_blank" rel="noreferrer">原文 ↗</a>}
              </div>
              {c._duplicate && c._duplicateNote && <small className="dup-note">{c._duplicateNote}</small>}
              {(c.edges?.length ?? 0) > 0 && <div className="candidate-edges">
                {c.edges.map((edge, j) => <span key={j}>{edge.from} → {edge.to}</span>)}
              </div>}
            </div>
          </label>)}
        </div>
        {/* 全是重复时按钮是灰的，得说清为什么——
            否则用户看到「收下选中的 0 条」会以为是界面坏了。 */}
        {results.candidates.every(c => c._duplicate) && <p className="confirm-none">
          这一轮抽到的每一条都和已收过的材料逐字一致，所以默认都没勾上。
          真想再收一份就手动勾——重复本身也是个信号：这个主体近期没有新的公开材料。
        </p>}

        <div className="confirm-actions">
          <button className="primary-action" onClick={acceptPicked} disabled={!pickedCandidates.size}>
            收下选中的 {pickedCandidates.size} 条
          </button>
          <small>收下之后它们和别的入口一样，一律 hypothesis + related，六道门全空——分级只说明来源，不代表已核实。</small>
        </div>
      </>}
    </section>}
      </section>

    </div>
  </div>;
}

function QuerySteps({ step }: { step: 1 | 2 | 3 }) {
  const steps = [
    { id: 1 as const, label: "输入" },
    { id: 2 as const, label: "确认" },
    { id: 3 as const, label: "结果" },
  ];
  return <ol className="query-steps">
    {steps.map((item, index) => <li key={item.id} className={step === item.id ? "active" : step > item.id ? "done" : ""}>
      <b>{step > item.id ? "✓" : item.id}</b>
      <span>{item.label}</span>
      {index < steps.length - 1 && <i />}
    </li>)}
  </ol>;
}
