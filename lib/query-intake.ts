// 主动查询入口的纯函数层：术语纠错 + 实体消歧 + 维度路由。
//
// 三件事全是确定性规则，不联网，不调模型。
// 保证：相同输入相同输出——不破坏报告层 byte-comparable 的要求。
//
// 为什么不用 LLM 做消歧：bigram Jaccard 足以区分
// 「世纪互联数据中心有限公司」vs「北京世纪互联宽带数据中心有限公司」，
// 而且纯函数好测，LLM 输出不可复现。

import { classifyEntity, type EntityKind } from "./extractor";
import type { DimensionId } from "./fde-dimensions";
import type { RosterEntry } from "./fde-roster";

// ─── 术语纠错 ────────────────────────────────────────────────────────────────

type TermRule = {
  /** 匹配错误写法的正则（大小写不敏感） */
  pattern: RegExp;
  /** 替换成的正确写法 */
  right: string;
  /** 给用户看的解释 */
  note: string;
};

/**
 * 人工校正表。优先处理「字母顺序互换」类拼写错误（OPC/OCP）和
 * 常见缩写混淆（CDN/CNS、AIDC/ADCI）。
 *
 * 扩展方法：直接在这里加条目；不要做「智能」推断——
 * 推断出来的纠错比原文更容易骗人。
 */
const TERM_RULES: TermRule[] = [
  { pattern: /\bopc\b/gi, right: "OCP", note: "Open Compute Project（开放计算项目）" },
  { pattern: /\boctp\b/gi, right: "OCTC", note: "开放数据中心标准推进委员会" },
  { pattern: /\baidci?\b/gi, right: "AIDC", note: "AI Data Center（人工智能数据中心）" },
  { pattern: /\bai ?dc\b/gi, right: "AIDC", note: "AI Data Center（人工智能数据中心）" },
  { pattern: /\bopenbmc\b/gi, right: "OpenBMC", note: "开放基板管理控制器固件项目" },
  { pattern: /\bhpos\b/gi, right: "HPoS", note: "High Power over Silicon（高功率供电架构）" },
  { pattern: /\bfde工程师\b/gi, right: "前置部署工程师", note: "Forward Deployed Engineer 的中文说法" },
  { pattern: /广联达控股\b/g, right: "广联达科技股份有限公司", note: "全称；上市主体是广联达科技，不是广联达控股" },
];

export type TermCorrection = {
  /** 原始匹配到的文本 */
  original: string;
  /** 纠正后的写法 */
  corrected: string;
  /** 解释 */
  note: string;
};

export type CorrectionResult = {
  /** 纠正后的完整片段 */
  fragment: string;
  /** 每处纠错的详情列表 */
  corrections: TermCorrection[];
  /** 是否发生过任何纠错 */
  changed: boolean;
};

/**
 * 对输入片段做术语纠错。
 * 一次遍历所有规则，每条规则只报告第一次命中（避免同一个词被反复列出来）。
 */
export function correctTerms(fragment: string): CorrectionResult {
  let current = fragment;
  const corrections: TermCorrection[] = [];

  for (const rule of TERM_RULES) {
    // 用 exec 找第一处命中以记录原始写法
    const match = rule.pattern.exec(current);
    if (!match) continue;
    const original = match[0];
    // 全局替换（同一个词多处都改）
    current = current.replace(rule.pattern, rule.right);
    corrections.push({ original, corrected: rule.right, note: rule.note });
  }

  return { fragment: current, corrections, changed: corrections.length > 0 };
}

// ─── 实体名抽取 ───────────────────────────────────────────────────────────────

/**
 * 片段里跟在实体后面的「动作从句」起始标记。
 *
 * 为什么需要这一步：用户输入的是一句话（「世纪互联最近启动了OCP设计建设」），
 * 而消歧和搜索需要的是主语（「世纪互联」）。
 * 拿整句去算 bigram 相似度永远过不了阈值，拿整句去搜也搜不到东西。
 *
 * 只砍「确定是动作/时间」的词。宁可少砍留一点尾巴，
 * 也不要多砍把公司名切断——切断了就再也对不上名单了。
 */
