// 「向上补」的名单种子：上市公司（美股/A股/港股）+ 有融资的创业公司。
//
// ============ 这个文件里只有身份，没有事实 ============
// 每一条只记四样东西：叫什么、在哪上市、代码是什么、去哪儿抓。
// 股东/团队/融资/业务一律留空，等抓取器带着出处填进去。
//
// 为什么这么严：现有 207 家的教训是「资料看起来有，级别其实是未核实 62%」。
// 如果我在这里凭记忆写上「某公司有 500 个 FDE」，它会以最高可信度的样子
// 出现在报告里，而且没有出处可以被反驳——那比空着有害得多。
//
// relevanceBasis 同理。FDE 这个说法本身出自某家公司，但「他们现在怎么做」
// 是这份报告要去查的问题，不是可以预填的答案。所以名单里每一条的相关度
// 都标成 hypothesis（待核实的猜测），只有抓到 JD / 年报原文之后才能转 verified。

import type { Listing, Relevance } from "./company-profile";

export type RosterEntry = {
  id: string;
  name: string;
  legalName?: string;
  aliases?: string[];
  listing: Listing;
  /** 交易所代码。留空表示还没核对过，抓取时先去查代码。 */
  ticker?: string;
  country: string;
  sector: string;
  /** 为什么把它放进名单。一句话，必须能被反驳。 */
  hypothesis: string;
  /** 猜的相关度，以及这个猜测的依据强度。 */
  guess: Relevance;
  basis: "hypothesis";
  /** 抓取入口。上市公司走法定披露，创业公司只能走三方 + 招聘页。 */
  fetch: string[];
};

/** 抓取入口的标准组合，按上市地分。写成常量是因为同一地的公司套路完全一样，
 *  重复写一遍就会漏掉其中一个渠道。 */
const FETCH_US = ["SEC EDGAR 10-K/10-Q/DEF 14A（股东、高管、营收、竞争、诉讼）", "官网 careers 页（FDE 岗位名、驻场要求、归属部门）", "官网 engineering blog（AI 交付方式）"];
const FETCH_A = ["巨潮资讯网定期报告（股东、实控人、高管、分部收入）", "上交所/深交所公告", "官网招聘页 + 主流招聘平台 JD"];
const FETCH_HK = ["港交所披露易年报与月报表", "招股书历史沿革（股权结构变动）", "官网招聘页 JD"];
const FETCH_PRIVATE = ["投资方官网 portfolio 页（轮次、金额、投资方，最可靠）", "独立媒体报道（交叉验证金额口径）", "官网 careers 页 JD 原文", "工商登记 / 股权穿透"];

/** 第一批：以 FDE / 前置部署 / 重驻场交付著称，或明确对外招这类岗位的公司。
 *  只列到我能给出确定身份的程度；代码不确定的就留空，交给抓取时核对。 */
