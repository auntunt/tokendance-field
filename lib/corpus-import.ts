// 把 207 家的原始语料翻译成公司档案。纯函数，不联网。
//
// ============ 定级的诚实原则 ============
// 原始语料只有公司级的 sources 数组，没有字段级出处——也就是说，
// 我们知道「这家公司的资料来自这 4 个链接」，但不知道「创始人这一条来自哪一个」。
//
// 所以这里**不允许**用公司级最好的来源去给每个字段定级：那会把一条
// 从通稿里读来的团队描述标成「法定披露」，等于凭空升级。规则是：
//   1. 只有 filing（网信办备案号这类监管登记）本身是登记事实 → statutory。
//   2. 有链接、且链接里有独立媒体/政府站 → 该公司的调研字段最高只到 independent。
//   3. 有链接但只是聚合站/企业自述页 → self。
//   4. 没有任何链接（142/207 是这种）→ unverified，报告里按空缺处理。
// 宁可低估：报告的价值在于「哪一格是硬的」，把软的标硬就全毁了。

import type { DimensionId, SourceGrade, Sourced } from "./fde-dimensions";
import { emptyProfile, RELEVANCE_META, type CompanyProfile, type Listing, type Relevance } from "./company-profile";
import type { RosterEntry } from "./fde-roster";

/** 语料里一家公司的形状。只声明我们真正读的字段。 */
export type CorpusCompany = {
  id?: number | string;
  name?: string;
  name_raw?: string;
  city?: string;
  macro_region?: string;
  sector?: string;
  sector_raw?: string;
  billing?: string;
  billing_raw?: string;
  founder_raw?: string;
  founder_detail?: string;
  founder_tags?: string[];
  funding_raw?: string;
  funding_detail?: string;
  funding_state?: string;
  rounds?: number;
  investors?: string[];
  funding_amount_wan?: number;
  listed?: boolean;
  stage?: string;
  narrative?: string;
  deliverable?: string;
  filing?: string;
  risk?: string;
  sources?: string[];
  channel_label?: string;
};

const STATUTORY_HOSTS = ["cninfo.com.cn", "sse.com.cn", "szse.cn", "bse.cn", "neeq.com.cn", "csrc.gov.cn", "sasac.gov.cn", "gsxt.gov.cn", "hkexnews.hk", "sec.gov", "beian.cac.gov.cn"];
const SELF_HINTS = ["pitchhub.36kr.com", "36kr.com", "weixin.", "shaqiu.cn", "chinapp.net.cn", "zhihu.", "baidu.", "sohu.", "163.com", "qq.com", "toutiao.", "eastmoney.", "10jqka."];

function hostOf(url: string) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

/** 政府站与官方通讯社算独立三方：发布方不是当事人。
 *  注意 .gov.cn 单独判——语料里有区县政府的产业新闻页，那是第三方报道，
 *  但它不是「法定披露」，法定披露得是监管强制的定期报告或登记。 */
export function gradeOfUrl(url: string): SourceGrade {
  const host = hostOf(url);
  if (!host) return "unverified";
  if (STATUTORY_HOSTS.some(item => host === item || host.endsWith(`.${item}`))) return "statutory";
  if (SELF_HINTS.some(item => host.includes(item))) return "self";
  if (host.endsWith(".gov.cn") || host.includes("xinhuanet.") || host.includes("people.com.cn") || host.includes("shobserver.")) return "independent";
  return "self";
}

const GRADE_RANK: Record<SourceGrade, number> = { statutory: 3, independent: 2, self: 1, unverified: 0 };

/** 这家公司的调研字段最高能给到几级。见文件头的原则 2/3/4。 */
export function ceilingGrade(company: CorpusCompany): { grade: SourceGrade; source: string; sourceUrl?: string } {
  const urls = (company.sources || []).filter(item => typeof item === "string" && item.trim());
  if (!urls.length) return { grade: "unverified", source: "fde_round3 交付包（无字段级出处）" };
  let best = urls[0];
  let bestGrade = gradeOfUrl(urls[0]);
  for (const url of urls.slice(1)) {
    const grade = gradeOfUrl(url);
    if (GRADE_RANK[grade] > GRADE_RANK[bestGrade]) { best = url; bestGrade = grade; }
  }
  // 调研字段不给 statutory：交易所链接能证明「有这份公告」，
  // 不能证明「创始人背景这句话是从公告里抄的」。压到 independent。
  const capped: SourceGrade = bestGrade === "statutory" ? "independent" : bestGrade;
  return { grade: capped, source: hostOf(best) || "语料链接", sourceUrl: best };
}