const CLAUSE_MARKERS = [
  /最近|近期|目前|正在|已经|刚刚|日前|今年|去年|上个?月|本周/,
  /启动|宣布|发布|推出|完成|签[约下]|中标|收购|投资|融资|上市|建设|落地|开工|交付|部署|计划|拟|将要?|要做|开始/,
  /的|了|在|把|被|和|与|跟|对|向|从|给/,
];

/** 片段开头的口语铺垫，先剥掉再找实体。 */
const LEAD_NOISE = /^(我)?(刚才?|昨天|今天|前几天|之前)?(听说|听到|看到|据说|据传|传闻|好像|似乎|了解到)?[，,、：:\s]*/;

/** 实体名的合理长度上限——超过这个基本是把整句当成了名字。 */
const MAX_ENTITY_LEN = 24;

/**
 * 从一句话里抽出开头的名词短语作为实体名。
 *
 * 规则：剥掉开头铺垫 → 找最早出现的从句标记 → 取它前面的部分。
 * 若切完不足 2 字（说明标记出现在最前面，切错了），退回原片段截断版。
 *
 * 纯字符串规则，不分词不调模型：可测、可复现。
 */
export function extractEntityName(fragment: string): string {
  const trimmed = fragment.trim().replace(LEAD_NOISE, "").trim();
  if (!trimmed) return fragment.trim().slice(0, MAX_ENTITY_LEN);

  // 先按标点断句，只看第一个子句
  const firstClause = trimmed.split(/[，,。！？!?；;\n]/)[0]?.trim() || trimmed;

  let cut = firstClause.length;
  for (const marker of CLAUSE_MARKERS) {
    const m = marker.exec(firstClause);
    // 标记出现在开头（index 0）说明它不是从句分界，跳过
    if (m && m.index > 0 && m.index < cut) cut = m.index;
  }

  const head = firstClause.slice(0, cut).trim();
  if (head.length >= 2) return head.slice(0, MAX_ENTITY_LEN);
  return firstClause.slice(0, MAX_ENTITY_LEN);
}

// ─── 结果相关性探针 ───────────────────────────────────────────────────────────

/** 公司名里的地名前缀和法定后缀——都不是「这家公司叫什么」的区分性部分。 */
const GEO_PREFIX = /^(北京|上海|深圳|广州|杭州|成都|天津|重庆|南京|武汉|西安|苏州|中国)/;
const LEGAL_SUFFIX = /(股份有限公司|有限责任公司|有限公司|集团股份|集团|控股|股份|科技)$/;

/** 探针取前几个字。4 字够区分中文公司名，再长会误杀只写简称的页面。 */
const PROBE_LEN = 4;

/**
 * 从实体名里取出用来验证搜索结果相关性的「探针」。
 *
 * 取头不取尾。中文公司名的区分性在前半部分，后半部分往往是行业通用词，
 * 会在无关页面里偶然命中。实测踩过一次——用末尾两字「互联」去验「世纪互联」，
 * 世纪佳缘的页脚里有「互联网药品信息服务资格证书」，
 * 一整批降级结果就这么被判成了正常，垃圾语料直接进了抽取器。
 *
 * 先剥地名前缀和法定后缀，再取前 4 字：
 *   世纪互联数据中心有限公司 → 世纪互联数据中心 → 世纪互联
 *   北京世纪互联宽带         → 世纪互联宽带     → 世纪互联
 *   广联达科技股份有限公司   → 广联达           → 广联达
 */
export function relevanceProbe(entityName: string): string {
  const cleaned = entityName.replace(/[\s　（）()]/g, "");
  let core = cleaned.replace(GEO_PREFIX, "");
  // 后缀要反复剥：正则锚在词尾，一次只能去掉一层。
  // 「广联达科技股份有限公司」剥一次只到「广联达科技」，
  // 探针取前 4 字就成了「广联达科」——只写「广联达」的页面全部误杀。
  for (let i = 0; i < 4; i++) {
    const stripped = core.replace(LEGAL_SUFFIX, "");
    if (stripped === core) break;
    // 剥到只剩一个字就停手，再剥就没有判别力了
    if (stripped.length < 2) break;
    core = stripped;
  }
  const base = core.length >= 2 ? core : cleaned;
  return base.slice(0, PROBE_LEN);
}

