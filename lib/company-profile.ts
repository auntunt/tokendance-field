// 公司档案层：报告要展示的那份东西。
//
// 为什么不塞进 field-core 的 Signal：Signal 是一条「关系判断」——
// 谁和谁有什么关系、这个判断能不能拿去做决策，它的字段全是为六道门服务的。
// 而这里是一份「公司资料」——股东、团队、融资、业务，没有主张，也就没有门可过。
// 强行合并的后果已经发生过一次：原始语料里的 founder_detail / investors / rounds
// 因为 Signal 没有地方放，导入时被整段丢掉了。所以这里另开一层。
//
// 两层的接口是单向的：档案层可以引用 Signal（同一家公司的关系判断），
// Signal 不知道档案层存在。lib/field-core.ts 不因这个文件改动一个字。

import { ALL_FIELDS, type DimensionId, type SourceGrade, type Sourced } from "./fde-dimensions";

/** 上市地。分开记而不是只记一个 boolean——「上市公司」在美股/A股/港股
 *  能拿到的披露种类完全不同（10-K vs 年报 vs 年报+披露易），抓取任务要按它分流。 */
export const LISTINGS = ["us", "cn-a", "hk", "otc", "private"] as const;
export type Listing = (typeof LISTINGS)[number];

export const LISTING_LABEL: Record<Listing, string> = {
  us: "美股",
  "cn-a": "A股",
  hk: "港股",
  otc: "挂牌/准上市",
  private: "未上市",
};

/** 和 FDE 模式的相关度。这是「前 100 家最相关」的排序依据。
 *  必须显式记录，不能靠 sector 猜——现有 207 家里绝大多数是交付商，
 *  不是 FDE 模式的实践者，两者混在一张表里会让报告失去意义。 */
export const RELEVANCE = ["practitioner", "adjacent", "vendor", "unclear"] as const;
export type Relevance = (typeof RELEVANCE)[number];

export const RELEVANCE_META: Record<Relevance, { label: string; hint: string }> = {
  practitioner: { label: "FDE 实践者", hint: "有明确的前置部署/驻场工程师组织，是我们要学的对象" },
  adjacent: { label: "近似模式", hint: "重交付、驻场、解决方案架构师主导，但没自称 FDE" },
  vendor: { label: "交付商", hint: "项目制软件交付或系统集成，模式上离 FDE 较远" },
  unclear: { label: "待判定", hint: "资料不足，无法判断模式" },
};

/** 一家公司的档案。每个维度是一组带出处的字段。 */
export type CompanyProfile = {
  id: string;
  name: string;
  /** 法定全名。和 name 分开：报告里显示简称，核对时用全名。 */
  legalName?: string;
  aliases: string[];
  listing: Listing;
  /** 股票代码，如 PLTR / 688111.SH / 0700.HK。抓取任务按它去交易所取披露。 */
  ticker?: string;
  country?: string;
  city?: string;
  sector?: string;
  relevance: Relevance;
  /** 相关度为什么是这个值。一句话，必须能被反驳。 */
  relevanceReason?: string;
  /** 维度 → 字段 key → 带出处的值。缺的就是缺的，不填占位。 */
  facts: Partial<Record<DimensionId, Record<string, Sourced>>>;
  /** 这条档案第一次进库和最后一次更新的时间，供「变更页」用。 */
  firstSeen: string;
  updatedAt: string;
  /** 从哪个语料导入的。用于回溯，不展示。 */
  origin: string;
  /** 是不是我们主动列进来盯的。
   *  存在的理由：名单条目刚建时 facts 全空，任何「按资料完整度排序」都会把它们
   *  压到最后，于是报告里一张卡都看不到——而它们恰恰是「主要盯上市公司 +
   *  有融资的创业公司」这个要求本身。主动盯的必须永远可见，哪怕整片空白，
   *  因为那片空白就是待抓清单。 */
  watchlist?: boolean;
};

export function emptyProfile(id: string, name: string): CompanyProfile {
  return { id, name, aliases: [], listing: "private", relevance: "unclear", facts: {}, firstSeen: "", updatedAt: "", origin: "" };
}

/** 取一个字段的值，取不到返回 null——不返回空字符串，
 *  免得报告把「没查到」渲染成一个看起来填过的空格。 */
export function fact(profile: CompanyProfile, dimension: DimensionId, key: string): Sourced | null {
  return profile.facts[dimension]?.[key] ?? null;
}

/** 覆盖统计。这是「我们目前收集到哪些资料」的机器答案。 */
export type Coverage = {
  /** 有值的字段数 / 全部字段数。 */
  filled: number;
  total: number;
  /** 按级别分桶。报告的热图按这个上色——同样是「有值」，
   *  法定披露和未核实的意义差得远，不能都算一格绿。 */
  byGrade: Record<SourceGrade, number>;
  byDimension: Record<string, { filled: number; total: number }>;
};

export function coverageOf(profile: CompanyProfile): Coverage {
  const byGrade: Record<SourceGrade, number> = { statutory: 0, independent: 0, self: 0, unverified: 0 };
  const byDimension: Coverage["byDimension"] = {};
  let filled = 0;
  for (const spec of ALL_FIELDS) {
    const bucket = (byDimension[spec.dimension] ||= { filled: 0, total: 0 });
    bucket.total += 1;
    const found = fact(profile, spec.dimension, spec.key);
    if (found && String(found.value).trim()) {
      byGrade[found.grade] += 1;
      // 「未核实」在报告里必须显示为空缺（lib/fde-dimensions.ts:28）。
      // 统计覆盖率时也应如此：只有 statutory / independent / self 才算填上了。
      if (found.grade !== "unverified") {
        filled += 1;
        bucket.filled += 1;
      }
    }
  }
  return { filled, total: ALL_FIELDS.length, byGrade, byDimension };
}
