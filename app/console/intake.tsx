"use client";

import { useEffect, useState } from "react";
import { Constraints, Signal, gateState } from "../../lib/field-core";
import { relationLabel } from "../../lib/ontology";
import { ViewHeader } from "./shared";

export type CandidateEdge = { from: string; to: string; relation: string; direction: "forward" | "mutual"; quote: string };
/** constraints 只给私有情报录入用：它需要把来源谱系钉成 internal，其余一律走隔离默认值。 */
export type Candidate = { title: string; evidence: string; source: string; sourceUrl?: string; edges: CandidateEdge[]; suggestedRelation: string; origin?: string; constraints?: Partial<Constraints> };

type CollectionLog = { id: string; url: string; source_name: string; fetched_at: string; status: "ok" | "error" | "duplicate"; error_msg: string | null; candidates_count: number };

/**
 * Phase 2 + Phase 4：供给管线入口。
 * 三种模式：粘贴语料（Phase 2，调 /api/extract）、输入 URL（Phase 4，调 /api/collect）、
 * 私有情报（人际渠道听到的事，手工录一条）。
 * 抽取结果一律 hypothesis + related，六道门全空，结构性卡在第 5 道门。
 *
 * 私有情报不走 /api/extract：抽取器的契约是"逐条保留原文引语"，而私下听到的东西
 * 本来就是转述，没有原文可留。让它伪装成公开语料喂给抽取器，只会把来源谱系做假。
 */
