// 版图测绘：主体 × 关系类型摊成一张表。
//
// 这一层回答的是「我们查过谁、查到什么程度」，不回答「谁强谁弱」。
// 它不新增门，也不碰门——只是把已入库的情报换个看法，和关系图同一性质。
//
// 热度的定义是这一层的全部要害：
//
//   热度 = 支撑这个格子的、彼此不同的材料份数，且只数独立第三方来源。
//
// 不是情报条数。条数会被转载刷高：同一份增资公告被五家媒体转发，台账里就是
// 五条，格子里显示 5，读图的人会以为"好几家都这么说"。所以先按归一化后的
// 原文把转载折叠成一份"材料"，再只数 sourceType=independent 的那些。
// 当事人自己发的公告（related）和自己打听来的（internal）不进热度——
// 它们仍然列在格子里，但抬不高这个数。和关系簇一致：看得见，不算数。
//
// 归一化规则从 normalize-text 取，与后端判重同一份代码。这不是复用洁癖：
// 两份规则一旦分叉，前端会说"两个来源"而后端说"同一份转载"，且两边都自称事实。
//
// 热度和硬度是两个数，不合并：
//   热度（heat）  = 有多少份独立材料 —— 覆盖问题
//   已齐（admitted）= 有几条过完六道门 —— 硬度问题
// 合成一个分数就会出现"材料多所以判断硬"这种推论，正是要防的。
import { RELATIONS, RelationId } from "./ontology";
import { Signal, gateState, isExpired } from "./field-core";
import { EntityKind, classifyEntity } from "./extractor";
import { normalizeCorpus } from "./normalize-text";

/**
 * 格子的三态。三态而不是两态，是这张图能不能不撒谎的关键：
 * 热力图最容易撒的谎，就是把"没查过"的格子和"查过没有"涂成同一种冷色，
 * 读的人会当成"这里没有关系"。unchecked 必须能和 no-independent 分开显示。
 */
export type CellState = "unchecked" | "no-independent" | "backed";

export type MapCell = {
  org: string;
  relation: RelationId;
  /** 落在这个格子的全部情报，含未过闸、含转载。 */
  signals: Signal[];
  /** 六道门齐且未过期的那些。硬度，和热度分开算。 */
  admitted: Signal[];
  /** 去重后的材料份数，不分来源。 */
  materials: number;
  /** 热度：独立第三方来源提供的、彼此不同的材料份数。 */
  heat: number;
  /** 被折叠掉的条数（signals.length − materials）。就是转载量。 */
  reprints: number;
  state: CellState;
};

export type MapRow = {
  org: string;
  /** 主体本体类型。非 legal 的行要在界面上标出来——
   *  「万洋众创城」是园区不是公司，不能默默当成一行竞争对手。 */
  kind: EntityKind;
  cells: MapCell[];
  heat: number;
  /** 查过的格子数（有材料的），用来看这一行还有多少空白。 */
  checked: number;
};

export type MarketMap = {
  rows: MapRow[];
  /** 没有任何关系边的情报进不了版图——它们没有「主体 × 关系」这个坐标。
   *  这些不能悄悄丢掉：丢掉就等于版图看着满了，其实材料没进来。 */
  offMap: Signal[];
  /** 一共多少份独立材料。用来判断这张图现在值不值得看。 */
  totalHeat: number;
  /** 格子总数与其中未查过的个数。空白率是这张图第一位要说的事。 */
  cellCount: number;
  uncheckedCount: number;
};

/** 材料指纹截断长度。evidence 是引文，通常几百字，4000 足够区分。 */
const MATERIAL_KEY_LIMIT = 4000;

/** 同一份材料的判定：归一化后逐字相同。和后端判重同一个标准。 */
function materialKey(signal: Signal) {
  return normalizeCorpus(signal.evidence).slice(0, MATERIAL_KEY_LIMIT);
}

function distinctMaterials(signals: Signal[]) {
  return new Set(signals.map(materialKey)).size;
}

/**
 * 一个格子里，某个主体在某类关系上被哪些情报提到。
 * 主体名按去空白比对，避免"甲电子 股份有限公司"和"甲电子股份有限公司"分成两行。
 */
function orgKey(name: string) {
  return normalizeCorpus(name);
}

/**
 * 建版图。纯函数，输入已入库的情报，输出一张表。
 * people 传人物名册的姓名，用来把人从行里排除掉。
 *
 * 主体名怎么从边上取（下面循环里那两行的依据）：
 * edge.kind 是可选字段，真实数据里大多为空（默认 org-org），所以两端都取。
 * 明确标了 person-person 的边整条跳过——人物不该成为版图的行。
 * 标了 person-org 的只取 to 端，这是 PERSON_RELATIONS 的方向约定
 * （co_serves / moved_from 都是"人 → 主体"）。
 *
 * 名册再兜一层：名册里的人绝不进版图，哪怕边上没标 kind。
 * 这比猜名字像不像人可靠——名册是人手录的事实清单。
 */
