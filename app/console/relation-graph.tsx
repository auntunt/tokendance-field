"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Signal, gateState } from "../../lib/field-core";
import { RELATIONS, relationLabel } from "../../lib/ontology";
import { GraphEdge, GraphNode, buildGraph, edgeTone } from "../../lib/graph";
import { ViewHeader } from "./shared";

const RELATION_COLOR: Record<string, string> = { equity: "#ff5a3d", supply: "#ffad21", compete: "#9161e8", personnel: "#41c6cc", license: "#5796f4" };

function nodeSize(degree: number) {
  return Math.min(30, 13 + degree * 3);
}

// 画布用 viewBox="0 0 100 100" + preserveAspectRatio="none"，X/Y 是不等比拉伸的：
// <marker> 会连同 orient="auto" 的角度一起被拉斜，所以箭头手工画。
// 做法：先把坐标换进"每单位都等于 h/100 像素"的等比空间算三角形，再除回 ratio 映射到用户坐标，
// 这样箭头在任何画布宽高比下都正对着边的真实屏幕方向，大小也稳定在 10px 上下。
function arrowHead(from: GraphNode, to: GraphNode, box: { w: number; h: number }) {
  if (box.w <= 0 || box.h <= 0) return "";
  const ratio = box.w / box.h;
  const dx = (to.x - from.x) * 100 * ratio, dy = (to.y - from.y) * 100;
  const length = Math.hypot(dx, dy);
  // 节点和箭头都按屏幕像素换算回 SVG 单位，画布拉长后不会跟着变成巨型箭头。
  const pixelsPerUnit = box.h / 100;
  const back = (nodeSize(to.degree) / 2 + 3) / pixelsPerUnit;
  const headLength = 9 / pixelsPerUnit;
  const wing = 4.5 / pixelsPerUnit;
  if (!Number.isFinite(length) || length < back + headLength) return "";
  const ux = dx / length, uy = dy / length;
  const tipX = to.x * 100 * ratio - ux * back, tipY = to.y * 100 - uy * back;
  const baseX = tipX - ux * headLength, baseY = tipY - uy * headLength;
  const wingX = -uy * wing, wingY = ux * wing;
  return `${tipX / ratio},${tipY} ${(baseX + wingX) / ratio},${baseY + wingY} ${(baseX - wingX) / ratio},${baseY - wingY}`;
}

function edgeCurve(from: GraphNode, to: GraphNode, offset: number) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  // 坐标仍在 0-1 的画布空间，弯曲幅度须控制在几百分点内。
  // 这会把同端点的关系分开，同时不会越过相邻关系簇。
  const bend = Math.min(.048, .016 + length * .1) * offset;
  return {
    x: (from.x + to.x) / 2 - (dy / length) * bend,
    y: (from.y + to.y) / 2 + (dx / length) * bend,
  };
}

function edgePath(from: GraphNode, to: GraphNode, offset: number) {
  if (!offset) return `M ${from.x * 100} ${from.y * 100} L ${to.x * 100} ${to.y * 100}`;
  const control = edgeCurve(from, to, offset);
  return `M ${from.x * 100} ${from.y * 100} Q ${control.x * 100} ${control.y * 100} ${to.x * 100} ${to.y * 100}`;
}