/**
 * 这批结果是不是「降级结果」——搜索引擎被限流后只按查询里第一个词出结果。
 * 一条都不含探针，就认为整批跟实体无关。
 *
 * 探针不含中文时（英文名 VNET）不判定：英文不走中文分词那条降级路径。
 */
export function looksDegraded(
  entityName: string,
  results: Array<{ title: string; snippet: string }>,
): boolean {
  if (results.length === 0) return false;
  const probe = relevanceProbe(entityName);
  if (probe.length < 2 || !/[一-龥]/.test(probe)) return false;
  return !results.some(r => `${r.title} ${r.snippet}`.includes(probe));
}

/**
 * 单条结果是否跟实体有关。
 *
 * 整批判定不够：降级往往混着来——一条真命中 + 两条巧合命中，
 * 整批检查放行，那两条巧合的就进抽取器了。抽取一次要几十秒、
 * 还会写 evidence_records，所以宁可在这一层多丢几条。
 */
export function relevantToEntity(
  entityName: string,
  result: { title: string; snippet: string },
): boolean {
  const probe = relevanceProbe(entityName);
  if (probe.length < 2 || !/[一-龥]/.test(probe)) return true;
  return `${result.title} ${result.snippet}`.includes(probe);
}

// ─── Bigram 相似度 ────────────────────────────────────────────────────────────

/** 把字符串切成二元字符组（bigrams）的 Set。 */
function bigrams(s: string): Set<string> {
  const normalized = s.replace(/[\s　（）()【】《》「」、，。！？\-_]/g, "").toLowerCase();
  const result = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) result.add(normalized.slice(i, i + 2));
  return result;
}

/** Jaccard 相似度，0–1 之间。 */
export function bigramSimilarity(a: string, b: string): number {
  const sa = bigrams(a);
  const sb = bigrams(b);
  if (!sa.size && !sb.size) return 1;
  if (!sa.size || !sb.size) return 0;
  let intersection = 0;
  for (const gram of sa) if (sb.has(gram)) intersection++;
  return intersection / (sa.size + sb.size - intersection);
}

// ─── 实体消歧 ─────────────────────────────────────────────────────────────────

export type EntityCandidate = {
  id: string;
  name: string;
  legalName?: string;
  listing?: string;
  similarity: number;
  /** 候选来自哪里 */
  source: "roster" | "cache";
};

export type DisambiguationResult = {
  /** 原始查询词 */
  query: string;
  /** 推断出的实体类型 */
  kind: EntityKind;
  /** 相似度从高到低排列，最多返回 5 条 */
  candidates: EntityCandidate[];
};

const SIMILARITY_THRESHOLD = 0.3;
const MAX_CANDIDATES = 5;

/**
 * 从名单条目里找出和查询词最相似的实体。
 *
 * `rosterEntries` 由调用方（route handler）注入，而不是在这里 import fde-roster——
 * 这样 query-intake.ts 不依赖 fde-roster.ts，测试时可以独立传入最小 fixtures。
 * 同理，`cachedEntities` 是从 SQLite `query_entities` 表里读出来的历史查询实体。
 */
