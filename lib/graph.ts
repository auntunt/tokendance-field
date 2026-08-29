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

function layoutGraph(ids: string[], degree: Map<string, number>, edges: GraphEdge[]): GraphNode[] {
  if (!ids.length) return [];
  if (ids.length === 1) return [{ id: ids[0], degree: degree.get(ids[0]) || 0, x: 0.5, y: 0.5 }];

  // 1. 切连通分量：不同关系簇各自布局，不再把所有公司揉成一团。
  const adjacent = new Map<string, Set<string>>();
  for (const id of ids) adjacent.set(id, new Set());
  for (const edge of edges) {
    adjacent.get(edge.from)?.add(edge.to);
    adjacent.get(edge.to)?.add(edge.from);
  }
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of ids) {
    if (visited.has(id)) continue;
    const stack = [id];
    const component: string[] = [];
    visited.add(id);
    while (stack.length) {
      const current = stack.pop()!;
      component.push(current);
      for (const next of adjacent.get(current) || []) {
        if (!visited.has(next)) { visited.add(next); stack.push(next); }
      }
    }
    component.sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0) || a.localeCompare(b));
    components.push(component);
  }
  components.sort((a, b) => b.length - a.length);

  // 2. 每个分量内部做确定性力导向布局：相连的靠近、不相连的推开、整体向中心收拢。
  function layoutComponent(component: string[]): Map<string, { x: number; y: number }> {
    const positions = new Map<string, { x: number; y: number }>();
    for (const id of component) {
      positions.set(id, {
        x: 0.5 + Math.cos(hash(id) * Math.PI * 2) * 0.22,
        y: 0.5 + Math.sin(hash(id) * Math.PI * 2) * 0.22,
      });
    }
    const area = 0.42 / Math.sqrt(Math.max(1, component.length));
    const rest = component.length <= 3 ? 0.2 : 0.16;
    const iterations = component.length < 12 ? 90 : 130;
    for (let step = 0; step < iterations; step++) {
      const displacement = new Map<string, { x: number; y: number }>();
      for (const id of component) displacement.set(id, { x: 0, y: 0 });

      for (let i = 0; i < component.length; i++) {
        for (let j = i + 1; j < component.length; j++) {
          const a = component[i], b = component[j];
          const pa = positions.get(a)!, pb = positions.get(b)!;
          let dx = pa.x - pb.x, dy = pa.y - pb.y;
          let distance = Math.hypot(dx, dy);
          if (distance < 0.0001) { dx = (hash(a + b) - 0.5) * 0.01; dy = (hash(b + a) - 0.5) * 0.01; distance = Math.hypot(dx, dy); }
          const force = Math.min(0.04, area * area / distance * 0.045);
          const fx = dx / distance * force, fy = dy / distance * force;
          displacement.get(a)!.x += fx; displacement.get(a)!.y += fy;
          displacement.get(b)!.x -= fx; displacement.get(b)!.y -= fy;
        }
      }
      for (const edge of edges) {
        if (!component.includes(edge.from) || !component.includes(edge.to)) continue;
        const pa = positions.get(edge.from)!, pb = positions.get(edge.to)!;
        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const distance = Math.hypot(dx, dy) || 0.0001;
        const force = (distance - rest) * 0.055;
        const fx = dx / distance * force, fy = dy / distance * force;
        displacement.get(edge.from)!.x += fx; displacement.get(edge.from)!.y += fy;
        displacement.get(edge.to)!.x -= fx; displacement.get(edge.to)!.y -= fy;
      }
      for (const id of component) {
        const p = positions.get(id)!, d = displacement.get(id)!;
        d.x += (0.5 - p.x) * 0.02;
        d.y += (0.5 - p.y) * 0.02;
        const len = Math.hypot(d.x, d.y);
        if (len > 0.045) { d.x = d.x / len * 0.045; d.y = d.y / len * 0.045; }
        p.x += d.x; p.y += d.y;
      }
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of positions.values()) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const spanX = Math.max(0.001, maxX - minX), spanY = Math.max(0.001, maxY - minY);
    for (const [id, p] of positions) {
      positions.set(id, {
        x: 0.08 + ((p.x - minX) / spanX) * 0.84,
        y: 0.08 + ((p.y - minY) / spanY) * 0.84,
      });
    }
    return positions;
  }

  // 3. 货架式排布：大簇占一整行，小簇按 1/2、1/4 宽度拼进同一行。
  //    小簇不再被等面积网格强行放大，2–3 个节点的簇只占画布一角。
  const slotOf = (size: number) => (size >= 7 ? 1 : size >= 4 ? 0.5 : 0.25);
  const bins: Array<{ components: string[][]; used: number; largest: number }> = [];
  const localLayouts = components.map(component => ({ component, local: layoutComponent(component), slot: slotOf(component.length) }));
  localLayouts.sort((a, b) => b.component.length - a.component.length || b.slot - a.slot);
  for (const item of localLayouts) {
    const bin = bins.find(candidate => candidate.used + item.slot <= 1.0001);
    if (bin) {
      bin.components.push(item.component);
      bin.used += item.slot;
      bin.largest = Math.max(bin.largest, item.component.length);
    } else {
      bins.push({ components: [item.component], used: item.slot, largest: item.component.length });
    }
  }
  // 大簇需要更深的行。之前所有行等高，即使外层画布被拉长，19 个节点的大簇
  // 仍会和 2 个节点的小簇拿到同样空间，所以拥挤始终留在顶部。
  const rowWeight = (size: number) => size >= 10 ? 280 : size >= 7 ? 235 : size >= 4 ? 185 : 150;
  const totalWeight = Math.max(1, bins.reduce((sum, bin) => sum + rowWeight(bin.largest), 0));
  const nodes: GraphNode[] = [];
  let rowTop = 0;
  bins.forEach(bin => {
    const rowHeight = rowWeight(bin.largest) / totalWeight;
    let cursor = 0;
    for (const component of bin.components) {
      const item = localLayouts.find(entry => entry.component === component)!;
      const local = item.local;
      const boxW = item.slot;
      for (const id of component) {
        const p = local.get(id)!;
        const x = cursor + p.x * boxW * 0.84 + boxW * 0.08;
        const y = rowTop + p.y * rowHeight * 0.76 + rowHeight * 0.12;
        nodes.push({ id, degree: degree.get(id) || 0, x: Math.min(0.975, Math.max(0.025, x)), y: Math.min(0.975, Math.max(0.025, y)) });
      }
      cursor += item.slot;
    }
    rowTop += rowHeight;
  });
  return nodes.sort((a, b) => a.id.localeCompare(b.id));
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
  const nodes = layoutGraph(ids, degree, edges);
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
