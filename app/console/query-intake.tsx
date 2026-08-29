"use client";

import { useEffect, useRef, useState } from "react";
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

type FailedPage = { url: string; reason: string };
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

type QueryLogRow = { id: string; fragment: string; entity_name: string; dimensions: string; searched_at: string; candidates_count: number };

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

export function QueryIntake({ onAccept, initialFragment = "" }: { onAccept: (candidates: Candidate[]) => void; initialFragment?: string }) {
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
  const [history, setHistory] = useState<QueryLogRow[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [acceptedCount, setAcceptedCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void fetch("/api/query").then(async response => {
      const data = await response.json() as { logs?: QueryLogRow[] };
      if (response.ok) {
        const seen = new Set<string>();
        setHistory((data.logs || []).filter(row => {
          const key = row.fragment.trim().toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, 8));
      }
      setHistoryLoaded(true);
    }).catch(() => setHistoryLoaded(true));
  }, []);

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

  const showConfirm = Boolean(parsed && parsed.needsConfirmation && !results);
  const currentStep: 1 | 2 | 3 = results ? 3 : showConfirm || (running && parsed) ? 2 : 1;
  const nonDuplicateIndexes = (results?.candidates || []).map((candidate, index) => candidate._duplicate ? null : index).filter((index): index is number => index !== null);
  const allPicked = nonDuplicateIndexes.length > 0 && pickedCandidates.size === nonDuplicateIndexes.length;
  const estimatedSeconds = parsed?.estimatedSeconds || 20;

  return <div className="query-intake">
    <div className="query-workbench">
      <section className="query-stage">
        <QuerySteps step={currentStep} />

        <div className="query-box">
          <label>
            <span className="query-label">用一句人话描述你想查的事</span>
            <input
              ref={inputRef}
              value={fragment}
              onChange={e => setFragment(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !running) void runParse(); }}
              placeholder="模糊也行：世纪互联最近启动了opc设计建设 / 广联达控股 上市"
              disabled={running}
              autoFocus
            />
          </label>
          <button className="primary-action" onClick={() => void runParse()} disabled={running || fragment.trim().length < 2}>
            {running ? "处理中…" : "开始查"}
          </button>
        </div>
        <div className="query-underbox">
          <small className="query-hint">片段、错别字、听来的半句话都可以。系统会先纠错、消歧、路由到维度，让你确认后再去搜。</small>
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
        {/* 慢是故意的：连续快速请求会让搜索引擎静默降级成无关结果。
            不说清楚的话，等 100 秒会被当成卡死。 */}
        <small className="wait-note">
          {parsed.provider === "bing"
            ? `预计 ${parsed.estimatedSeconds || 20} 秒起。网页回退通道会主动错开请求，避免搜索引擎静默返回无关结果。`
            : `${PROVIDER_LABEL[parsed.provider || ""] || "联网检索"}会先给出来源，再逐页抓取和抽取；耗时取决于原网页与抽取模型。`}
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
          : parsed ? `${PROVIDER_LABEL[parsed.provider || ""] || "联网检索"} · 预计至少 ${estimatedSeconds}s。页面会逐一经过安全抓取、去重与抽取。` : "规则解析通常几秒钟完成。"}
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

      {results.degradedQueries.length > 0 && <div className="degraded-note">
        <b>有 {results.degradedQueries.length} 条搜索词被整批丢掉了</b>
        <ul>{results.degradedQueries.map((q, i) => <li key={i}><code>{q}</code></li>)}</ul>
        <small>
          搜索引擎对这几条返回的结果里根本没有「{results.entityName}」——这是它被限流后的降级行为
          （只按查询里第一个词出结果）。这种结果留着比丢掉更糟：抽取器会把它当正经语料。
          隔几分钟单独重查这几个维度通常就好了。
        </small>
      </div>}

      {results.failedPages.length > 0 && <div className="degraded-note">
        <b>有 {results.failedPages.length} 个页面抓到了但没抽出来</b>
        <ul>{results.failedPages.map((p, i) => <li key={i}>
          <code>{p.url}</code> <em>{p.reason}</em>
        </li>)}</ul>
        <small>
          页面本身拿到了，是抽取这一步失败的（多半是模型网关超时）。
          这几页没进证据库，也没算进候选——重查一次通常就好了。
        </small>
      </div>}

      {results.skippedResults?.length > 0 && <div className="degraded-note">
        <b>有 {results.skippedResults.length} 条结果判定跟这家主体无关，没有抓取</b>
        <ul>{results.skippedResults.map((s, i) => <li key={i}>
          <em>{s.title || "无标题"}</em> <code>{s.url}</code>
        </li>)}</ul>
        <small>
          搜索引擎被限流时会只按查询里的第一个词出结果（搜「世纪互联」返回世纪佳缘）。
          标题和摘要里都不含主体名的，在抓取前就筛掉了——省一次抓取，也免得脏语料进证据库。
          要是这里出现了你认为相关的页面，说明这条规则误杀了，改一下确认面板里的主体名再试。
        </small>
      </div>}

      {!results.candidates.length && <p className="confirm-none">
        这一轮什么都没抽到。可能是搜索结果都是动态渲染页面（很多国内站点对非浏览器直接返 403），
        或者这个主体在公开文本里确实没有这些维度的材料。
        换个说法再试，或者用「贴材料」直接贴一个你知道有内容的 URL。
      </p>}

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

      <aside className="query-aside">
        <section className="aside-card query-guide">
          <small className="aside-kicker">怎么用</small>
          <h3>把模糊的线索交给系统</h3>
          <ol>
            <li><b>写一句人话</b><span>不用给关键词，半句话、错别字都可以。</span></li>
            <li><b>确认主体和维度</b><span>纠错与消歧结果必须由你点头才继续。</span></li>
            <li><b>收下可信候选</b><span>来源分级只说明出处，六道门仍要逐条过。</span></li>
          </ol>
          <p className="query-guide-note">来源不是答案。系统会打开原链接、保存正文指纹，并把“独立原文”和“同稿转载”分开计算。</p>
        </section>

        <section className="aside-card query-history">
          <small className="aside-kicker">最近查过</small>
          {!historyLoaded && <p className="history-empty">正在读取…</p>}
          {historyLoaded && history.length === 0 && <p className="history-empty">还没有查询记录。查过的公司和维度会留在这里。</p>}
          {history.length > 0 && <div className="history-list">
            {history.map(item => <button key={item.id} onClick={() => applyExample(item.fragment)} title={item.fragment}>
              <b>{item.fragment}</b>
              <span>{item.entity_name || "未识别主体"} · {item.searched_at.slice(0, 10)} · {item.candidates_count} 条</span>
            </button>)}
          </div>}
        </section>
      </aside>
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