export function disambiguateEntity(
  query: string,
  rosterEntries: Pick<RosterEntry, "id" | "name" | "legalName" | "listing">[],
  cachedEntities: Array<{ id: string; name: string; legalName?: string }> = [],
): DisambiguationResult {
  const kind = classifyEntity(query, undefined);
  const seen = new Set<string>();
  const scored: EntityCandidate[] = [];

  for (const entry of rosterEntries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const sim = Math.max(
      bigramSimilarity(query, entry.name),
      entry.legalName ? bigramSimilarity(query, entry.legalName) : 0,
    );
    if (sim >= SIMILARITY_THRESHOLD) {
      scored.push({ id: entry.id, name: entry.name, legalName: entry.legalName, listing: entry.listing, similarity: sim, source: "roster" });
    }
  }

  for (const cached of cachedEntities) {
    if (seen.has(cached.id)) continue;
    seen.add(cached.id);
    const sim = Math.max(
      bigramSimilarity(query, cached.name),
      cached.legalName ? bigramSimilarity(query, cached.legalName) : 0,
    );
    if (sim >= SIMILARITY_THRESHOLD) {
      scored.push({ id: cached.id, name: cached.name, legalName: cached.legalName, similarity: sim, source: "cache" });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return { query, kind, candidates: scored.slice(0, MAX_CANDIDATES) };
}

// ─── 维度路由 ─────────────────────────────────────────────────────────────────

/**
 * 关键词 → 维度的映射表。
 *
 * 每个维度有两种关键词：
 * - `strong`：命中即路由，权重高
 * - `weak`：需要两个以上才触发，权重低
 *
 * 添加规则：只加「确定属于该维度」的词，不加「可能属于」的词。
 * 错误路由比漏路由更有害——用户不会再看到被错误分到别的维度的结果。
 */
const DIMENSION_ROUTING: Array<{
  id: DimensionId;
  strong: RegExp[];
  weak: RegExp[];
  /** 某些实体类型下默认选中 */
  defaultFor: EntityKind[];
}> = [
  {
    id: "shareholders",
    strong: [/股东|持股|股权|控股|实际控制人|大股东|股份|出资|注册资本/,
             /shareholder|ownership|equity stake|controller/i],
    weak: [/上市|融资|投资人/, /IPO|listing/i],
    defaultFor: [],
  },
  {
    id: "team",
    strong: [/创始人|CEO|CTO|CFO|高管|管理层|负责人|总裁|董事|联创/,
             /founder|executive|leadership|headcount/i],
    weak: [/团队|人员|招聘/, /team|hiring/i],
    defaultFor: [],
  },
  {
    id: "funding",
    strong: [/融资|估值|投资方|VC|PE|轮次|A轮|B轮|C轮|上市|IPO|并购|收购/,
             /funding|valuation|investor|series [a-z]|acquisition|M&A/i],
    weak: [/资金|财务/, /revenue|ARR/i],
    defaultFor: [],
  },
  {
    id: "business",
    strong: [/产品|方案|服务|卖|收入|客户|商业模式|营收|主营/,
             /product|solution|customer|revenue|business model/i],
    weak: [/做什么|干什么|是什么/, /what.*do|how.*work/i],
    defaultFor: ["brand", "unknown"],
  },
  {
    id: "fde",
    strong: [/前置部署|驻场|交付|FDE|forward deploy|OCP|OCTC|开放计算|数据中心|AIDC|算力|GPU集群/i,
             /工程师组织|交付工程|解决方案工程/],
    weak: [/部署|实施|现场/, /deploy|on-?site/i],
    defaultFor: [],
  },
  {
    id: "background",
    strong: [/成立|创办|历史|背景|诉讼|合规|监管|处罚|IPO招股书/,
             /founded|history|litigation|compliance|regulatory/i],
    weak: [/公司|企业/, /company|corp/i],
    defaultFor: ["legal"],
  },
];

export type RoutedDimension = {
  id: DimensionId;
  reason: string;
  confidence: "high" | "medium" | "default";
};

/**
 * 把纠错后的片段映射到 0–N 个维度，并说明为什么。
 *
 * 返回顺序：high > medium > default，同档内按 DIMENSION_ROUTING 表顺序。
 * 若没有任何命中，返回 `business` + `fde` 作为兜底（最常被查的两个）。
 */
export function routeToDimensions(fragment: string, entityKind: EntityKind): RoutedDimension[] {
  const results: RoutedDimension[] = [];

  for (const dim of DIMENSION_ROUTING) {
    let confidence: RoutedDimension["confidence"] | null = null;
    const reasons: string[] = [];

    for (const pat of dim.strong) {
      const match = pat.exec(fragment);
      if (match) { confidence = "high"; reasons.push(`关键词「${match[0]}」`); break; }
    }

    if (!confidence) {
      let weakHits = 0;
      const hitWords: string[] = [];
      for (const pat of dim.weak) {
        const match = pat.exec(fragment);
        if (match) { weakHits++; hitWords.push(match[0]); }
      }
      if (weakHits >= 2) { confidence = "medium"; reasons.push(`弱信号「${hitWords.join("」「")}」`); }
    }

    if (!confidence && dim.defaultFor.includes(entityKind)) {
      confidence = "default";
      reasons.push(`实体类型 ${entityKind} 的默认维度`);
    }

    if (confidence) {
      results.push({ id: dim.id, reason: reasons.join("；"), confidence });
    }
  }

  if (!results.length) {
    results.push(
      { id: "business", reason: "兜底：无明确维度信号，先查产品线", confidence: "default" },
      { id: "fde", reason: "兜底：无明确维度信号，先查 FDE 相关", confidence: "default" },
    );
  }

  // high 排前，然后 medium，然后 default
  const ORDER = { high: 0, medium: 1, default: 2 };
  results.sort((a, b) => ORDER[a.confidence] - ORDER[b.confidence]);

  return results;
}

// ─── 搜索词生成 ───────────────────────────────────────────────────────────────

const DIMENSION_SEARCH_HINTS: Record<DimensionId, string[]> = {
  shareholders: ["股东 持股", "控股 股权结构"],
  team: ["创始人 管理团队", "CEO 高管"],
  funding: ["融资 估值", "投融资 股权"],
  business: ["产品 业务", "主营 营收"],
  fde: ["前置部署 交付", "数据中心 算力"],
  background: ["公司简介 成立", "上市 背景"],
};

export type SearchTask = {
  entityName: string;
  dimension: DimensionId;
  /** 用于拼 Bing 查询的字符串 */
  query: string;
  /** 这条搜索词是怎么来的，显示给用户 */
  kind: "anchor" | "salient" | "dimension" | "clue";
};

/** 从片段里挑出「值得带进搜索」的独有词。 */
const SALIENT_PATTERNS: RegExp[] = [
  // 全大写缩写（OCP / AIDC / GPU），2–8 个字母，可带数字
  /\b[A-Z][A-Z0-9]{1,7}\b/g,
  // 型号类（H100 / A800）
  /\b[A-Z]{1,3}\d{2,4}\b/g,
];

/** 大写缩写里那些太泛、带进查询只会污染结果的词。 */
const SALIENT_STOPWORDS = new Set(["CEO", "CTO", "CFO", "COO", "IPO", "VC", "PE", "AI", "IT", "CN", "US", "PDF", "URL"]);

/**
 * 抽出片段自身的关键词。
 *
 * 存在理由：维度提示词（「前置部署 交付」）是通用的，
 * 而用户真正想知道的往往是片段里那个具体的词（OCP）。
 * 只靠维度提示搜，等于把用户的问题丢了。
 *
 * 从 `entityName` 里出现过的词要排除——那是实体的一部分，不是新信息。
 */
export function salientTerms(fragment: string, entityName = ""): string[] {
  const found = new Set<string>();
  for (const pat of SALIENT_PATTERNS) {
    // 正则带 g，exec 前重置 lastIndex，避免跨调用串状态
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(fragment)) !== null) {
      const term = m[0];
      if (SALIENT_STOPWORDS.has(term)) continue;
      if (entityName.toUpperCase().includes(term)) continue;
      found.add(term);
    }
  }
  return [...found].slice(0, 3);
}

