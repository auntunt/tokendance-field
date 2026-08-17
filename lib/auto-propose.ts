// 自动提议约束字段。纯函数，不联网，不调模型——只从已有的语料、来源 URL 和边推。
//
// 为什么需要这个文件：实测 60 条真实情报，0 条过闸。原因不是纪律严，是门 5 要求
// validUntil 非空，而全项目没有任何地方提议过一个日期（grep validUntil 只有类型定义、
// 数据库读写、和一个 <input type="date">）。人不手打日期，60 条就永远卡在第 5 道门，
// 哪怕把「采纳模型建议」在每条上都点一遍也一样。
//
// 边界，写死在这里免得以后漂移：
// 1. 这里只**提议**，不签署。门 6 仍然只能由人过。机器把能算的算完，人只做那一下判断。
// 2. 提议不许伪造确定性。推不出来的字段留空，让门继续挡着——留空比填「未知」诚实，
//    因为门 2 只看字符串非空，「未知」会假过闸。见 field-core 的 isPlaceholder。
// 3. ourAccess（我方能拿它做什么）永远不提议。那是关于我们自己的能力的判断，
//    语料里不可能有。机器猜这个字段就是在替人做决定。
// 4. sourceType 也不提议，只给一句提示。理由同 signedOff：来源谱系是关于"这个渠道
//    可不可信"的判断，而 independent 不只影响门 5——lib/market-map.ts 还按它筛
//    可信来源。让管线自己把来源标成 independent，就是让它自我认证强来源。
//    门 5 只要求 sourceType 不是 unknown，related 一样能过闸，所以提议它没有收益、
//    只有风险。是不是"独立第三方"由人在面板上点。
import type { Constraints } from "./field-core";
import type { LocalScope } from "./ontology";

export type ProposalEdge = { from: string; to: string; relation?: string; fromKind?: string; toKind?: string };
export type ProposalInput = {
  title: string;
  evidence: string;
  source: string;
  sourceUrl?: string;
  edges?: ProposalEdge[];
  suggestedRelation?: string;
  origin?: string;
};

/** 提议结果。filled / left 是给人看的：一眼知道机器干了什么、还剩什么。
 *  hint 是来源提示，不是判断——它不进 constraints。 */
export type Proposal = {
  constraints: Partial<Constraints>;
  filled: string[];
  left: string[];
  hint: SourceHint;
};

// ============ 时效 ============
// 关系的自然半衰期不一样。持股关系变一次要走公告流程，竞争格局一个季度就能翻。
// 这些天数是可争论的默认值，不是事实——人在面板上随时能改。
// 写成表而不是散在代码里，是为了将来能按行业调而不用改逻辑。
const HALF_LIFE_DAYS: Record<string, number> = {
  equity: 365,     // 股权：变更需公告，慢
  license: 365,    // 技术授权：合约期通常按年
  supply: 180,     // 供应采购：跟着招标/合约周期
  personnel: 180,  // 人事交叉：一个考核周期
  compete: 90,     // 竞争替代：格局变化最快
};
const DEFAULT_HALF_LIFE = 180;

/** 语料里最晚的那个日期，当作这份材料的"事实时点"。找不到返回 null。
 *  取最晚而不是最早：一篇材料里往往既有历史沿革又有本次事项，本次事项才是时点。 */
export function latestDateIn(text: string, now: Date): string | null {
  const found: number[] = [];
  const push = (y: number, m: number, d: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    const time = new Date(y, m - 1, d).getTime();
    // 未来日期不作为"事实时点"——那是预告，不是已发生的事。
    // 1990 之前的当噪声（页码、编号误匹配）。
    if (Number.isFinite(time) && y >= 1990 && time <= now.getTime()) found.push(time);
  };
  for (const m of text.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) push(+m[1], +m[2], +m[3]);
  for (const m of text.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月(?!\s*\d{1,2}\s*日)/g)) push(+m[1], +m[2], 1);
  for (const m of text.matchAll(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g)) push(+m[1], +m[2], +m[3]);
  if (!found.length) return null;
  return iso(new Date(Math.max(...found)));
}