function listingOf(company: CorpusCompany): Listing {
  return company.listed ? "otc" : "private";
}

/** 相关度。语料里没有这一列——它记的是「交付渠道可信度」，不是「像不像 FDE」。
 *  所以这里只能按已有文本给一个保守初值，全部标 vendor/unclear，
 *  由人（或后续抓到 JD 后）往上升。绝不自动标 practitioner：
 *  「谁是 FDE 实践者」正是这份报告要回答的问题，不能用猜测预先填答案。 */
export function initialRelevance(company: CorpusCompany): { relevance: Relevance; reason: string } {
  const text = `${company.narrative || ""} ${company.deliverable || ""} ${company.sector_raw || ""} ${company.billing_raw || ""}`;
  if (/驻场|派驻|现场交付|交付中心|驻厂/.test(text)) {
    return { relevance: "adjacent", reason: "语料文本出现驻场/现场交付/交付中心，模式上接近，但未见 FDE 岗位证据" };
  }
  if (!company.narrative && !company.deliverable) {
    return { relevance: "unclear", reason: "语料只有一行摘要，不足以判断交付模式" };
  }
  return { relevance: "vendor", reason: "语料显示为项目制或 SaaS 交付，未见前置部署工程师组织" };
}

/** 把创始人背景标签收成一个粗桶，供交叉统计用。
 *
 *  为什么要收：原始标签有 11 种（阿里/字节/百度/腾讯/华为 各算一个），
 *  拿它直接交叉，每格只剩三五家，占比全是噪音。而真正区分路径的不是
 *  「阿里还是字节」，是「大厂产品线出来的」还是「院所/央国企出来的」——
 *  前者进的是可量化的场景，后者进的是靠关系准入的场景。
 *
 *  一家有多个标签时按这个顺序取第一个命中的：体制内的准入属性比大厂经历更决定
 *  他能进哪个客户的门，所以院所/央国企优先。 */
export function founderBucket(tags?: string[]): string | null {
  if (!tags || !tags.length) return null;
  const text = tags.join("、");
  if (/高校|科研院所|央国企|产业老兵/.test(text)) return "院所 / 央国企";
  if (/阿里|钉钉|蚂蚁|字节|火山|剪映|飞书|百度|腾讯|华为|大模型公司系/.test(text)) return "大厂 / 大模型系";
  if (/外企|跨国/.test(text)) return "外企";
  if (/咨询/.test(text)) return "咨询";
  if (/金融机构/.test(text)) return "金融机构";
  return null;
}

export function importCompany(company: CorpusCompany, fetchedAt: string): CompanyProfile {
  const name = company.name || company.name_raw || `未命名 ${company.id ?? ""}`;
  const profile = emptyProfile(String(company.id ?? name), name);
  const ceiling = ceilingGrade(company);
  const relevance = initialRelevance(company);

  profile.aliases = company.name_raw && company.name_raw !== name ? [company.name_raw] : [];
  profile.listing = listingOf(company);
  profile.country = "中国";
  profile.city = company.city && company.city !== "未标注" ? company.city : undefined;
  profile.sector = company.sector;
  profile.relevance = relevance.relevance;
  profile.relevanceReason = relevance.reason;
  profile.firstSeen = fetchedAt;
  profile.updatedAt = fetchedAt;
  profile.origin = "fde_round3 / dist/data.json";

  const put = (dimension: keyof CompanyProfile["facts"], key: string, value: unknown, grade?: SourceGrade, source?: string) => {
    const text = Array.isArray(value) ? value.join("、") : value === null || value === undefined ? "" : String(value);
    if (!text.trim()) return;
    const bucket = (profile.facts[dimension] ||= {});
    const entry: Sourced = {
      value: text,
      grade: grade || ceiling.grade,
      source: source || ceiling.source,
      fetchedAt,
    };
    if (!source && ceiling.sourceUrl) entry.sourceUrl = ceiling.sourceUrl;
    bucket[key] = entry;
  };

  /** 带归一标签的 put。label 供交叉统计，value 仍是原话。 */
  const putLabeled = (
    dimension: keyof CompanyProfile["facts"], key: string,
    value: unknown, label: string | undefined | null, grade?: SourceGrade,
  ) => {
    put(dimension, key, value, grade);
    const entry = profile.facts[dimension]?.[key];
    // 「未披露」「未核实」这类占位不是取值，进了统计会变成一个假分类。
    if (entry && label && !/^(未披露|未核实|未公开|未标注|无)$/.test(label.trim())) {
      entry.label = label.trim();
    }
  };

  // 团队。founder_detail 比 founder_raw 完整，优先它。
  put("team", "founders", company.founder_detail || company.founder_raw);
  putLabeled("team", "priorAffil", company.founder_tags, founderBucket(company.founder_tags));

  // 融资。轮次/投资方/金额分别落位——原来这些全被丢掉了。
  putLabeled("funding", "rounds",
    company.rounds ? `${company.rounds} 轮（阶段：${company.stage || "未标注"}）` : company.stage,
    company.stage);
  put("funding", "investors", company.investors);
  put("funding", "amounts", company.funding_amount_wan ? `累计约 ${company.funding_amount_wan} 万元` : company.funding_detail);

  // 业务。
  // pricing 用 billing_raw 当展示值（带金额、带口径），billing 当统计标签。
  // 这两个字段语料里都有，之前只留了前者，53 家因此掉出所有交叉统计。
  put("business", "whatTheySell", company.narrative || company.sector_raw);
  putLabeled("business", "verticals", company.sector, company.sector);
  putLabeled("business", "pricing", company.billing_raw || company.billing, company.billing);
  putLabeled("business", "geography",
    [company.city, company.macro_region].filter(Boolean), company.macro_region);
  put("business", "customers", company.deliverable);

  // FDE 落地。语料里没有专门的列，只能从 deliverable 里取一句交付方式，
  // 并且明确标成 self——它是交付描述，不是 FDE 组织证据。
  if (company.deliverable) put("fde", "onsiteModel", company.deliverable, "self");

  // 背景。filing 是监管登记事实，唯一给 statutory 的地方。
  if (company.filing) put("background", "partnerships", company.filing, "statutory", "网信办算法/大模型备案");
  if (company.risk) put("background", "litigation", company.risk);

  return profile;
}