/**
 * 一轮查询最多几个搜索词。
 *
 * 这个数不是「够不够用」定的，是被搜索引擎限流间隔倒推出来的：
 * 每多一条搜索词就多等一次间隔，整轮时间必须压在浏览器和反向代理
 * 的默认超时（普遍 5 分钟）以内，否则连接会在拿到结果前被掐断。
 * 解析阶段和执行阶段必须用同一个数，否则确认面板上列出的搜索词
 * 会有一部分根本不会执行。
 */
export const MAX_SEARCH_TASKS = 4;

/**
 * 给一个实体 + 维度列表生成搜索任务。
 *
 * 三类搜索词，按可靠性排序：
 *   anchor    —— 裸实体名。最稳，用来确认实体存在、拿到工商/百科/官网页面。
 *   salient   —— 实体 + 片段自己的关键词（OCP）。用户真正问的那件事。
 *   dimension —— 实体 + 维度通用提示。补齐结构化字段。
 *
 * anchor 放第一位是有代价考虑的：搜索引擎对「中文短名 + 低共现外来词」
 * 的组合会放宽分词，返回完全无关的结果（世纪互联 + OCP → 别克世纪轿车）。
 * 先跑 anchor 保证至少有一条可靠语料，salient 失败也不至于整次查询空手而归。
 */