export function Intake({ onAccept, existing }: { onAccept: (candidates: Candidate[]) => void; existing: Signal[] }) {
  const [mode, setMode] = useState<"paste" | "url" | "private">("paste");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [source, setSource] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [privateTitle, setPrivateTitle] = useState("");
  const [humanSource, setHumanSource] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [logs, setLogs] = useState<CollectionLog[]>([]);
  const [logsLoaded, setLogsLoaded] = useState(false);

  useEffect(() => {
    if (mode === "url" && !logsLoaded) {
      void fetch("/api/collect").then(async r => {
        const d = await r.json() as { logs?: CollectionLog[] };
        setLogs(d.logs || []);
        setLogsLoaded(true);
      }).catch(() => setLogsLoaded(true));
    }
  }, [mode, logsLoaded]);

  async function extractPaste() {
    if (text.trim().length < 40) { setError("语料太短，至少 40 字才值得抽取"); return; }
    if (!source.trim()) { setError("必须写明来源，否则第一道门就过不了"); return; }
    setRunning(true); setError(""); setCandidates([]); setPicked(new Set());
    try {
      const response = await fetch("/api/extract", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, source, sourceUrl }) });
      const data = await response.json() as { candidates?: Candidate[]; error?: string; detail?: string };
      if (!response.ok || !data.candidates) throw new Error(data.error || data.detail || "抽取失败");
      if (!data.candidates.length) { setError("模型没有从这段语料里找到可核查的企业关系"); return; }
      setCandidates(data.candidates);
      setPicked(new Set(data.candidates.map((_, i) => i)));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "抽取失败"); }
    finally { setRunning(false); }
  }

  async function collectUrl() {
    const trimmed = url.trim();
    if (!trimmed.startsWith("http")) { setError("请输入完整的 https:// 或 http:// URL"); return; }
    setRunning(true); setError(""); setCandidates([]); setPicked(new Set());
    try {
      const response = await fetch("/api/collect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: trimmed, source: source || undefined }) });
      const data = await response.json() as { candidates?: Candidate[]; duplicate?: boolean; previousFetch?: string; candidatesCount?: number; error?: string };
      if (!response.ok) throw new Error(data.error || "采集失败");
      if (data.duplicate) { setError(`该 URL 已于 ${data.previousFetch?.slice(0, 10)} 采集，抽出 ${data.candidatesCount} 条候选。如需重新采集，请清除记录后再试。`); return; }
      if (!data.candidates?.length) { setError("页面中未找到可核查的企业关系，可能是动态渲染内容或无相关语料"); return; }
      setCandidates(data.candidates);
      setPicked(new Set(data.candidates.map((_, i) => i)));
      setLogsLoaded(false); // 刷新日志
    } catch (caught) { setError(caught instanceof Error ? caught.message : "采集失败"); }
    finally { setRunning(false); }
  }

  // 私有情报走同一个写入路径，只是候选由人手填而不是模型抽。
  // 预设 internal + observation：你确实听到了这句话（观察），但来源是人际渠道（弱来源）。
  // 除此之外一门不填——听来的东西同样要补边界、证伪和有效期才能过闸。
  function submitPrivate() {
    if (!privateTitle.trim()) { setError("先写清这条情报说的是什么"); return; }
    if (text.trim().length < 20) { setError("原始依据太短，至少 20 字，否则第一道门就过不了"); return; }
    if (!source.trim()) { setError("必须写明场合，否则来源栏是空的"); return; }
    if (!humanSource.trim()) { setError("必须写清谁在什么场合说的，说不出出处的私下消息连来源谱系都不成立"); return; }
    setError("");
    onAccept([{
      title: privateTitle.trim(), evidence: text.trim(), source: source.trim(), edges: [], suggestedRelation: "", origin: "private",
      constraints: { sourceType: "internal", epistemicState: "observation", humanSource: humanSource.trim() },
    }]);
    setPrivateTitle(""); setText(""); setSource(""); setHumanSource("");
  }

  function toggle(index: number) {
    setPicked(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; });
  }

  function write() {
    onAccept(candidates.filter((_, i) => picked.has(i)));
    setCandidates([]); setPicked(new Set()); setText(""); setUrl("");
  }

  const admitted = existing.filter(signal => gateState(signal).executable).length;
  const pipelineCount = existing.filter(signal => signal.origin === "pipeline").length;

  return <>
    <ViewHeader kicker="SUPPLY PIPELINE / CANDIDATES ONLY" title="管线只负责供给，不负责判决" copy="抽取结果一律标记为假设 + 同源，六道门全空。它们能进入情报库，但在人工补齐边界和签署之前，永远卡在第 5 道门。" />
    <div className="intake-stats">
      <div><small>库内情报</small><b>{existing.length}</b><span>全部来源合计</span></div>
      <div><small>来自管线</small><b>{pipelineCount}</b><span>抽取写入，未经人工签署</span></div>
      <div><small>已过闸</small><b>{admitted}</b><span>六道门全过，可进入行动</span></div>
      <div><small>管线过闸</small><b>0</b><span>管线写入默认 0/6，结构性不过闸</span></div>
    </div>
    <div className="intake-mode-tabs">
      <button className={mode === "paste" ? "active" : ""} onClick={() => { setMode("paste"); setError(""); setCandidates([]); setPicked(new Set()); }}>粘贴语料</button>
      <button className={mode === "url" ? "active" : ""} onClick={() => { setMode("url"); setError(""); setCandidates([]); setPicked(new Set()); }}>URL 采集</button>
      <button className={mode === "private" ? "active" : ""} onClick={() => { setMode("private"); setError(""); setCandidates([]); setPicked(new Set()); }}>私有情报</button>
    </div>
    <div className="intake-grid">
      <section className="intake-input">
        <small>01 / {mode === "paste" ? "RAW CORPUS" : mode === "url" ? "SOURCE URL" : "HUMAN CHANNEL"}</small>
        {mode === "private" ? <>
          <label htmlFor="private-title">这条情报说的是什么<input id="private-title" value={privateTitle} onChange={e => setPrivateTitle(e.target.value)} placeholder="A 公司可能在换掉现有电芯供应商" /></label>
          <label htmlFor="private-evidence">原始依据（你听到的原话或复述）
            <textarea id="private-evidence" value={text} onChange={e => setText(e.target.value)} placeholder="尽量贴近对方的原话。你自己的推断另起一句，标明是推断——听到的和想到的混在一起，后面没法分辨哪句需要核查。" />
          </label>
          <label htmlFor="private-source">来源（场合）<input id="private-source" value={source} onChange={e => setSource(e.target.value)} placeholder="7/20 客户复盘会" /></label>
          <label htmlFor="private-human">人际出处<input id="private-human" value={humanSource} onChange={e => setHumanSource(e.target.value)} placeholder="客户方采购经理在 7/20 复盘会上口头提及" /></label>
          <p className="intake-note">私有情报不走抽取器：抽取器要求逐条保留原文引语，而私下听到的本来就是转述。这里录入的一条会标为人际渠道 + 观察态，仍然是 0/6——它提示你该去核查什么，不代表结论成立。人际出处只记职务与场合，不记私生活。</p>
        </> : mode === "paste" ? <>
          <label htmlFor="intake-corpus">粘贴一段公开语料
            <textarea id="intake-corpus" value={text} onChange={e => setText(e.target.value)} placeholder="公告、招股书节选、财报问答、新闻报道原文。粘原文，不要粘你的总结。" />
          </label>
          <label htmlFor="intake-source">来源<input id="intake-source" value={source} onChange={e => setSource(e.target.value)} placeholder="巨潮资讯网 / 公司公告 2026-07-15" /></label>
          <label htmlFor="intake-url-hint">原始链接（可选）<input id="intake-url-hint" value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} placeholder="https://" /></label>
        </> : <>
          <label htmlFor="collect-url">目标 URL（公开可访问）
            <input id="collect-url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.cninfo.com.cn/..." />
          </label>
          <label htmlFor="collect-source">来源标注（可选，默认用域名）<input id="collect-source" value={source} onChange={e => setSource(e.target.value)} placeholder="巨潮资讯网 / 深交所公告" /></label>
          <p className="intake-note">服务端直接抓取，支持 HTML 和纯文本。不支持需要登录的页面或动态渲染（SPA）。单次最多 500KB。</p>
        </>}
        {error && <p className="intake-error" role="alert">● {error}</p>}
        <button className="primary-action" disabled={running} onClick={mode === "private" ? submitPrivate : mode === "paste" ? extractPaste : collectUrl}>
          {running ? (mode === "paste" ? "抽取中…" : "采集中…") : mode === "private" ? "写入 1 条私有情报（0/6 待补齐）" : mode === "paste" ? "抽取候选关系" : "采集并抽取"}
        </button>
        {mode !== "private" && <p className="intake-note">抽取器只被允许做一件事：把语料切成“谁—对谁—什么关系”，并逐条保留原文引语。它不填概率、不填边界、不签署。</p>}
        {mode === "url" && logs.length > 0 && <div className="collection-log">
          <small>最近采集记录</small>
          {logs.map(log => <div key={log.id} className={`log-row log-${log.status}`}>
            <span title={log.url}>{new URL(log.url).hostname}</span>
            <em>{log.fetched_at.slice(0, 10)}</em>
            <b>{log.status === "ok" ? `${log.candidates_count} 候选` : log.status === "duplicate" ? "重复" : "失败"}</b>
          </div>)}
        </div>}
      </section>
      <section className="intake-output">
        <small>02 / CANDIDATE SIGNALS</small>
        <h3>{candidates.length ? `${candidates.length} 条候选，勾选后写入情报库` : "等待抽取"}</h3>
        <div className="candidate-list">
          {candidates.map((candidate, index) => <article key={index} className={picked.has(index) ? "picked" : ""}>
            <header>
              <input type="checkbox" id={`candidate-${index}`} checked={picked.has(index)} onChange={() => toggle(index)} />
              <h4><label htmlFor={`candidate-${index}`}>{candidate.title}</label></h4>
            </header>
            <p>{candidate.evidence}</p>
            <div className="candidate-edges">{candidate.edges.map((edge, ei) => <div key={ei}>
              <b>{edge.from}</b>{edge.direction === "mutual" ? "↔" : "→"}<b>{edge.to}</b><small>{relationLabel(edge.relation)}</small>
            </div>)}</div>
            {candidate.edges[0]?.quote && <blockquote>“{candidate.edges[0].quote}”</blockquote>}
          </article>)}
          {!candidates.length && <div className="empty-log">抽取结果会显示在这里，附带原文引语作为溯源锚点。</div>}
        </div>
        {candidates.length > 0 && <button className="primary-action" disabled={!picked.size} onClick={write}>写入 {picked.size} 条候选情报（0/6 待补齐）</button>}
      </section>
    </div>
  </>;
}
