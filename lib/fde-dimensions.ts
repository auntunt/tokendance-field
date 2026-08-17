// FDE 模式情报中台：维度清单与来源分级。
//
// 这个文件是「必须收集哪些信息」的唯一定义处。报告层、覆盖矩阵、抓取任务
// 全部读它，不各自维护一份——否则加一个维度要改三个地方，必然漂移。
//
// ============ 为什么报告层不走六道门 ============
// 六道门问的是「这个判断能不能拿去做决策」，需要人签字。
// 报告问的是「市面上这些公司在做什么」，它是资料，不是行动主张。
// 拿门去卡资料，结果就是实测的 0/207——不是纪律起作用，是用错了工具。
//
// 所以报告层改用**来源分级**：每条信息都带出处、级别、抓取时间。
// 读报告的人自己看着级别决定信多少，不需要谁替他签字。
// 只有当某一条要被拿去做实际决策时，才走六道门单独判——两套体系并行，互不覆盖。
// 门的定义仍然只在 lib/field-core.ts，这个文件一个字都不碰它。

/** 来源级别。排序即可信度，从高到低。 */
export const SOURCE_GRADES = ["statutory", "independent", "self", "unverified"] as const;
export type SourceGrade = (typeof SOURCE_GRADES)[number];

export const GRADE_META: Record<SourceGrade, { label: string; short: string; hint: string; tone: string }> = {
  // 法定披露：受监管、有法律责任、由第三方平台强制公开。造假有法律后果，所以最高级。
  statutory: { label: "法定披露", short: "法定", hint: "招股书 / 年报 / 10-K / 交易所公告，造假有法律后果", tone: "good" },
  // 独立第三方：发布方不是当事人，但也没有法定责任。
  independent: { label: "独立三方", short: "三方", hint: "路透 / 彭博 / 监管名录等，发布方不是当事人", tone: "ok" },
  // 企业自述：官网、通稿、招聘页。不等于假，但它给的是关系的「展示面」。
  // 实测过：真正紧张的内容，通稿会把对手方隐掉。
  self: { label: "企业自述", short: "自述", hint: "官网 / 通稿 / 招聘页，是展示面而非全貌", tone: "watching" },
  // 未核实：抄来的、二手的、或者没找到出处的。报告里必须显示为空缺，不能混入上面三级。
  unverified: { label: "未核实", short: "未核", hint: "无出处或二手转载，报告里按空缺处理", tone: "bad" },
};

/** 一条带出处的事实。报告里每个字段都是这个形状——没有裸字符串。 */
export type Sourced<T = string> = {
  value: T;
  grade: SourceGrade;
  /** 出处名称，如「Palantir 2025 年 10-K」。 */
  source: string;
  sourceUrl?: string;
  /** 抓取时间 YYYY-MM-DD。定期重跑时用它算「这条多久没更新了」。 */
  fetchedAt: string;
  /** 原文片段，逐字。用于事后复核，不参与展示。 */
  quote?: string;
  /** 归一后的短标签，用来做交叉统计；展示仍然用 value。
   *
   *  分开存的理由：value 是给人读的原话（「一体机销售+方案设计交付（累计订单 526.8 万）」），
   *  它带着信息量，不能压成枚举。但拿它做统计就只能靠正则猜，53 条会掉出分类。
   *  语料本来就带着归一好的字段（billing / sector / stage），把它放进 label，
   *  统计读 label、卡片读 value，两边都不将就。label 空着就是这条不参与交叉统计。 */
  label?: string;
};

// ============ 六个信息维度 ============
// 前五个是明确要求的，第六个（FDE 落地方式）是这整件事的真正目的——
// 前五个维度换任何一个行业都通用，只有它专门回答「他们怎么做 FDE」。
export const DIMENSION_IDS = ["shareholders", "team", "funding", "business", "fde", "background"] as const;
export type DimensionId = (typeof DIMENSION_IDS)[number];