function iso(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 有效期 = 事实时点 + 该关系类型的半衰期。
 *  事实时点取不到就从今天算——宁可短一点，让它早点到期被重新看一眼。
 *  永远不返回已经过期的日期：那样门 5 照样挡着，等于没提议。 */
export function proposeValidUntil(input: ProposalInput, now: Date): string {
  const relation = input.suggestedRelation || input.edges?.[0]?.relation || "";
  const days = HALF_LIFE_DAYS[relation] ?? DEFAULT_HALF_LIFE;
  const anchorText = `${input.title}\n${input.evidence}`;
  const anchor = latestDateIn(anchorText, now);
  const base = anchor ? new Date(`${anchor}T00:00:00`) : new Date(now);
  const due = new Date(base.getTime() + days * 86400000);
  // 语料很旧时，加完半衰期还是过去。那就给一个短的复核窗口，让它进得来、且很快到期。
  const MIN_WINDOW_DAYS = 30;
  const floor = new Date(now.getTime() + MIN_WINDOW_DAYS * 86400000);
  return iso(due.getTime() > floor.getTime() ? due : floor);
}

// ============ 来源提示（只提示，不写字段） ============
// 法定披露渠道：公司自己填报，但受监管、有法律责任、由第三方平台强制公开。
// 识别出来只用于在界面上提示人「这条来自法定披露，够格标独立第三方」，
// 不自动写进 sourceType——见文件头第 4 条。
export const DISCLOSURE_HOSTS: string[] = [
  "cninfo.com.cn",    // 巨潮资讯（法定披露）
  "sse.com.cn",       // 上交所
  "szse.cn",          // 深交所
  "bse.cn",           // 北交所
  "neeq.com.cn",      // 全国股转
  "csrc.gov.cn",      // 证监会
  "sasac.gov.cn",     // 国资委
  "gsxt.gov.cn",      // 国家企业信用信息公示系统
  "hkexnews.hk",      // 港交所披露易
  "sec.gov",          // SEC
];

/** 聚合站与门户：二手转载，原始出处在别处。 */
const AGGREGATOR_HINTS = ["baidu.", "sina.", "sohu.", "163.com", "qq.com", "toutiao.", "eastmoney.", "10jqka.", "wallstreetcn.", "36kr.", "zhihu.", "weixin.", "bing.", "google."];

function hostOf(url?: string): string {
  if (!url) return "";
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

export type SourceHint = "disclosure" | "aggregator" | "other" | "none";

/** 只回答"这个链接长什么样"，不回答"这条来源可不可信"。
 *  返回值只用于在界面上提示人，永远不写进 constraints.sourceType。 */
export function sourceHint(input: ProposalInput): SourceHint {
  const host = hostOf(input.sourceUrl);
  if (!host) return "none";
  if (DISCLOSURE_HOSTS.some(item => host === item || host.endsWith(`.${item}`))) return "disclosure";
  if (AGGREGATOR_HINTS.some(item => host.includes(item))) return "aggregator";
  return "other";
}

export const SOURCE_HINT_TEXT: Record<SourceHint, string> = {
  disclosure: "链接指向法定披露渠道，够格标「独立第三方」——由你点",
  aggregator: "链接是聚合站/转载页，原始出处在别处，建议标「当事人自己发的」",
  other: "链接来源认不出来，自己看一眼再标",
  none: "没有链接，来源谱系说不清",
};

// ============ 本地边界 ============
const LEGAL_SUFFIX = /(有限公司|股份公司|有限责任公司|合伙企业|事务所|研究院|大学|银行|支行|分行|集团)/;

/** 涉及哪几家公司：从边上取。带法人尾缀的优先，且要标出哪些还不是法人全称——
 *  这是抽取器早就发现的问题（10 个主体 5 个不是法人），不能在这一层假装没有。 */
function proposeEntityScope(edges: ProposalEdge[]): string {
  const names = [...new Set(edges.flatMap(edge => [edge.from, edge.to]).filter(Boolean))];
  if (!names.length) return "";
  const legal = names.filter(name => LEGAL_SUFFIX.test(name));
  const loose = names.filter(name => !LEGAL_SUFFIX.test(name));
  const parts = [legal.join(" / ")].filter(Boolean);
  if (loose.length) parts.push(`（以下还不是法人全称，需补：${loose.join(" / ")}）`);
  return parts.join(" ") || "";
}

// 地域只认明确写出来的行政区划/大区词。推不出来就留空。
const REGION_WORDS = ["全国", "华东", "华南", "华北", "华中", "西南", "西北", "东北", "长三角", "珠三角", "京津冀", "粤港澳", "海外", "全球"];
const PROVINCE_WORDS = ["北京", "上海", "天津", "重庆", "广东", "江苏", "浙江", "山东", "河南", "河北", "四川", "湖北", "湖南", "福建", "安徽", "陕西", "江西", "辽宁", "山西", "云南", "贵州", "广西", "内蒙古", "新疆", "西藏", "宁夏", "青海", "甘肃", "海南", "吉林", "黑龙江", "香港", "澳门", "台湾"];

function proposeMarketRegion(text: string): string {
  const hits = [...REGION_WORDS, ...PROVINCE_WORDS].filter(word => text.includes(word));
  return hits.length ? hits.slice(0, 4).join(" / ") : "";
}

// 口径只认语料里真的出现的计量词。这几个词出现，才说明材料里有可对齐的数字口径。
const BASIS_WORDS = ["营业收入", "营收", "净利润", "毛利率", "出货量", "产能", "装机", "中标金额", "合同金额", "持股比例", "股权比例", "注册资本", "市场份额", "交易金额", "采购金额"];

function proposeDataBasis(text: string): string {
  const hits = BASIS_WORDS.filter(word => text.includes(word));
  if (!hits.length) return "";
  return `${[...new Set(hits)].slice(0, 4).join(" / ")}（口径以原文为准）`;
}

/** 时间窗口 = 事实时点那一天起，到有效期。没有事实时点就留空，不编。 */
function proposeTimeWindow(input: ProposalInput, now: Date): string {
  const anchor = latestDateIn(`${input.title}\n${input.evidence}`, now);
  return anchor ? `材料时点 ${anchor} 起` : "";
}

const SCOPE_LABELS: Record<keyof LocalScope, string> = {
  entityScope: "涉及哪几家公司",
  marketRegion: "在哪个市场或地区",
  dataBasis: "里面的数字按什么算",
  timeWindow: "哪段时间内有效",
  ourAccess: "我们能拿它做什么",
};

/**
 * 主入口。给一条候选，提议它能被提议的那些约束字段。
 *
 * 不提议的三样，理由各不相同：
 * - ourAccess：关于我方能力，语料里不存在。机器猜它就是替人做决定。
 * - sourceType：见文件头第 4 条。只给 hint，由人点。
 * - falsifier / counterEvidence：需要一个"什么情况下我会认错"的反事实构造。
 *   这个由 /api/analyze 提（它的提示词已经出 falsifiers/counterevidence），
 *   走模型，不走这里——这个文件的合约是"不联网、可离线测"。
 */
export function proposeConstraints(input: ProposalInput, now: Date = new Date()): Proposal {
  const edges = input.edges || [];
  const text = `${input.title}\n${input.evidence}`;
  const scope: LocalScope = {
    entityScope: proposeEntityScope(edges),
    marketRegion: proposeMarketRegion(text),
    dataBasis: proposeDataBasis(text),
    timeWindow: proposeTimeWindow(input, now),
    ourAccess: "",
  };
  const validUntil = proposeValidUntil(input, now);

  const filled: string[] = [];
  const left: string[] = [];
  for (const key of Object.keys(scope) as Array<keyof LocalScope>) {
    (scope[key] ? filled : left).push(SCOPE_LABELS[key]);
  }
  filled.push("有效期");

  return {
    constraints: { scope, validUntil },
    filled,
    left,
    hint: sourceHint(input),
  };
}
