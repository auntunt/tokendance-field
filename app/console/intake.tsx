"use client";

import { useEffect, useState } from "react";
import { Constraints, Signal, gateState } from "../../lib/field-core";
import { relationLabel } from "../../lib/ontology";
import { ViewHeader } from "./shared";

/** 见 lib/extractor.ts 的 EntityKind：非 legal 的主体在候选卡上标出来，提示人补法人名。
 *  可选是因为手工录入的私有情报不经过抽取器，没有这个字段。 */
export type EntityKind = "legal" | "brand" | "project" | "site" | "asset" | "unknown";
export type CandidateEdge = { from: string; to: string; relation: string; direction: "forward" | "mutual"; quote: string; fromKind?: EntityKind; toKind?: EntityKind };
/** constraints 只给私有情报录入用：它需要把来源谱系钉成 internal，其余一律走隔离默认值。 */
export type Candidate = { title: string; evidence: string; source: string; sourceUrl?: string; edges: CandidateEdge[]; suggestedRelation: string; origin?: string; constraints?: Partial<Constraints> };

type CollectionLog = { id: string; url: string; source_name: string; fetched_at: string; status: "ok" | "error" | "duplicate"; error_msg: string | null; candidates_count: number };

/** 判重结论 + 重抓时要带上的原请求。retry 里存的是「照抽一遍」要重放的那次调用。 */
type RepeatInfo = { message: string; differentSource?: boolean; sameUrl?: boolean; retry: () => void };

const KIND_LABEL: Record<EntityKind, string> = { legal: "", brand: "品牌", project: "项目", site: "场所", asset: "设备", unknown: "待定" };

/** legal 不加标记：正常情况不该有视觉噪音，只有需要人干预的才亮出来。 */
function kindTag(kind?: EntityKind) {
  const label = kind ? KIND_LABEL[kind] : "";
  return label ? <em className="kind-tag">{label}</em> : null;
}

/** 收集这条候选里所有拿不到法人身份的主体名，去重后给出提示。 */
function unresolvedNames(candidate: Candidate) {
  const names = new Set<string>();
  for (const edge of candidate.edges) {
    if (edge.fromKind && edge.fromKind !== "legal") names.add(edge.from);
    if (edge.toKind && edge.toKind !== "legal") names.add(edge.to);
  }
  return [...names];
}

/**
 * Phase 2 + Phase 4：供给管线入口。
 * 三种模式：粘贴语料（Phase 2，调 /api/extract）、输入 URL（Phase 4，调 /api/collect）、
 * 私有情报（人际渠道听到的事，手工录一条）。
 * 抽取结果一律 hypothesis + related，六道门全空，结构性卡在第 5 道门。
 *
 * 私有情报不走 /api/extract：抽取器的契约是"逐条保留原文引语"，而私下听到的东西
 * 本来就是转述，没有原文可留。让它伪装成公开语料喂给抽取器，只会把来源谱系做假。
 */
