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
  const ratio = box.w / box.h;
  const dx = (to.x - from.x) * 100 * ratio, dy = (to.y - from.y) * 100;
  const length = Math.hypot(dx, dy);
  // 顶点要停在 to 节点的圆外面，否则被节点按钮盖住；节点是 px 尺寸，先换算成用户单位。
  const back = (nodeSize(to.degree) / 2 + 3) / (box.h / 100);
  if (!Number.isFinite(length) || length < back + 2.6) return "";
  const ux = dx / length, uy = dy / length;
  const tipX = to.x * 100 * ratio - ux * back, tipY = to.y * 100 - uy * back;
  const baseX = tipX - ux * 2, baseY = tipY - uy * 2;
  const wingX = -uy * .9, wingY = ux * .9;
  return `${tipX / ratio},${tipY} ${(baseX + wingX) / ratio},${baseY + wingY} ${(baseX - wingX) / ratio},${baseY - wingY}`;
}

export function RelationGraph({ signals, onOpenSignal }: { signals: Signal[]; onOpenSignal: (id: string) => void }) {
  const [filter, setFilter] = useState<string[]>([]);
  const [node, setNode] = useState("");
  const [edge, setEdge] = useState<GraphEdge | null>(null);
  const graph = useMemo(() => buildGraph(signals, filter), [signals, filter]);
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
    <ViewHeader kicker="ENTERPRISE RELATION GRAPH / EDGE-LEVEL PROVENANCE" title="图上没有无源之边" copy="每条边的颜色只反映支撑它的情报过了几道约束门。点边看原始出处，未过闸的关系画得出来，但不会被当成事实。" />
    <div className="relation-filters">
      <span>关系类型</span>
      {RELATIONS.map(item => <button key={item.id} className={filter.length === 0 || filter.includes(item.id) ? "on" : ""} onClick={() => toggle(item.id)}><i style={{ background: RELATION_COLOR[item.id] }} />{item.label}</button>)}
      {filter.length > 0 && <button className="clear" onClick={() => { setFilter([]); setEdge(null); }}>显示全部</button>}
      <em>{graph.nodes.length} 主体 · {graph.edges.length} 关系 · {graph.edges.filter(item => item.executable).length} 条已过闸</em>
    </div>
    <div className="relation-stage">
      <div className="relation-canvas" ref={canvas}>
        {graph.edges.length === 0 && <div className="relation-empty">还没有带关系边的情报。人工录入时填写“关系边”，或让供给管线写入候选关系。</div>}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          {graph.edges.map(item => {
            const from = graph.nodes.find(candidate => candidate.id === item.from);
            const to = graph.nodes.find(candidate => candidate.id === item.to);
            if (!from || !to) return null;
            const active = edge?.key === item.key;
            const dim = Boolean(node) && item.from !== node && item.to !== node;
            // 箭头的颜色、透明度完全跟线一致：方向是方向，可信度只由过闸数上色，箭头不许给低过闸的边加分。
            const tone = active ? "#ffffff" : edgeTone(item);
            const heads = [arrowHead(from, to, box)];
            if (item.direction === "mutual") heads.push(arrowHead(to, from, box));
            const select = () => { setEdge(item); setNode(""); };
            return <g key={item.key} opacity={dim ? .16 : 1} style={{ cursor: "pointer" }} onClick={select}>
              <line x1={from.x * 100} y1={from.y * 100} x2={to.x * 100} y2={to.y * 100}
                stroke={tone} strokeWidth={active ? 2 : item.executable ? 1.4 : 1}
                strokeDasharray={item.executable ? undefined : "3 2"} />
              {heads.map((points, index) => points && <polygon key={index} points={points} fill={tone} />)}
            </g>;
          })}
        </svg>
        {graph.nodes.map(item => {
          const size = nodeSize(item.degree);
          const related = !node || item.id === node || focusEdges.some(link => link.from === item.id || link.to === item.id);
          return <button key={item.id} className={`relation-node ${item.id === node ? "selected" : ""}`}
            style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%`, width: size, height: size, opacity: related ? 1 : .22 }}
            onClick={() => { setNode(current => current === item.id ? "" : item.id); setEdge(null); }}>
            <label>{item.id}</label>
          </button>;
        })}
      </div>
      <aside className="relation-inspector">
        {edge ? <>
          <small>EDGE PROVENANCE / {edge.relation.toUpperCase()}</small>
          <h2>{edge.from} {edge.direction === "mutual" ? "↔" : "→"} {edge.to}</h2>
          <div className="inspector-stat"><span>关系类型</span><b>{relationLabel(edge.relation)}</b></div>
          <div className="inspector-stat"><span>支撑情报</span><b>{edge.signalIds.length}</b></div>
          <div className="inspector-stat"><span>最高过闸</span><b>{edge.bestGate}/6</b></div>
          <div className="inspector-stat"><span>可执行</span><b className={edge.executable ? "good" : "watching"}>{edge.executable ? "是" : "否"}</b></div>
          <h3>原始出处</h3>
          <div className="edge-sources">{evidence.map(item => { const gate = gateState(item); return <button key={item.id} onClick={() => onOpenSignal(item.id)}>
            <b>{item.title}</b>
            <span>{item.source} · {gate.passed}/6 · {item.constraints.probability}%</span>
            {item.sourceUrl && <em>{item.sourceUrl}</em>}
          </button>; })}</div>
        </> : node ? <>
          <small>ENTITY / DEGREE {graph.nodes.find(item => item.id === node)?.degree ?? 0}</small>
          <h2>{node}</h2>
          <h3>直接关系</h3>
          <div className="edge-sources">{focusEdges.map(item => <button key={item.key} onClick={() => setEdge(item)}>
            <b>{item.from === node ? `→ ${item.to}` : `← ${item.from}`}</b>
            <span>{relationLabel(item.relation)} · {item.bestGate}/6 · {item.signalIds.length} 条情报</span>
          </button>)}{!focusEdges.length && <span className="muted-note">当前筛选下没有边</span>}</div>
        </> : <>
          <small>READ THE GRAPH</small>
          <h2>点节点看邻居，点边看出处</h2>
          <div className="legend-lines">
            <span><i style={{ background: "#41c6cc" }} /><b>实线青</b>六道门全过，可进入行动</span>
            <span><i style={{ background: "#ffad21" }} /><b>虚线黄</b>过 4–5 道，还差关键约束</span>
            <span><i style={{ background: "rgba(126,148,170,.42)" }} /><b>虚线灰</b>过闸不足，仅作候选线索</span>
          </div>
          <p className="muted-note">箭头只表示方向：单箭头是单向关系，两端都有箭头是互相关系。方向不改变可信度，颜色仍然只看过闸数。</p>
          <h3>为什么不按“置信度”上色</h3>
          <p>置信度可以被自信的措辞抬高，过闸数不行——它数的是有没有写边界、证伪条件、来源谱系和签署。</p>
        </>}
      </aside>
    </div>
  </>;
}