export function importCorpus(companies: CorpusCompany[], fetchedAt: string): CompanyProfile[] {
  return companies.map(company => importCompany(company, fetchedAt));
}

/** 名单条目转档案：只落身份，facts 一律空。
 *  空的 facts 是这层的正确状态——报告里它显示成一整行「未核实」，
 *  正好告诉人「这家该查但还没查」。填个占位反而会把待办藏起来。 */
/** 抓取产物：scripts/fetch-filings.mjs 写出的那份 data/filing-facts.json。
 *  只认已经装好出处的 Sourced，这一层不做任何加工——
 *  加工在抽取层做完了，这里再动就等于把「出处」和「值」拆开过一次手。 */
export type FilingFacts = {
  fetchedAt: string;
  companies: Array<{
    id: string;
    name: string;
    filing: { title: string; date: string; url: string };
    facts: Partial<Record<DimensionId, Record<string, Sourced>>>;
  }>;
};

export function importRoster(entries: RosterEntry[], fetchedAt: string, filings?: FilingFacts): CompanyProfile[] {
  const byId = new Map((filings?.companies ?? []).map(item => [item.id, item]));
  return entries.map(entry => {
    const profile = emptyProfile(entry.id, entry.name);
    profile.legalName = entry.legalName;
    profile.aliases = entry.aliases || [];
    profile.listing = entry.listing;
    profile.ticker = entry.ticker;
    profile.country = entry.country;
    profile.sector = entry.sector;
    // 名单里的 guess 是猜测，不是结论。所以档案里的 relevance 一律先记 unclear，
    // 猜测本身放进 relevanceReason 里带着「待核实」四个字展示——
    // 让人看到我们打算怎么归类，同时看到这还没被证实。
    profile.relevance = "unclear";
    profile.relevanceReason = `待核实（初步猜测：${RELEVANCE_META[entry.guess].label}）——${entry.hypothesis}`;
    profile.firstSeen = fetchedAt;
    profile.updatedAt = fetchedAt;
    profile.watchlist = true;
    profile.origin = `名单种子 / lib/fde-roster.ts；抓取入口：${entry.fetch.join("；")}`;

    // 把真抓到的法定披露事实并进来。
    // relevance 仍然不动：抓到年报不等于判定了模式归属——那要人读过原文才能定，
    // 而这一层的职责只是「把有出处的事实放进档案」。
    // 唯一变的是 relevanceReason 后面追加一句「已取到什么文件」，
    // 让读的人知道这家的待核实是「还没读」而不是「没材料」。
    const fetched = byId.get(entry.id);
    if (fetched) {
      profile.facts = fetched.facts;
      profile.updatedAt = filings?.fetchedAt ?? fetchedAt;
      profile.relevanceReason += `｜已取到：${fetched.filing.title}（${fetched.filing.date}）`;
    }
    return profile;
  });
}