export function RelationGraph({ signals, onOpenSignal }: { signals: Signal[]; onOpenSignal: (id: string) => void }) {
  const [filter, setFilter] = useState<string[]>([]);
  const [node, setNode] = useState("");
  const [edge, setEdge] = useState<GraphEdge | null>(null);
  const [labels, setLabels] = useState<"smart" | "all">("smart");
  const graph = useMemo(() => buildGraph(signals, filter), [signals, filter]);
  const parallelOffsets = useMemo(() => {
    const grouped = new Map<string, GraphEdge[]>();
    for (const item of graph.edges) {
      const key = [item.from, item.to].sort((a, b) => a.localeCompare(b)).join("\u0000");
      grouped.set(key, [...(grouped.get(key) || []), item]);
    }
    const offsets = new Map<string, number>();
    for (const group of grouped.values()) {
      group.sort((a, b) => a.relation.localeCompare(b.relation) || a.key.localeCompare(b.key));
      group.forEach((item, index) => offsets.set(item.key, (index - (group.length - 1) / 2) * .72));
    }
    return offsets;
  }, [graph.edges]);
  // 把连通分量画成带框的「关系簇」：一眼看出哪些公司属于同一组关系。
  const clusters = useMemo(() => {
    const adjacent = new Map<string, Set<string>>();
    for (const node of graph.nodes) adjacent.set(node.id, new Set());
    for (const edge of graph.edges) {
      adjacent.get(edge.from)?.add(edge.to);
      adjacent.get(edge.to)?.add(edge.from);
    }
    const visited = new Set<string>();
    const components: string[][] = [];
    for (const node of graph.nodes) {
      if (visited.has(node.id)) continue;
      const stack = [node.id];
      const component: string[] = [];
      visited.add(node.id);
      while (stack.length) {
        const current = stack.pop()!;
        component.push(current);
        for (const next of adjacent.get(current) || []) {
          if (!visited.has(next)) { visited.add(next); stack.push(next); }
        }
      }
      components.push(component);
    }
    return components.map(ids => {
      const members = graph.nodes.filter(node => ids.includes(node.id));
      const links = graph.edges.filter(edge => ids.includes(edge.from) && ids.includes(edge.to));
      const counts = new Map<string, number>();
      for (const link of links) counts.set(link.relation, (counts.get(link.relation) || 0) + 1);
      const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "unclustered";
      const xs = members.map(node => node.x), ys = members.map(node => node.y);
      return {
        ids,
        members,
        links,
        dominant,
        count: links.length,
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minY: Math.min(...ys), maxY: Math.max(...ys),
      };
    }).sort((a, b) => b.count - a.count);
  }, [graph]);
  // 与图布局使用相同的货架规则估算行数。每一行按簇大小拿到不同的高度，
  // 大簇不会再被小簇的行高压扁，画布随内容向下延展而不是缩放得更密。
  const canvasMinHeight = useMemo(() => {
    const slotOf = (size: number) => size >= 7 ? 1 : size >= 4 ? .5 : .25;
    const rowHeightOf = (size: number) => size >= 10 ? 280 : size >= 7 ? 235 : size >= 4 ? 185 : 150;
    const bins: Array<{ used: number; largest: number }> = [];
    const sizes = clusters.map(cluster => cluster.members.length).sort((a, b) => b - a);
    for (const size of sizes) {
      const slot = slotOf(size);
      const bin = bins.find(candidate => candidate.used + slot <= 1.0001);
      if (bin) {
        bin.used += slot;
        bin.largest = Math.max(bin.largest, size);
      } else {
        bins.push({ used: slot, largest: size });
      }
    }
    return Math.max(620, bins.reduce((height, bin) => height + rowHeightOf(bin.largest), 36));
  }, [clusters]);
  const canvas = useRef<HTMLDivElement | null>(null);
  // 画布宽高比会随窗口和响应式断点变（1180px 以下变单列），所以量出来而不是写死常数。
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const target = canvas.current;
    if (!target || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => setBox({ w: target.clientWidth, h: target.clientHeight }));
    watch.observe(target);
    return () => watch.disconnect();
  }, []);
  const focusEdges = node ? graph.edges.filter(item => item.from === node || item.to === node) : [];
  const evidence = edge ? edge.signalIds.map(id => signals.find(item => item.id === id)).filter((item): item is Signal => Boolean(item)) : [];

  function toggle(id: string) {
    setFilter(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
    setEdge(null);
  }

  return <>
    <ViewHeader kicker="关联图谱" title="谁投了谁，谁给谁供货，谁在抢谁" copy="每个关系簇独立排布。点公司只看它的直接关系，点线看支撑材料。虚线是线索，实线是已经确认。" />
    <div className="relation-filters">
      <span>关系类型</span>
      {RELATIONS.map(item => <button key={item.id} className={filter.length === 0 || filter.includes(item.id) ? "on" : ""} onClick={() => toggle(item.id)}><i style={{ background: RELATION_COLOR[item.id] }} />{item.label}</button>)}
      {filter.length > 0 && <button className="clear" onClick={() => { setFilter([]); setEdge(null); }}>显示全部</button>}
      <span className="relation-label-control" aria-label="节点名称显示方式">
        <span>名称</span>
        <button className={labels === "smart" ? "on" : ""} onClick={() => setLabels("smart")}>重点</button>
        <button className={labels === "all" ? "on" : ""} onClick={() => setLabels("all")}>全部</button>
      </span>
      <em>{graph.nodes.length} 家公司 · {graph.edges.length} 条关系 · {clusters.length} 个关系簇 · {graph.edges.filter(item => item.executable).length} 条已确认</em>
    </div>
    <div className="relation-stage">
      <div className="relation-canvas" ref={canvas} style={{ minHeight: canvasMinHeight }}>
        {graph.edges.length === 0 && <div className="relation-empty">还没有关系边。先去「收集」放入材料，机器会把投资、供货、竞争这些关系挑出来。</div>}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          {clusters.map((cluster, index) => {
            const pad = 2.4;
            const width = Math.max(0, (cluster.maxX - cluster.minX) * 100) + pad * 2;
            const height = Math.max(0, (cluster.maxY - cluster.minY) * 100) + pad * 2;
            return <g key={`cluster-${index}`} className="cluster-outline">
              <rect x={Math.max(0.5, cluster.minX * 100 - pad)} y={Math.max(0.5, cluster.minY * 100 - pad)}
                width={width} height={height} rx="3" />
            </g>;
          })}
          {graph.edges.map(item => {
            const from = graph.nodes.find(candidate => candidate.id === item.from);
            const to = graph.nodes.find(candidate => candidate.id === item.to);
            if (!from || !to) return null;
            const active = edge?.key === item.key;
            const dim = Boolean(node) && item.from !== node && item.to !== node;
            // 线的颜色表示关系类型；实线 = 已确认，虚线 = 线索。
            const baseTone = active ? "#ffffff" : RELATION_COLOR[item.relation] || edgeTone(item);
            const tone = baseTone;
            const offset = parallelOffsets.get(item.key) || 0;
            const control = edgeCurve(from, to, offset);
            const heads = [arrowHead(offset ? ({ ...from, x: control.x, y: control.y }) : from, to, box)];
            if (item.direction === "mutual") heads.push(arrowHead(offset ? ({ ...to, x: control.x, y: control.y }) : to, from, box));
            const select = () => { setEdge(item); setNode(""); };
            return <g key={item.key} opacity={dim ? .14 : active ? 1 : item.executable ? .95 : .62} style={{ cursor: "pointer" }} onClick={select}>
              <path d={edgePath(from, to, offset)}
                stroke={tone} strokeWidth={active ? 2.2 : item.executable ? 1.5 : 1.1}
                strokeDasharray={item.executable ? undefined : "4 2.5"} fill="none" vectorEffect="non-scaling-stroke" />
              {heads.map((points, index) => points && <polygon key={index} points={points} fill={tone} />)}
            </g>;
          })}
        </svg>
        {/* SVG 的 viewBox 会随画布等比/非等比缩放；簇标题用 HTML 叠层，字号始终按屏幕像素显示。 */}
        {clusters.map((cluster, index) => <span key={`cluster-label-${index}`} className="relation-cluster-label"
          style={{ left: `${Math.max(1, cluster.minX * 100)}%`, top: `calc(${Math.max(1.8, cluster.minY * 100)}% - 15px)` }}>
          <b>簇 {String(index + 1).padStart(2, "0")}</b><span>{relationLabel(cluster.dominant)}</span><em>{cluster.members.length} 家</em>
        </span>)}
        {graph.nodes.map(item => {
          const size = nodeSize(item.degree);
          const related = !node || item.id === node || focusEdges.some(link => link.from === item.id || link.to === item.id);
          const showLabel = labels === "all" || item.id === node || item.degree >= 3 || graph.nodes.length <= 10;
          const isHub = item.degree >= 2;
          return <button key={item.id} title={item.id} className={`relation-node ${item.id === node ? "selected" : ""} ${showLabel ? "" : "minor"} ${isHub ? "hub" : ""}`}
            style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%`, width: size, height: size, opacity: related ? 1 : .22, borderColor: isHub ? "#ffad21" : "rgba(66,203,213,.5)", background: isHub ? "rgba(255,173,33,.14)" : "rgba(12,20,28,.94)" }}
            onClick={() => { setNode(current => current === item.id ? "" : item.id); setEdge(null); }}>
            {showLabel && <label>{item.id}</label>}
          </button>;
        })}
      </div>
      <aside className="relation-inspector">
        {edge ? <>
          <small>这条关系</small>
          <h2>{edge.from} {edge.direction === "mutual" ? "↔" : "→"} {edge.to}</h2>
          <div className="inspector-stat"><span>什么关系</span><b>{relationLabel(edge.relation)}</b></div>
          <div className="inspector-stat"><span>几条材料支撑</span><b>{edge.signalIds.length}</b></div>
          <div className="inspector-stat"><span>最好的那条还差</span><b>{6 - edge.bestGate} 项</b></div>
          <div className="inspector-stat"><span>能不能用</span><b className={edge.executable ? "good" : "watching"}>{edge.executable ? "可以用" : "还不行"}</b></div>
          <h3>材料从哪来</h3>
          <div className="edge-sources">{evidence.map(item => { const gate = gateState(item); return <button key={item.id} onClick={() => onOpenSignal(item.id)}>
            <b>{item.title}</b>
            <span>{item.source} · {gate.executable ? "六项已齐" : `还差 ${6 - gate.passed} 项`}</span>
            {item.sourceUrl && <em>{item.sourceUrl}</em>}
          </button>; })}</div>
        </> : node ? <>
          <small>这家公司 · {graph.nodes.find(item => item.id === node)?.degree ?? 0} 条关系</small>
          <h2>{node}</h2>
          <h3>直接连着谁</h3>
          <div className="edge-sources">{focusEdges.map(item => <button key={item.key} onClick={() => setEdge(item)}>
            <b>{item.from === node ? `→ ${item.to}` : `← ${item.from}`}</b>
            <span>{relationLabel(item.relation)} · {item.bestGate === 6 ? "已确认" : `还差 ${6 - item.bestGate} 项`} · {item.signalIds.length} 条材料</span>
          </button>)}{!focusEdges.length && <span className="muted-note">当前筛选下没有关系</span>}</div>
        </> : <>
          <small>怎么看这张图</small>
          <h2>颜色 = 关系类型；实线 = 已确认，虚线 = 线索</h2>
          <div className="legend-lines">
            {RELATIONS.map(item => <span key={item.id}><i style={{ background: RELATION_COLOR[item.id] }} /><b>{item.label}</b>关系线颜色</span>)}
            <span><i style={{ background: "#ffffff" }} /><b>实线</b>六项已齐，可以进入判断</span>
            <span><i style={{ background: "rgba(126,148,170,.5)" }} /><b>虚线</b>材料还没补完</span>
          </div>
          <p className="muted-note">带框的每一组是一个关系簇：簇内是直接相连的公司，簇与簇之间没有共同主体。</p>
        </>}
      </aside>
    </div>
  </>;
}