export const ROSTER: RosterEntry[] = [
  { id: "r-pltr", name: "Palantir", legalName: "Palantir Technologies Inc.", listing: "us", ticker: "PLTR", country: "美国", sector: "通用平台", guess: "practitioner", basis: "hypothesis", hypothesis: "Forward Deployed Engineer 这一岗位名称与该公司关联最紧，需从其招聘页与 10-K 核实当前组织形态", fetch: FETCH_US },
  { id: "r-snow", name: "Snowflake", listing: "us", ticker: "SNOW", country: "美国", sector: "通用平台", guess: "adjacent", basis: "hypothesis", hypothesis: "数据平台厂商，需核实其解决方案架构师是否承担驻场交付职能", fetch: FETCH_US },
  { id: "r-c3", name: "C3.ai", listing: "us", ticker: "AI", country: "美国", sector: "工业制造", guess: "adjacent", basis: "hypothesis", hypothesis: "工业 AI 应用，项目制交付比重高，需核实交付团队与客户数之比", fetch: FETCH_US },
  { id: "r-pl", name: "Planet Labs", listing: "us", ticker: "PL", country: "美国", sector: "政务治理", guess: "unclear", basis: "hypothesis", hypothesis: "对政府客户交付数据产品，交付模式待查", fetch: FETCH_US },
  { id: "r-appn", name: "Appian", listing: "us", ticker: "APPN", country: "美国", sector: "通用平台", guess: "adjacent", basis: "hypothesis", hypothesis: "低代码平台，交付依赖实施顾问，需核实是否为前置部署形态", fetch: FETCH_US },
  { id: "r-acn", name: "Accenture", listing: "us", ticker: "ACN", country: "爱尔兰", sector: "通用平台", guess: "vendor", basis: "hypothesis", hypothesis: "传统咨询交付的对照组——用来标定「FDE 和外包驻场的差别在哪」", fetch: FETCH_US },
  { id: "r-databricks", name: "Databricks", listing: "private", country: "美国", sector: "通用平台", guess: "adjacent", basis: "hypothesis", hypothesis: "有大额融资，需核实其 Field Engineering 组织的规模与职责", fetch: FETCH_PRIVATE },
  { id: "r-scale", name: "Scale AI", listing: "private", country: "美国", sector: "通用平台", guess: "practitioner", basis: "hypothesis", hypothesis: "对外招 Forward Deployed 类岗位，需以 JD 原文核实驻场方式", fetch: FETCH_PRIVATE },
  { id: "r-sensetime", name: "商汤科技", legalName: "商汤集团有限公司", listing: "hk", ticker: "0020.HK", country: "中国", sector: "通用平台", guess: "adjacent", basis: "hypothesis", hypothesis: "AI 平台 + 行业项目交付，年报有分部与客户集中度披露可查", fetch: FETCH_HK },
  { id: "r-4paradigm", name: "第四范式", legalName: "北京第四范式智能技术股份有限公司", listing: "hk", ticker: "6682.HK", country: "中国", sector: "通用平台", guess: "adjacent", basis: "hypothesis", hypothesis: "企业级 AI 决策平台，招股书披露过客户数与交付人力，是难得的量化材料", fetch: FETCH_HK },
  { id: "r-kingdee", name: "金蝶国际", listing: "hk", ticker: "0268.HK", country: "中国", sector: "通用平台", guess: "vendor", basis: "hypothesis", hypothesis: "从许可制转订阅制的样本，用来看「定制到产品」的转化路径", fetch: FETCH_HK },
  { id: "r-chinasoft", name: "中软国际", listing: "hk", ticker: "0354.HK", country: "中国", sector: "通用平台", guess: "vendor", basis: "hypothesis", hypothesis: "人力外包驻场的规模样本，年报有员工构成，可算人效", fetch: FETCH_HK },
  { id: "r-iflytek", name: "科大讯飞", legalName: "科大讯飞股份有限公司", listing: "cn-a", ticker: "002230.SZ", country: "中国", sector: "通用平台", guess: "adjacent", basis: "hypothesis", hypothesis: "行业大模型落地以项目交付为主，定期报告有分行业收入", fetch: FETCH_A },
  { id: "r-yonyou", name: "用友网络", listing: "cn-a", ticker: "600588.SH", country: "中国", sector: "通用平台", guess: "vendor", basis: "hypothesis", hypothesis: "大型 ERP 实施交付，年报披露实施人员规模", fetch: FETCH_A },
  { id: "r-cloudwalk", name: "云从科技", listing: "cn-a", ticker: "688327.SH", country: "中国", sector: "政务治理", guess: "adjacent", basis: "hypothesis", hypothesis: "科创板披露较细，可查项目制收入占比与人力投入", fetch: FETCH_A },
  { id: "r-thunder", name: "中科创达", listing: "cn-a", ticker: "300496.SZ", country: "中国", sector: "工业制造", guess: "adjacent", basis: "hypothesis", hypothesis: "以驻场研发交付为主要模式之一，年报有研发人员与客户结构", fetch: FETCH_A },
  { id: "r-hundsun", name: "恒生电子", listing: "cn-a", ticker: "600570.SH", country: "中国", sector: "金融", guess: "adjacent", basis: "hypothesis", hypothesis: "金融 IT 长期驻场，是国内最接近 FDE 形态的成熟样本之一，待核实", fetch: FETCH_A },
  { id: "r-isoftstone", name: "软通动力", listing: "cn-a", ticker: "301236.SZ", country: "中国", sector: "通用平台", guess: "vendor", basis: "hypothesis", hypothesis: "人力驻场规模化的对照组，用来标定 FDE 与人头外包的边界", fetch: FETCH_A },
  { id: "r-bonc", name: "东方国信", listing: "cn-a", ticker: "300166.SZ", country: "中国", sector: "工业制造", guess: "adjacent", basis: "hypothesis", hypothesis: "工业互联网项目交付，年报有分行业与在手订单", fetch: FETCH_A },
  { id: "r-minglue", name: "明略科技", listing: "private", country: "中国", sector: "通用平台", guess: "adjacent", basis: "hypothesis", hypothesis: "有多轮融资，营销与运营场景的重交付厂商，需查轮次与投资方", fetch: FETCH_PRIVATE },
  { id: "r-zhipu", name: "智谱", listing: "private", country: "中国", sector: "通用平台", guess: "adjacent", basis: "hypothesis", hypothesis: "大模型厂商中企业交付比重较高，需核实是否设专门驻场交付团队", fetch: FETCH_PRIVATE },
  { id: "r-moonshot", name: "月之暗面", listing: "private", country: "中国", sector: "通用平台", guess: "unclear", basis: "hypothesis", hypothesis: "以 C 端为主，列入用于对照「不做驻场的大模型公司」", fetch: FETCH_PRIVATE },
  { id: "r-minimax", name: "MiniMax", listing: "private", country: "中国", sector: "通用平台", guess: "unclear", basis: "hypothesis", hypothesis: "待查其 B 端交付方式", fetch: FETCH_PRIVATE },
  { id: "r-baichuan", name: "百川智能", listing: "private", country: "中国", sector: "医疗健康", guess: "adjacent", basis: "hypothesis", hypothesis: "医疗行业落地需深度驻场，待核实交付组织", fetch: FETCH_PRIVATE },
];

/** 名单里一条也不许带事实。这条断言在测试里被执行——
 *  防的是「先随手写个数字，回头再核」，那个回头永远不会到。 */
export const ROSTER_FACT_KEYS: string[] = [];
