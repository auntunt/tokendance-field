// 报告的数据层：把一堆档案聚合成「概览热图 / 公司卡 / 变更页」三块。
// 纯函数，不联网、不读盘。渲染在 report-html.ts，这里只算数。

import { ALL_FIELDS, DIMENSIONS, SOURCE_GRADES, type DimensionId, type SourceGrade } from "./fde-dimensions";
import { coverageOf, fact, type CompanyProfile, type Listing, type Relevance } from "./company-profile";

export type GradeTally = Record<SourceGrade, number>;

function emptyTally(): GradeTally {
  return { statutory: 0, independent: 0, self: 0, unverified: 0 };
}

/** 概览：整份报告的一句话现状。 */
export type Overview = {
  companies: number;
  fields: number;
  cells: number;
  filled: number;
  byGrade: GradeTally;
  byListing: Record<string, number>;
  byRelevance: Record<string, number>;
  /** 逐维度 × 逐字段的覆盖，热图直接铺这个。 */
  matrix: Array<{
    dimension: DimensionId;
    dimensionLabel: string;
    fields: Array<{ key: string; label: string; where: string; filled: number; byGrade: GradeTally }>;
  }>;
};

export function buildOverview(profiles: CompanyProfile[]): Overview {
  const byGrade = emptyTally();
  const byListing: Record<string, number> = {};
  const byRelevance: Record<string, number> = {};
  let filled = 0;
  for (const profile of profiles) {
    const cover = coverageOf(profile);
    filled += cover.filled;
    for (const grade of SOURCE_GRADES) byGrade[grade] += cover.byGrade[grade];
    byListing[profile.listing] = (byListing[profile.listing] || 0) + 1;
    byRelevance[profile.relevance] = (byRelevance[profile.relevance] || 0) + 1;
  }
  const matrix = DIMENSIONS.map(dim => ({
    dimension: dim.id,
    dimensionLabel: dim.label,
    fields: dim.fields.map(field => {
      const tally = emptyTally();
      let count = 0;
      for (const profile of profiles) {
        const entry = fact(profile, dim.id, field.key);
        if (entry && String(entry.value).trim()) { count += 1; tally[entry.grade] += 1; }
      }
      return { key: field.key, label: field.label, where: field.where, filled: count, byGrade: tally };
    }),
  }));
  return {
    companies: profiles.length,
    fields: ALL_FIELDS.length,
    cells: profiles.length * ALL_FIELDS.length,
    filled, byGrade, byListing, byRelevance, matrix,
  };
}

/** 排序：资料越全、级别越硬的排前面。相关度高的加权——
 *  报告是给人读的，最该先看到的是「像 FDE 且查得清楚」的那些。 */
const RELEVANCE_WEIGHT: Record<Relevance, number> = { practitioner: 40, adjacent: 24, vendor: 6, unclear: 0 };
const GRADE_WEIGHT: Record<SourceGrade, number> = { statutory: 5, independent: 3, self: 1, unverified: 0 };

export function rankScore(profile: CompanyProfile): number {
  const cover = coverageOf(profile);
  let score = RELEVANCE_WEIGHT[profile.relevance];
  for (const grade of SOURCE_GRADES) score += cover.byGrade[grade] * GRADE_WEIGHT[grade];
  return score;
}

/** 上市公司排在前面，不管它现在有没有资料。
 *
 *  第一版没这条，结果是新补的 24 家上市公司一张卡都没露面——它们 facts 全空、
 *  相关度全是待判定，分数 0，被 207 家有资料的国内交付商全压在后面。
 *  但「主要盯上市公司」正是这件事的重点，而且法定披露只能从它们身上拿到。
 *  一份查得最全、级别最硬的报告，如果 Palantir 和科大讯飞根本不出现，那就是没做到。
 *  所以排序先按上市地分档，档内再按资料完整度——空着的上市公司会显示成
 *  一整片「整项未核实」，那正是它该有的样子：一份待抓清单，而不是被藏起来。 */
const LISTING_TIER: Record<Listing, number> = { us: 0, "cn-a": 0, hk: 0, otc: 1, private: 2 };

/** 分档：主动盯的（含未上市的重点创业公司）最先，然后上市公司，然后其余。
 *  watchlist 单独一档而不是只靠上市地，是因为 Databricks / Scale AI / 智谱
 *  这些未上市但明确要盯的公司，按上市地会掉到最后一档，和 198 家有资料的
 *  存量公司抢位置——而它们正是「同时覆盖有投融资的创业公司」那一条要求。 */
function tierOf(profile: CompanyProfile): number {
  if (profile.watchlist) return LISTING_TIER[profile.listing] === 0 ? 0 : 1;
  return 2 + LISTING_TIER[profile.listing];
}

export function rankProfiles(profiles: CompanyProfile[]): CompanyProfile[] {
  return [...profiles].sort((a, b) =>
    tierOf(a) - tierOf(b)
    || rankScore(b) - rankScore(a)
    || a.name.localeCompare(b.name, "zh"));
}