export type FieldSpec = {
  key: string;
  label: string;
  /** 这个字段该去哪儿找。抓取任务直接读它，不靠人记。 */
  where: string;
  /** 上市公司能拿到法定披露级，创业公司通常只能拿到二手源。分开写清楚，
   *  免得把创业公司的二手数据和上市公司的法定披露放在一起比。 */
  bestGrade: { listed: SourceGrade; startup: SourceGrade };
};

export type DimensionSpec = {
  id: DimensionId;
  label: string;
  why: string;
  fields: FieldSpec[];
};

export const DIMENSIONS: DimensionSpec[] = [
  {
    id: "shareholders",
    label: "股东信息",
    why: "看谁在背后，以及这家公司的决策受谁影响。上市公司这一项是法定披露，质量最高。",
    fields: [
      { key: "majorHolders", label: "主要股东及持股比例", where: "10-K / 年报「股东情况」章节；A股看巨潮定期报告；创业公司看工商登记", bestGrade: { listed: "statutory", startup: "independent" } },
      { key: "controller", label: "实际控制人", where: "年报「控股股东及实际控制人」；创业公司看股权穿透", bestGrade: { listed: "statutory", startup: "independent" } },
      { key: "institutional", label: "机构持仓", where: "13F / 港交所披露易 / 沪深股通", bestGrade: { listed: "statutory", startup: "unverified" } },
      { key: "capTable", label: "股权结构变动", where: "招股书历史沿革；创业公司看融资新闻交叉验证", bestGrade: { listed: "statutory", startup: "self" } },
    ],
  },
  {
    id: "team",
    label: "创始人 / 核心团队",
    why: "FDE 模式极度依赖人——谁定义了交付方式，往往决定这家公司能不能做成。",
    fields: [
      { key: "founders", label: "创始人姓名与背景", where: "招股书「董事、高管」；官网 About；LinkedIn 公开档案", bestGrade: { listed: "statutory", startup: "self" } },
      { key: "execs", label: "核心高管与分工", where: "年报高管名单；官网团队页", bestGrade: { listed: "statutory", startup: "self" } },
      { key: "fdeLeads", label: "谁负责交付 / FDE 组织", where: "招聘页的岗位归属；技术博客署名；大会演讲人", bestGrade: { listed: "self", startup: "self" } },
      { key: "headcount", label: "交付团队规模", where: "年报员工构成；招聘页在招岗位数", bestGrade: { listed: "statutory", startup: "unverified" } },
      { key: "priorAffil", label: "前雇主 / 履历来源", where: "招股书履历段；公开演讲介绍", bestGrade: { listed: "statutory", startup: "independent" } },
    ],
  },
  {
    id: "funding",
    label: "融资信息",
    why: "轮次和投资方决定他们能烧多久、被推着往哪走。",
    fields: [
      { key: "rounds", label: "融资轮次与时间", where: "创业公司看 Crunchbase / 投资方官网公告；上市公司看招股书历史融资", bestGrade: { listed: "statutory", startup: "independent" } },
      { key: "amounts", label: "各轮金额与估值", where: "同上。金额常有口径差异，必须记出处", bestGrade: { listed: "statutory", startup: "independent" } },
      { key: "investors", label: "投资方名单", where: "投资方自己的官网 portfolio 页最可靠", bestGrade: { listed: "statutory", startup: "independent" } },
      { key: "marketCap", label: "市值 / 最新估值", where: "上市公司看行情；创业公司看最近一轮投后", bestGrade: { listed: "statutory", startup: "independent" } },
      { key: "revenue", label: "营收与增速", where: "10-K / 年报；创业公司基本拿不到，别硬填", bestGrade: { listed: "statutory", startup: "unverified" } },
    ],
  },
  {
    id: "business",
    label: "业务信息",
    why: "他们具体卖什么、卖给谁。这是判断「像不像 FDE」的前提。",
    fields: [
      { key: "whatTheySell", label: "产品 / 服务是什么", where: "10-K Item 1 Business；官网产品页", bestGrade: { listed: "statutory", startup: "self" } },
      { key: "customers", label: "客户类型与集中度", where: "年报「主要客户」；招股书客户集中度披露", bestGrade: { listed: "statutory", startup: "self" } },
      { key: "verticals", label: "行业垂直领域", where: "官网案例页；年报分部信息", bestGrade: { listed: "statutory", startup: "self" } },
      { key: "pricing", label: "收费模式", where: "年报收入确认政策（订阅/项目制/人天）；官网定价页", bestGrade: { listed: "statutory", startup: "self" } },
      { key: "geography", label: "地域分布", where: "年报分地区收入", bestGrade: { listed: "statutory", startup: "unverified" } },
    ],
  },
  {
    id: "fde",
    label: "FDE 模式落地方式",
    why: "这一项是做这件事的真正目的：不是知道他们存在，而是知道他们怎么把 FDE 跑起来。前五个维度换个行业照样通用，只有这一项专答此题。",
    fields: [
      { key: "fdeNaming", label: "他们怎么称呼这个角色", where: "招聘页岗位名（Forward Deployed Engineer / 解决方案架构师 / 交付工程师 / 驻场）", bestGrade: { listed: "self", startup: "self" } },
      { key: "onsiteModel", label: "驻场还是远程，驻多久", where: "招聘 JD 的工作地点与出差要求；客户案例里的项目周期", bestGrade: { listed: "self", startup: "self" } },
      { key: "orgPlacement", label: "FDE 归属哪个部门", where: "招聘页部门字段；组织架构相关报道（归工程还是归销售，决定了模式性质）", bestGrade: { listed: "independent", startup: "self" } },
      { key: "ratio", label: "交付人数与客户数之比", where: "年报员工构成 + 客户数披露，两个数相除", bestGrade: { listed: "statutory", startup: "unverified" } },
      { key: "productization", label: "从定制到产品的转化路径", where: "年报里「平台化」「标准化」相关表述；技术博客", bestGrade: { listed: "statutory", startup: "self" } },
      { key: "aiDelivery", label: "AI 在交付中怎么用", where: "技术博客；产品发布；招聘 JD 的技术栈要求", bestGrade: { listed: "self", startup: "self" } },
      { key: "jdEvidence", label: "招聘 JD 原文", where: "官网 careers / 招聘平台。这是最诚实的一手材料——JD 不像通稿那样修饰", bestGrade: { listed: "self", startup: "self" } },
    ],
  },
  {
    id: "background",
    label: "背景调查",
    why: "风险与真实性。看起来对的公司，可能正在被诉讼或已经收缩。",
    fields: [
      { key: "litigation", label: "重大诉讼与监管", where: "10-K Legal Proceedings；中国裁判文书网；证监会处罚", bestGrade: { listed: "statutory", startup: "independent" } },
      { key: "layoffs", label: "裁员 / 收缩信号", where: "独立媒体报道；招聘页岗位数骤减", bestGrade: { listed: "independent", startup: "independent" } },
      { key: "partnerships", label: "重要合作与生态位", where: "双方各自的公告，两头都要有才算实", bestGrade: { listed: "statutory", startup: "self" } },
      { key: "competitors", label: "他们自己认的对手", where: "10-K Competition 段落——这一段是他们自己写的，比外部猜测准", bestGrade: { listed: "statutory", startup: "self" } },
    ],
  },
];

/** 全部字段拉平。覆盖矩阵按这个顺序出列。 */
export const ALL_FIELDS: Array<FieldSpec & { dimension: DimensionId; dimensionLabel: string }> =
  DIMENSIONS.flatMap(dim => dim.fields.map(field => ({ ...field, dimension: dim.id, dimensionLabel: dim.label })));

export function dimensionOf(fieldKey: string) {
  return ALL_FIELDS.find(field => field.key === fieldKey);
}