export function buildMarketMap(signals: Signal[], people: string[] = []): MarketMap {
  const roster = new Set(people.map(orgKey).filter(Boolean));
  // key = 归一化主体名，value = { 展示用原名, 每类关系下的情报 }
  const byOrg = new Map<string, { display: string; buckets: Map<RelationId, Signal[]> }>();
  const offMap: Signal[] = [];

  for (const signal of signals) {
    const edges = signal.edges || [];
    if (!edges.length) { offMap.push(signal); continue; }
    let placed = false;
    for (const edge of edges) {
      if (edge.kind === "person-person") continue;
      const relation = (RELATIONS.find(item => item.id === edge.relation)?.id) as RelationId | undefined;
      // 关系类型认不出来的边不硬塞进某一类。塞进去就是替人猜，
      // 而猜错的那一格会长出一个看着有依据的热度。
      if (!relation) continue;
      const targets = edge.kind === "person-org" ? [edge.to] : [edge.from, edge.to];
      for (const raw of targets) {
        const name = String(raw ?? "").trim();
        if (!name || roster.has(orgKey(name))) continue;
        const key = orgKey(name);
        const entry = byOrg.get(key) || { display: name, buckets: new Map<RelationId, Signal[]>() };
        const bucket = entry.buckets.get(relation) || [];
        // 同一条情报可能在一条边的两端都提到同一主体，去重。
        if (!bucket.some(item => item.id === signal.id)) bucket.push(signal);
        entry.buckets.set(relation, bucket);
        byOrg.set(key, entry);
        placed = true;
      }
    }
    if (!placed) offMap.push(signal);
  }

  const rows: MapRow[] = [...byOrg.values()].map(entry => {
    const cells = RELATIONS.map(relation => {
      const list = entry.buckets.get(relation.id) || [];
      const admitted = list.filter(signal => gateState(signal).executable && !isExpired(signal));
      const materials = distinctMaterials(list);
      const independent = list.filter(signal => signal.constraints.sourceType === "independent");
      const heat = distinctMaterials(independent);
      const state: CellState = !list.length ? "unchecked" : heat === 0 ? "no-independent" : "backed";
      return {
        org: entry.display, relation: relation.id, signals: list, admitted,
        materials, heat, reprints: list.length - materials, state,
      };
    });
    return {
      org: entry.display,
      kind: classifyEntity(entry.display, undefined),
      cells,
      heat: cells.reduce((sum, cell) => sum + cell.heat, 0),
      checked: cells.filter(cell => cell.signals.length > 0).length,
    };
  });

  // 排序只决定先看谁，不表示谁重要。独立材料多的在前，其次是查过的格子多的。
  rows.sort((a, b) => b.heat - a.heat || b.checked - a.checked || a.org.localeCompare(b.org, "zh"));

  const cellCount = rows.length * RELATIONS.length;
  return {
    rows, offMap,
    totalHeat: rows.reduce((sum, row) => sum + row.heat, 0),
    cellCount,
    uncheckedCount: rows.reduce((sum, row) => sum + row.cells.filter(cell => cell.state === "unchecked").length, 0),
  };
}

// ============ 规模判断（「多大的盘子」）============
//
// "预估收益多少、是多大的盘子"这类数字是判断，不是事实，所以它和别的判断
// 一样走六道门，这里不给它开后门。这一层只做两件事：
//   一、把情报里出现的数字原样摘出来，不换算单位、不折算币种、不取整；
//   二、按口径（scope.dataBasis）分组。
//
// 刻意不提供求和。营收口径的 3 亿和出货量口径的 3 亿加起来是 6，
// 而 6 什么也不是。界面上那句"不合计"不是偷懒，是这张表唯一诚实的算法。
// 见 tests/market-map.test.ts 里对"不导出求和函数"的断言。

/** 只有真的在谈规模的情报才进这张表，避免把随便一个日期数字当成盘子。 */
const SCALE_WORDS = ["规模", "市场", "份额", "营收", "收入", "盘子", "预估", "客单", "总量", "产值", "出货", "存量", "空间"];

/** 数字连着单位才算规模数字。裸数字（年份、编号）不要。 */
const SCALE_NUMBER = /(?:人民币|约|超过|逾|近|已达|达)?\s*\d[\d,.]*\s*(?:亿美元|万美元|亿元|万元|亿|万|千万|百万|美元|元)/g;

export type ScaleClaim = {
  signal: Signal;
  /** 原文里的数字，逐字摘出。不换算——换算就等于替人重新口径。 */
  numbers: string[];
  /** 口径。空字符串表示没写，那这个数字不可比。 */
  basis: string;
  window: string;
  admitted: boolean;
};

export function scaleClaims(signals: Signal[]): ScaleClaim[] {
  return signals.flatMap(signal => {
    const text = `${signal.title} ${signal.evidence}`;
    if (!SCALE_WORDS.some(word => text.includes(word))) return [];
    const numbers = [...new Set(text.match(SCALE_NUMBER)?.map(item => item.trim()) || [])];
    if (!numbers.length) return [];
    return [{
      signal, numbers,
      basis: signal.constraints.scope.dataBasis.trim(),
      window: signal.constraints.scope.timeWindow.trim(),
      admitted: gateState(signal).executable && !isExpired(signal),
    }];
  });
}

/**
 * 按口径分组。同口径的才放一起，没写口径的单独归成一组。
 * 返回分组，不返回总和——调用方拿不到求和的入口。
 */
export function groupByBasis(claims: ScaleClaim[]): Array<{ basis: string; claims: ScaleClaim[] }> {
  const groups = new Map<string, ScaleClaim[]>();
  for (const claim of claims) {
    const key = claim.basis || "";
    groups.set(key, [...(groups.get(key) || []), claim]);
  }
  return [...groups.entries()]
    .map(([basis, list]) => ({ basis, claims: list }))
    // 没写口径的排最后：它是待补，不是一个口径。
    .sort((a, b) => (a.basis ? 0 : 1) - (b.basis ? 0 : 1) || a.basis.localeCompare(b.basis, "zh"));
}
