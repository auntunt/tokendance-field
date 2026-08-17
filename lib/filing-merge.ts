// 把一次抓取的结果合并进已有的 data/filing-facts.json。
//
// 为什么需要这个文件（真出过事）：
// scripts/fetch-filings.mjs 原来是直接 writeFileSync(outFile, { companies: 本次结果 })。
// 全量跑没问题，但 `--only 301236` 只跑一家时，本次结果只有一条，
// 于是整份产物从 13 家变成 1 家——另外 12 家的事实被静默抹掉。
// 今天调试的时候就这么干过一次。抹掉不报错、不留痕，下一次 build-report
// 只会显示覆盖率暴跌，得回头查很久才知道是抓取脚本干的。
//
// 合并规则，以及每条为什么这么定：
// 1. 公司按 id 合并，不是整份替换。这是 bug 的直接修复。
// 2. 同一家公司的 facts 按「维度 → 字段」两层合并，不是整块替换。
//    因为年报路线（statutory）和东方财富路线（independent）都往
//    shareholders 维度里写，但写的是不同字段：年报给 controller，
//    接口给 majorHolders/institutional/capTable。整块替换会让两条路线互删。
// 3. 同字段冲突时，本次结果覆盖旧值——但**只在定级不降级时**。抓取是幂等重跑，
//    新的通常就是更新的；可是两条来源路线抢同一个字段时，"新" 不等于 "更可信"。
//    这条是补出来的（真出过事）：年报路线给科大讯飞的 shareholders.majorHolders
//    写了 statutory 的「无控股主体」，东方财富路线随后用 independent 的
//    十大流通股东名单把它顶掉了。合并前 54 条 statutory，合并后 50 条——
//    静默丢了 4 条最高可信度的事实，报告上只会表现为出处降级，不报错。
//    所以：低定级不许覆盖高定级，同定级才按"新的赢"。
// 4. fetchedAt 取两者较大者（字符串比较，YYYY-MM-DD 字典序即时间序）。
//    单跑一家不该把整份产物的时间戳往前拨——那会让报告显示的「数据新鲜度」失真。
// 5. failures 只覆盖本次真正跑过的公司。旧的失败记录如果这次没跑，
//    要保留：它仍然是「这家至今抓不到」的事实。这次跑过的公司，
//    无论成败都以本次为准（上次失败这次成功，旧记录必须消失）。

import type { DimensionId, Sourced } from "./fde-dimensions";

export type FactMap = Partial<Record<DimensionId, Record<string, Sourced>>>;

export type CompanyFacts = {
  id: string;
  name: string;
  ticker?: string;
  filing: { title: string; date: string; url: string };
  facts: FactMap;
  /**
   * 标记「本条的 filing 只是补充来源的说明，不是法定披露原文」。
   * 用在只拿到东方财富股东数据、年报却没抓到的公司上：
   * 这种情况下不能把已有的年报出处覆盖成接口说明，
   * 否则报告上会显示这家公司的出处是东方财富，而实际上那些
   * statutory 事实来自年报——出处错配比缺出处更糟。
   */
  keepFiling?: boolean;
};

export type Failure = { name: string; why: string; id?: string };

export type FilingFactsFile = {
  fetchedAt: string;
  companies: CompanyFacts[];
  failures: Failure[];
};

export const EMPTY_FILING_FACTS: FilingFactsFile = { fetchedAt: "", companies: [], failures: [] };

/**
 * 定级高低。数字越大越可信，用于判断一次覆盖是不是降级。
 * 顺序和 lib/fde-dimensions.ts 的 SourceGrade 一致：
 * 法定披露 > 独立三方 > 企业自述 > 未核实。
 */
const GRADE_RANK: Record<string, number> = { statutory: 4, independent: 3, self: 2, unverified: 1 };

const rankOf = (entry: Sourced | undefined): number =>
  entry?.grade ? (GRADE_RANK[entry.grade] ?? 0) : 0;

/** 两层深合并 facts：维度层合并，字段层由 next 覆盖 prev（除非会降级，见文件头规则 3） */
export function mergeFacts(prev: FactMap, next: FactMap): FactMap {
  const out: FactMap = {};
  const dims = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
  // 排序是为了确定性：产物文件每次重跑的 key 顺序必须一样，
  // 否则 git diff / 快照 diff 里会出现一堆纯顺序变化的假改动。
  for (const dim of [...dims].sort()) {
    const key = dim as DimensionId;
    const before = prev[key] ?? {};
    const after = next[key] ?? {};
    const merged: Record<string, Sourced> = { ...before };
    for (const [field, incoming] of Object.entries(after)) {
      const existing = merged[field];
      // 降级则拒绝覆盖：保留旧的高定级事实。
      if (existing && rankOf(incoming) < rankOf(existing)) continue;
      merged[field] = incoming;
    }
    const ordered: Record<string, Sourced> = {};
    for (const field of Object.keys(merged).sort()) ordered[field] = merged[field];
    if (Object.keys(ordered).length > 0) out[key] = ordered;
  }
  return out;
}

/**
 * 合并入口。
 * @param previous 已落盘的产物（读不到时传 EMPTY_FILING_FACTS）
 * @param incoming 本次抓到的公司
 * @param failures 本次失败的公司
 * @param fetchedAt 本次抓取日期
 * @param touchedIds 本次真正跑过的公司 id（含成功与失败）。
 *        必须由调用方显式给出：只从 incoming 推断的话，
 *        「这次跑了但失败了」和「这次根本没跑」就分不开，
 *        旧的成功记录会被错误保留或错误删除。
 */
export function mergeFilingFacts(
  previous: FilingFactsFile,
  incoming: CompanyFacts[],
  failures: Failure[],
  fetchedAt: string,
  touchedIds: string[],
): FilingFactsFile {
  const touched = new Set(touchedIds);
  const byId = new Map<string, CompanyFacts>();
  const order: string[] = [];

  for (const company of previous.companies ?? []) {
    if (!company?.id) continue;
    byId.set(company.id, company);
    order.push(company.id);
  }

  for (const company of incoming) {
    const old = byId.get(company.id);
    if (old) {
      byId.set(company.id, {
        ...old,
        name: company.name,
        ticker: company.ticker ?? old.ticker,
        // filing 元信息整体取新：它描述的是「这次取到的是哪份文件」。
        // 例外见 keepFiling 的注释：补充来源不许改写已有的法定披露出处。
        filing: company.keepFiling ? old.filing : company.filing,
        facts: mergeFacts(old.facts ?? {}, company.facts ?? {}),
      });
    } else {
      byId.set(company.id, company);
      order.push(company.id);
    }
  }

  // 旧失败记录里，这次跑过的都丢掉（本次结果才是现状）；没跑过的保留
  const keptFailures = (previous.failures ?? []).filter(f => !f.id || !touched.has(f.id));
  const newest = fetchedAt > (previous.fetchedAt ?? "") ? fetchedAt : previous.fetchedAt ?? "";

  return {
    fetchedAt: newest,
    companies: order.map(id => byId.get(id)).filter((c): c is CompanyFacts => !!c),
    failures: [...keptFailures, ...failures],
  };
}

/** 统计某个定级的事实条数，脚本和测试都用它，避免两处各算一遍算出不同数 */
export function countByGrade(file: FilingFactsFile, grade: string): number {
  let total = 0;
  for (const company of file.companies ?? []) {
    for (const dim of Object.values(company.facts ?? {})) {
      for (const entry of Object.values(dim ?? {})) {
        if (entry?.grade === grade) total += 1;
      }
    }
  }
  return total;
}