export function buildSearchTasks(
  entityName: string,
  dimensions: RoutedDimension[],
  maxTotal = 6,
  fragmentSalient: string[] = [],
): SearchTask[] {
  const tasks: SearchTask[] = [];
  const push = (dimension: DimensionId, query: string, kind: SearchTask["kind"]) => {
    if (tasks.length >= maxTotal) return;
    if (tasks.some(t => t.query === query)) return;
    tasks.push({ entityName, dimension, query, kind });
  };

  const primary = dimensions[0]?.id ?? "background";

  // 1. 锚定查询：只有实体名
  push(primary, entityName, "anchor");

  // 2. 片段关键词
  for (const term of fragmentSalient) push(primary, `${entityName} ${term}`, "salient");

  // 3. 维度提示词
  for (const dim of dimensions) {
    const hints = DIMENSION_SEARCH_HINTS[dim.id] || [];
    for (const hint of hints.slice(0, 2)) push(dim.id, `${entityName} ${hint}`, "dimension");
    if (tasks.length >= maxTotal) break;
  }

  return tasks;
}

// ─── 整合：单次查询解析 ───────────────────────────────────────────────────────

export type QueryParseResult = {
  correction: CorrectionResult;
  /** 从片段里抽出来的实体名（未经名单确认） */
  extractedName: string;
  disambiguation: DisambiguationResult;
  dimensions: RoutedDimension[];
  /** 片段自身的关键词，会被带进搜索 */
  salient: string[];
  /** 实际用来搜索的实体名：名单命中则用名单名，否则用抽出来的名 */
  entityName: string;
  searchTasks: SearchTask[];
  /** 是否需要用户确认（有纠错 OR 消歧候选 > 1 OR 名单里没这家） */
  needsConfirmation: boolean;
};

export function parseQuery(
  rawFragment: string,
  rosterEntries: Pick<RosterEntry, "id" | "name" | "legalName" | "listing">[],
  cachedEntities: Array<{ id: string; name: string; legalName?: string }> = [],
): QueryParseResult {
  const correction = correctTerms(rawFragment);
  // 先抽实体名再消歧：拿整句去算 bigram 相似度永远过不了阈值
  const extractedName = extractEntityName(correction.fragment);
  const disambiguation = disambiguateEntity(extractedName, rosterEntries, cachedEntities);
  // 维度路由看整个片段——动作从句里才有维度信号（「启动了OCP设计建设」）
  const dimensions = routeToDimensions(correction.fragment, disambiguation.kind);
  const entityName = disambiguation.candidates[0]?.name ?? extractedName;
  const salient = salientTerms(correction.fragment, entityName);
  const searchTasks = buildSearchTasks(entityName, dimensions, MAX_SEARCH_TASKS, salient);
  // 名单里查不到也要确认：这时 entityName 是规则抽出来的，用户最该看一眼的就是它
  const needsConfirmation =
    correction.changed || disambiguation.candidates.length !== 1;

  return { correction, extractedName, disambiguation, dimensions, salient, entityName, searchTasks, needsConfirmation };
}