/** 变更页。上一版和这一版比，只报三种事：新增公司、新增字段、字段变了值。
 *  「字段消失」也报——一条事实从报告里没了，本身就是要解释的事。 */
export type Change =
  | { kind: "company-added"; id: string; name: string }
  | { kind: "company-dropped"; id: string; name: string }
  | { kind: "fact-added"; id: string; name: string; dimension: DimensionId; field: string; grade: SourceGrade; value: string }
  | { kind: "fact-changed"; id: string; name: string; dimension: DimensionId; field: string; from: string; to: string; grade: SourceGrade }
  | { kind: "fact-dropped"; id: string; name: string; dimension: DimensionId; field: string; was: string }
  | { kind: "grade-changed"; id: string; name: string; dimension: DimensionId; field: string; from: SourceGrade; to: SourceGrade };

export function diffProfiles(before: CompanyProfile[], after: CompanyProfile[]): Change[] {
  const changes: Change[] = [];
  const oldById = new Map(before.map(item => [item.id, item]));
  const newById = new Map(after.map(item => [item.id, item]));

  for (const profile of after) {
    if (!oldById.has(profile.id)) { changes.push({ kind: "company-added", id: profile.id, name: profile.name }); }
  }
  for (const profile of before) {
    if (!newById.has(profile.id)) { changes.push({ kind: "company-dropped", id: profile.id, name: profile.name }); }
  }

  for (const profile of after) {
    const old = oldById.get(profile.id);
    if (!old) continue; // 新公司的字段不逐条报，否则变更页会被一家新公司刷满
    for (const spec of ALL_FIELDS) {
      const now = fact(profile, spec.dimension, spec.key);
      const then = fact(old, spec.dimension, spec.key);
      const base = { id: profile.id, name: profile.name, dimension: spec.dimension, field: spec.label };
      if (now && !then) { changes.push({ kind: "fact-added", ...base, grade: now.grade, value: String(now.value) }); continue; }
      if (!now && then) { changes.push({ kind: "fact-dropped", ...base, was: String(then.value) }); continue; }
      if (!now || !then) continue;
      if (String(now.value) !== String(then.value)) {
        changes.push({ kind: "fact-changed", ...base, from: String(then.value), to: String(now.value), grade: now.grade });
      } else if (now.grade !== then.grade) {
        // 值没变但级别变了：通常是「原来只有通稿，现在找到年报了」。
        // 这是报告里最有价值的一种进展，必须单独报出来。
        changes.push({ kind: "grade-changed", ...base, from: then.grade, to: now.grade });
      }
    }
  }
  return changes;
}

/** 该去查什么：按「缺口 × 能查到的最高级别」排出待办。
 *  这是无人化的输入——抓取器读它决定下一轮抓哪些字段，不需要人排任务。 */
export type Gap = { id: string; name: string; listing: Listing; dimension: DimensionId; field: string; key: string; where: string; reachable: SourceGrade };

const GAP_RANK: Record<SourceGrade, number> = { statutory: 0, independent: 1, self: 2, unverified: 3 };

/** 每家公司在待办表里最多占几行。
 *  没有这个上限时，9 家挂牌公司各有 20 个可达法定披露的空字段，
 *  一共 180 行就把 60 行的表填满了——名单里 24 家上市公司一行都排不上。
 *  待办的用途是「下一轮抓什么」，广度比深度重要：先让每家都抓到几个硬字段，
 *  比把一家抓穷了更有用。 */
const GAP_PER_COMPANY = 4;

export function findGaps(profiles: CompanyProfile[], limit = 200): Gap[] {
  const perCompany: Gap[][] = [];
  for (const profile of rankProfiles(profiles)) {
    const listedKind = profile.listing === "private" ? "startup" : "listed";
    const mine: Gap[] = [];
    for (const spec of ALL_FIELDS) {
      if (fact(profile, spec.dimension, spec.key)) continue;
      const reachable = spec.bestGrade[listedKind];
      if (reachable === "unverified") continue; // 查不到的不列进待办，列了只是噪音
      mine.push({ id: profile.id, name: profile.name, listing: profile.listing, dimension: spec.dimension, field: spec.label, key: spec.key, where: spec.where, reachable });
    }
    mine.sort((a, b) => GAP_RANK[a.reachable] - GAP_RANK[b.reachable]);
    if (mine.length) perCompany.push(mine.slice(0, GAP_PER_COMPANY));
  }
  // 轮转取：先给每家取最硬的一条，再取第二条……这样表的前几十行覆盖尽量多的公司。
  const gaps: Gap[] = [];
  for (let round = 0; round < GAP_PER_COMPANY && gaps.length < limit; round += 1) {
    for (const mine of perCompany) {
      if (gaps.length >= limit) break;
      if (mine[round]) gaps.push(mine[round]);
    }
  }
  return gaps;
}