export function Intake({ onAccept, existing, onManual, onGoJudge }: {
  onAccept: (candidates: Candidate[]) => void; existing: Signal[];
  onManual: () => void; onGoJudge: () => void;
}) {
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
  /** 判重结论。刻意不塞进 error：重复不是失败，是一条有用的信息，
   *  而且人有权决定要不要照抽——所以它需要自己的展示位和一个「照抽」按钮。 */
  const [repeat, setRepeat] = useState<RepeatInfo | null>(null);

  useEffect(() => {
    if (mode === "url" && !logsLoaded) {
      void fetch("/api/collect").then(async r => {
        const d = await r.json() as { logs?: CollectionLog[] };
        setLogs(d.logs || []);
        setLogsLoaded(true);
      }).catch(() => setLogsLoaded(true));
    }
  }, [mode, logsLoaded]);

  async function extractPaste(force = false) {
    if (text.trim().length < 40) { setError("语料太短，至少 40 字才值得抽取"); return; }
    if (!source.trim()) { setError("必须写明来源，否则第一道门就过不了"); return; }
    setRunning(true); setError(""); setRepeat(null); setCandidates([]); setPicked(new Set());
    try {
      const response = await fetch("/api/extract", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, source, sourceUrl, force }) });
      const data = await response.json() as { candidates?: Candidate[]; duplicate?: boolean; message?: string; differentSource?: boolean; error?: string; detail?: string };
      if (!response.ok || !data.candidates) throw new Error(data.error || data.detail || "抽取失败");
      if (data.duplicate) {
        setRepeat({ message: data.message || "这段材料见过了。", differentSource: data.differentSource, retry: () => void extractPaste(true) });
        return;
      }
      if (!data.candidates.length) { setError("模型没有从这段语料里找到可核查的企业关系"); return; }
      setCandidates(data.candidates);
      setPicked(new Set(data.candidates.map((_, i) => i)));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "抽取失败"); }
    finally { setRunning(false); }
  }

  async function collectUrl(force = false) {
    const trimmed = url.trim();
    if (!trimmed.startsWith("http")) { setError("请输入完整的 https:// 或 http:// URL"); return; }
    setRunning(true); setError(""); setRepeat(null); setCandidates([]); setPicked(new Set());
    try {
      const response = await fetch("/api/collect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: trimmed, source: source || undefined, force }) });
      const data = await response.json() as { candidates?: Candidate[]; duplicate?: boolean; message?: string; differentSource?: boolean; sameUrl?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || "采集失败");
      if (data.duplicate) {
        setRepeat({ message: data.message || "这个网址抓过了。", differentSource: data.differentSource, sameUrl: data.sameUrl, retry: () => void collectUrl(true) });
        return;
      }
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

  const pending = existing.filter(signal => !gateState(signal).executable).length;
  const reset = (next: typeof mode) => { setMode(next); setError(""); setCandidates([]); setPicked(new Set()); };

  return <>
    <ViewHeader kicker="第 1 步 / 收集" title="先把材料弄进来" copy="贴一段原文，或给一个链接，机器把「谁和谁有什么关系」挑出来。它只负责挑，判断得你自己下。"
      action={existing.length ? `去判断（${pending} 条待补）` : undefined} onAction={onGoJudge} />
    <div className="intake-mode-tabs">
      <button className={mode === "paste" ? "active" : ""} onClick={() => reset("paste")}>贴一段原文</button>
      <button className={mode === "url" ? "active" : ""} onClick={() => reset("url")}>给一个链接</button>
      <button className={mode === "private" ? "active" : ""} onClick={() => reset("private")}>录我听到的事</button>
      <button className="manual-entry" onClick={onManual}>手工录一条完整关系 →</button>
    </div>
    <div className="intake-grid">
      <section className="intake-input">
        <small>{mode === "paste" ? "贴原文" : mode === "url" ? "给链接" : "听到的事"}</small>
        {mode === "private" ? <>
          <label htmlFor="private-title">这条说的是什么<input id="private-title" value={privateTitle} onChange={e => setPrivateTitle(e.target.value)} placeholder="A 公司可能在换掉现有电芯供应商" /></label>
          <label htmlFor="private-evidence">你听到的原话或复述
            <textarea id="private-evidence" value={text} onChange={e => setText(e.target.value)} placeholder="尽量贴近对方的原话。你自己的推断另起一句，标明是推断——听到的和想到的混在一起，后面没法分辨哪句需要核查。" />
          </label>
          <label htmlFor="private-source">什么场合<input id="private-source" value={source} onChange={e => setSource(e.target.value)} placeholder="7/20 客户复盘会" /></label>
          <label htmlFor="private-human">谁说的<input id="private-human" value={humanSource} onChange={e => setHumanSource(e.target.value)} placeholder="客户方采购经理在 7/20 复盘会上口头提及" /></label>
          <p className="intake-note">这条不过机器抽取——听来的话本来就是转述，没有原文可留。它会被标成弱来源：能提示你该去核查什么，但不能当结论。只写职务和场合，别写私事。</p>
        </> : mode === "paste" ? <>
          <label htmlFor="intake-corpus">把原文贴进来
            <textarea id="intake-corpus" value={text} onChange={e => setText(e.target.value)} placeholder="公告、招股书节选、财报问答、新闻原文都行。贴原文，别贴你的总结——总结里没有可核查的细节。" />
          </label>
          <label htmlFor="intake-source">这段哪儿来的<input id="intake-source" value={source} onChange={e => setSource(e.target.value)} placeholder="巨潮资讯网 / 公司公告 2026-07-15" /></label>
          <label htmlFor="intake-url-hint">链接（有就填）<input id="intake-url-hint" value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} placeholder="https://" /></label>
        </> : <>
          <label htmlFor="collect-url">页面地址
            <input id="collect-url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.cninfo.com.cn/..." />
          </label>
          <label htmlFor="collect-source">这个来源叫什么（不填就用域名）<input id="collect-source" value={source} onChange={e => setSource(e.target.value)} placeholder="巨潮资讯网 / 深交所公告" /></label>
          <p className="intake-note">要登录的页面和前端渲染的页面抓不到，单次最多 500KB。抓不动就用「贴一段原文」。</p>
        </>}
        {error && <p className="intake-error" role="alert">● {error}</p>}
        {repeat && <div className="intake-repeat">
          <p>{repeat.message}</p>
          {repeat.differentSource && <p className="intake-repeat-warn">转载不算第二来源。如果你是想凑「有好几家都这么说」，这一条凑不上。</p>}
          <button type="button" className="ghost-action" onClick={repeat.retry}>
            {repeat.sameUrl ? "重抓一遍" : "照抽一遍"}
          </button>
        </div>}
        {/* onClick 不能直接挂 extractPaste/collectUrl——React 会把 MouseEvent 当第一个参数塞进去，
            那就成了 force=事件对象，每次点击都强制重抽，判重直接失效。所以这里必须包一层。 */}
        <button className="primary-action" disabled={running} onClick={mode === "private" ? submitPrivate : mode === "paste" ? () => void extractPaste() : () => void collectUrl()}>
          {running ? "处理中…" : mode === "private" ? "收下这一条" : mode === "paste" ? "从这段里找关系" : "抓下来并找关系"}
        </button>
        {mode !== "private" && <p className="intake-note">机器只做一件事：把材料切成「谁—对谁—什么关系」，并保留原文那句话。它不给概率、不划范围、不签字。</p>}
        {mode === "url" && logs.length > 0 && <div className="collection-log">
          <small>最近抓过</small>
          {logs.map(log => <div key={log.id} className={`log-row log-${log.status}`}>
            <span title={log.url}>{new URL(log.url).hostname}</span>
            <em>{log.fetched_at.slice(0, 10)}</em>
            <b>{log.status === "ok" ? `${log.candidates_count} 候选` : log.status === "duplicate" ? "重复" : "失败"}</b>
          </div>)}
        </div>}
      </section>
      <section className="intake-output">
        <small>找到的关系</small>
        <h3>{candidates.length ? `找到 ${candidates.length} 条，勾你要留的` : "结果会显示在这里"}</h3>
        <div className="candidate-list">
          {candidates.map((candidate, index) => <article key={index} className={picked.has(index) ? "picked" : ""}>
            <header>
              <input type="checkbox" id={`candidate-${index}`} checked={picked.has(index)} onChange={() => toggle(index)} />
              <h4><label htmlFor={`candidate-${index}`}>{candidate.title}</label></h4>
            </header>
            <p>{candidate.evidence}</p>
            <div className="candidate-edges">{candidate.edges.map((edge, ei) => <div key={ei}>
              <b>{edge.from}</b>{kindTag(edge.fromKind)}{edge.direction === "mutual" ? "↔" : "→"}<b>{edge.to}</b>{kindTag(edge.toKind)}<small>{relationLabel(edge.relation)}</small>
            </div>)}</div>
            {unresolvedNames(candidate).length > 0 && <p className="candidate-warn">
              这几个不是公司全称，留下后得补上工商全称，否则和别的情报对不上：{unresolvedNames(candidate).join("、")}
            </p>}
            {candidate.edges[0]?.quote && <blockquote>“{candidate.edges[0].quote}”</blockquote>}
          </article>)}
          {!candidates.length && <div className="empty-log">每条都会附上原文里的那句话，方便你回头核。</div>}
        </div>
        {candidates.length > 0 && <button className="primary-action" disabled={!picked.size} onClick={write}>留下这 {picked.size} 条</button>}
      </section>
    </div>
  </>;
}
