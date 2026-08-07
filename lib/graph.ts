// 企业关系图。节点=主体，边=关系。
// 图只是把已入库情报换个看法：一条边的颜色由支撑它的情报过了几道门决定，
// 没有任何一条边因为"画出来了"就获得可信度。
import { Edge, Signal, gateState } from "./field-core";

export type GraphNode = { id: string; degree: number; x: number; y: number };
export type GraphEdge = {
  key: string;
  from: string;
  to: string;
  relation: string;
  direction: "forward" | "mutual";
  signalIds: string[];
  /** 支撑这条边的情报里，过闸最多的那条过了几道门。0–6。 */
  bestGate: number;
  executable: boolean;
};

function hash(text: string) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) { value ^= text.charCodeAt(index); value = Math.imul(value, 16777619); }
  return (value >>> 0) / 4294967295;
}

export function buildGraph(signals: Signal[], relationFilter: string[]) {
  const edgeMap = new Map<string, GraphEdge>();
  const degree = new Map<string, number>();
  for (const signal of signals) {
    for (const edge of signal.edges || []) {
      if (!edge.from?.trim() || !edge.to?.trim()) continue;
      if (relationFilter.length && !relationFilter.includes(edge.relation)) continue;
      const [a, b] = [edge.from.trim(), edge.to.trim()];
      const key = `${a}→${b}·${edge.relation}`;
      const existing = edgeMap.get(key);
      const gate = gateState(signal);
      if (existing) {
        existing.signalIds.push(signal.id);
        existing.bestGate = Math.max(existing.bestGate, gate.passed);
        existing.executable = existing.executable || gate.executable;
      } else {
        edgeMap.set(key, { key, from: a, to: b, relation: edge.relation, direction: edge.direction || "forward", signalIds: [signal.id], bestGate: gate.passed, executable: gate.executable });
      }
      degree.set(a, (degree.get(a) || 0) + 1);
      degree.set(b, (degree.get(b) || 0) + 1);
    }
  }
  const edges = [...edgeMap.values()];
  const ids = [...degree.keys()].sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0) || a.localeCompare(b));
  const nodes: GraphNode[] = ids.map((id, index) => {
    // 按度数从内向外铺环，再用 id 哈希抖动，避免同环节点重叠且布局稳定可复现。
    const ring = Math.floor(index / 7);
    const angle = (index % 7) / 7 * Math.PI * 2 + ring * 0.7 + hash(id) * 0.5;
    const radius = 0.13 + ring * 0.19 + hash(`${id}r`) * 0.05;
    return { id, degree: degree.get(id) || 0, x: 0.5 + Math.cos(angle) * radius, y: 0.5 + Math.sin(angle) * radius * 0.82 };
  });
  return { nodes, edges };
}

export function edgeTone(edge: GraphEdge) {
  if (edge.executable) return "#41c6cc";
  if (edge.bestGate >= 4) return "#ffad21";
  return "rgba(126,148,170,.42)";
}

export function edgesOf(signals: Signal[]) {
  return signals.flatMap(signal => (signal.edges || []).map(edge => ({ edge, signal })));
}

export function describeEdge(edge: Edge) {
  return `${edge.from} ${edge.direction === "mutual" ? "↔" : "→"} ${edge.to}`;
}
