"use client";

import { useEffect, useMemo, useState } from "react";
import type { InvestigationSubjectType } from "../../lib/investigation/types";

type Source = { id: string; url: string; domain: string; title: string; checkStatus: "cited" | "fetching" | "verified" | "failed" };
type Relation = {
  id: string; from: string; to: string; relation: string; direction: "forward" | "mutual";
  quote: string; claimId: string; claimTitle: string; evidence: string; sources: Source[];
};
type Graph = {
  id: string; entityName: string; question: string; subjectType: InvestigationSubjectType;
  status: string; relations: Relation[]; sourceCount: number; verifiedSourceCount: number;
};
type InvestigationListItem = {
  id: string; entity_name: string; question: string; subject_type?: InvestigationSubjectType;
  status: string; updated_at: string;
};
type GraphResponse = { investigations: InvestigationListItem[]; graph: Graph | null };

const RELATION_META: Record<string, { label: string; color: string; group: "inside" | "outside" | "market" }> = {
  organization: { label: "组织归属", color: "#57c4cb", group: "inside" },
  personnel: { label: "人员 / 职责", color: "#5ea6ef", group: "inside" },
  product: { label: "产品 / 技术", color: "#d9b55c", group: "outside" },
  deployment: { label: "部署 / 场景", color: "#70c88f", group: "outside" },
  partnership: { label: "合作", color: "#e38f62", group: "market" },
  equity: { label: "投资 / 股权", color: "#e88972", group: "market" },
  supply: { label: "供给 / 客户", color: "#e5ad54", group: "market" },
  compete: { label: "竞争", color: "#a17be7", group: "market" },
  license: { label: "授权 / 备案", color: "#7a9bdf", group: "outside" },
};

function meta(relation: string) { return RELATION_META[relation] || { label: relation, color: "#8b979e", group: "market" as const }; }
function sourceState(status: Source["checkStatus"]) { return status === "verified" ? "原文已获取" : status === "failed" ? "原文未获取" : status === "fetching" ? "正在获取" : "待复核"; }

type Position = { x: number; y: number; lane: "inside" | "root" | "outside" | "market" };

function layoutGraph(graph: Graph, relations: Relation[]) {
  const nodes = new Set<string>([graph.entityName]);
  relations.forEach(relation => { nodes.add(relation.from); nodes.add(relation.to); });
  const root = graph.entityName;
  const bucket = new Map<string, "inside" | "outside">();
  for (const node of nodes) {
    if (node === root) continue;
    const connected = relations.filter(item => item.from === node || item.to === node);
    const group = connected.some(item => meta(item.relation).group === "inside") ? "inside"
      : "outside";
    bucket.set(node, group);
  }
  const position = new Map<string, Position>([[root, { x: 50, y: 48, lane: "root" }]]);
  const inside = [...bucket.entries()].filter(([, group]) => group === "inside").map(([node]) => node);
  const outside = [...bucket.entries()].filter(([, group]) => group === "outside").map(([node]) => node);
  const laneCount = Math.max(inside.length, outside.length);
  // 保持首屏仍能看到主体，同时为实体较多的档案留出稳定的节点间距。
  const height = Math.max(620, Math.min(880, 230 + laneCount * 52));
  const put = (items: string[], x: number, lane: Position["lane"], top = 13, bottom = 91) => {
    const step = items.length < 2 ? 0 : (bottom - top) / (items.length - 1);
    items.sort((a, b) => a.localeCompare(b, "zh-CN")).forEach((node, index) => position.set(node, { x, y: items.length < 2 ? 50 : top + index * step, lane }));
  };
  put(inside, 17, "inside");
  put(outside, 83, "outside");
  return { nodes: [...nodes], root, positions: position, height };
}

function edgePath(from: Position, to: Position) {
  const bend = from.x === to.x ? 11 : Math.min(13, Math.abs(to.x - from.x) * .23);
  const controlX = (from.x + to.x) / 2;
  const controlY = (from.y + to.y) / 2 + (from.y < to.y ? -bend : bend);
  return `M ${from.x} ${from.y} Q ${controlX} ${controlY} ${to.x} ${to.y}`;
}

function subjectLabel(subjectType: InvestigationSubjectType | undefined) {
  return subjectType === "industry" ? "行业专题" : subjectType === "person" ? "人员档案" : "公司档案";
}

export function InvestigationGraph({ onStartResearch }: { onStartResearch: (question: string) => void }) {
  const [payload, setPayload] = useState<GraphResponse | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [selectedEdge, setSelectedEdge] = useState<Relation | null>(null);
  const [filter, setFilter] = useState<string[]>([]);
  const [error, setError] = useState("");

  const load = async (id = selectedId) => {
    const url = id ? `/api/investigations/graph?id=${encodeURIComponent(id)}` : "/api/investigations/graph";
    const response = await fetch(url);
    const data = await response.json() as GraphResponse & { error?: string };
    if (!response.ok) throw new Error(data.error || "关系档案读取失败");
    setPayload(data);
    if (!selectedId && data.graph) setSelectedId(data.graph.id);
  };

  useEffect(() => {
    let active = true;
    void fetch("/api/investigations/graph").then(async response => {
      const data = await response.json() as GraphResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || "关系档案读取失败");
      if (active) { setPayload(data); if (data.graph) setSelectedId(data.graph.id); }
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : "关系档案读取失败"); });
    return () => { active = false; };
  }, []);

  function pickInvestigation(id: string) {
    setSelectedId(id); setSelectedEdge(null); setFilter([]); setError("");
    void load(id).catch(error => setError(error instanceof Error ? error.message : "关系档案读取失败"));
  }

  const graph = payload?.graph || null;
  const relationTypes = useMemo(() => [...new Set(graph?.relations.map(item => item.relation) || [])], [graph]);
  const visibleRelations = useMemo(() => graph?.relations.filter(item => !filter.length || filter.includes(item.relation)) || [], [graph, filter]);
  const layout = useMemo(() => graph ? layoutGraph(graph, visibleRelations) : null, [graph, visibleRelations]);

  function toggle(relation: string) { setFilter(current => current.includes(relation) ? current.filter(item => item !== relation) : [...current, relation]); setSelectedEdge(null); }

  return <section className="investigation-graph">
    <header className="investigation-graph-head">
      <div><span>EVIDENCE RELATION FIELD</span><h1>看清关系，<em>也看清它依靠的证据。</em></h1><p>不做全量关系毛线团。每条连接都能回到一条调查主张和原始链接，组织、产品、部署与生态分到可读的泳道。</p></div>
      <div className="graph-dossier-switcher"><small>选择一份调查档案</small><div>{(payload?.investigations || []).slice(0, 6).map(item => <button key={item.id} className={item.id === graph?.id ? "active" : ""} onClick={() => pickInvestigation(item.id)}><b>{item.entity_name}</b><span>{item.status === "researching" ? "研究中" : subjectLabel(item.subject_type)}</span></button>)}</div></div>
    </header>

    {error && <div className="query-error" role="alert">⚠ {error}</div>}
    {!graph && !error && <div className="investigation-graph-empty"><b>还没有调查档案。</b><span>先从一句模糊线索开始，关系会随着有来源的主张逐步长出来。</span><button className="primary-action" onClick={() => onStartResearch("")}>开始调查</button></div>}
    {graph && <>
      <div className="graph-summary-bar"><div><b>{graph.entityName}</b><span>{graph.question}</span></div><em>{subjectLabel(graph.subjectType)} · {graph.relations.length} 条关系 · {graph.verifiedSourceCount}/{graph.sourceCount} 原文已核</em><button onClick={() => onStartResearch(`${graph.entityName} 的组织、合作和当前动作`)}>从这里继续查 →</button></div>
      <div className="investigation-graph-filters"><span>只看</span>{relationTypes.map(type => <button key={type} className={!filter.length || filter.includes(type) ? "active" : ""} onClick={() => toggle(type)}><i style={{ background: meta(type).color }} />{meta(type).label}</button>)}{filter.length > 0 && <button className="clear" onClick={() => { setFilter([]); setSelectedEdge(null); }}>显示全部</button>}</div>
      <div className="investigation-graph-stage">
        <main className="investigation-graph-canvas" style={layout ? { minHeight: layout.height } : undefined}>
          <div className="graph-lane-label inside">组织与关键人</div><div className="graph-lane-label center">调查主体</div><div className="graph-lane-label outside">产品、部署与生态</div>
          {!visibleRelations.length && <div className="investigation-graph-empty"><b>本档案还没有可画的明确关系。</b><span>这不是没有信息，而是模型还没有在来源原文中找到足以画线的“谁—对谁—什么关系”。</span></div>}
          {layout && <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{visibleRelations.map(edge => {
            const from = layout.positions.get(edge.from); const to = layout.positions.get(edge.to);
            if (!from || !to) return null;
            const active = selectedEdge?.id === edge.id;
            return <path key={edge.id} d={edgePath(from, to)} onClick={() => setSelectedEdge(edge)}
              stroke={meta(edge.relation).color} strokeWidth={active ? 2.25 : 1.25} opacity={active ? 1 : .66}
              strokeDasharray={edge.sources.some(source => source.checkStatus === "verified") ? undefined : "3 2.2"} fill="none" vectorEffect="non-scaling-stroke" />;
          })}</svg>}
          {layout?.nodes.map(node => {
            const position = layout.positions.get(node)!; const connected = visibleRelations.filter(edge => edge.from === node || edge.to === node); const degree = connected.length;
            const evidenceSources = new Map(connected.flatMap(edge => edge.sources).map(source => [source.id, source]));
            const verified = [...evidenceSources.values()].filter(source => source.checkStatus === "verified").length;
            return <button key={node} className={`investigation-graph-node ${position.lane} ${node === layout.root ? "root" : ""}`} style={{ left: `${position.x}%`, top: `${position.y}%` }} onClick={() => setSelectedEdge(visibleRelations.find(edge => edge.from === node || edge.to === node) || null)}>
              <b>{node}</b><span>{node === layout.root ? subjectLabel(graph.subjectType) : `${degree} 条关联 · ${verified}/${evidenceSources.size} 已核`}</span>
            </button>;
          })}
        </main>
        <aside className="investigation-graph-inspector">
          {selectedEdge ? <>
            <small>这条关系的依据</small><h2>{selectedEdge.from} {selectedEdge.direction === "mutual" ? "↔" : "→"} {selectedEdge.to}</h2><em style={{ color: meta(selectedEdge.relation).color }}>{meta(selectedEdge.relation).label}</em>
            <blockquote>“{selectedEdge.quote}”</blockquote><h3>{selectedEdge.claimTitle}</h3><p>{selectedEdge.evidence}</p><div className="graph-evidence-links">{selectedEdge.sources.map(source => <a key={source.id} href={source.url} target="_blank" rel="noreferrer"><i className={source.checkStatus} />{source.domain} · {sourceState(source.checkStatus)}</a>)}</div>
          </> : <>
            <small>如何阅读</small><h2>从主体出发，选择一条连接查看它的原文依据。</h2><p>左侧是组织和关键人；右侧是产品、部署与生态。只有原文明确说出的关系会出现，虚线表示引用仍在等待复核。</p><div className="graph-legend">{relationTypes.map(type => <span key={type}><i style={{ background: meta(type).color }} />{meta(type).label}</span>)}</div>
          </>}
        </aside>
      </div>
    </>}
  </section>;
}
