// 发现层：从公开渠道找出「可能在做 FDE 模式」的新公司，产出候选，不产出结论。
//
// ============ 这一层为什么不许碰名单 ============
// lib/fde-roster.ts 是经过判断的东西——每一条都有人想过「为什么盯它」。
// 而这里出来的东西是机器在公开文本里搜到的字符串匹配，两者不是一个性质。
// 把搜索结果直接灌进名单，就会重演 207 家那个问题：资料看起来有，
// 相关性其实是混的，最后报告失去意义。所以这一层只写 data/candidates.json，
// 升不升进名单由人决定。24 → 100 家这条路，宁可慢，不可脏。
//
// ============ 定级为什么一律 unverified ============
// 有些证据其实来自 SEC 法定披露（EPAM/Rackspace 的 8-K），按 fde-dimensions
// 的定义那是 statutory 级。这里仍然一律标 unverified，因为级别形容的是
// **「我们要的那个判断」被核实到什么程度**，不是「这份文件本身可不可信」。
// 8-K 能证明「这家公司在通稿里写了 forward-deployed engineering」，
// 不能证明「这家公司真的有一个前置部署工程师组织」——后者才是报告要答的题。
// 一份 CEO 引语里的战略措辞，和一份招聘 JD 里的岗位职责，可信度差得远。
// 所以：证据带着原文和 URL 交给人读，级别不替人升。
//
// ============ 噪音门为什么用白名单 ============
// 实测「forward deployed」在 SEC 全文检索里有 207 份文件命中，其中大量是
// 军事/物流语义，跟交付组织毫无关系：
//   SI-BONE：      "forward deployed with our sales force"（备货在销售手里）
//   Verrica：      "Forward Deployed Inventory"（前置库存）
//   LIFE STORAGE： "a forward deployed, unmanned model"（无人仓）
//   Ocean Power：  "fully forward deployed, persistently ... recharging system"（浮标）
// 黑名单挡不住这些——挡掉 inventory 之后还会有下一个词。所以反过来做：
// 只有当短语后面紧跟一个**角色词**（engineer/engineering/architect…）才算命中。
// 白名单会漏（某些真实践者可能换了别的说法），但漏掉的代价是「候选少几家」，
// 而放进来的代价是「名单又变脏」。这两个代价不对等，所以选会漏的那个。

import type { Listing, Relevance } from "./company-profile";
import type { RosterEntry } from "./fde-roster";
import type { SourceGrade } from "./fde-dimensions";

/** 要搜的短语。
 *
 *  为什么不搜单独的「forward deployed」：见文件头，207 份命中里绝大多数是军事语义。
 *  为什么中文短语列在这里却没有渠道用它：实测国内几个能做全文检索的入口都不可用
 *  （巨潮全文检索按字切词，搜「前置部署工程师」会把「工作部署」「前置程序」全捞回来，
 *  16957 条命中里前五条是白酒和化工公司的议事规则）。留着这几条是为了记录
 *  「这个方向试过、走不通」，而不是假装它在工作。见 CHANNELS 里的 note。 */
export const DISCOVERY_TERMS = [
  "forward deployed engineer",
  "forward deployed engineers",
  "forward deployed engineering",
] as const;

export const CN_TERMS_NO_CHANNEL = ["前置部署工程师", "驻场交付工程师", "交付工程师"] as const;

/** 角色词门。短语后面必须紧跟这些词之一，才认为它在说「一群人」而不是「一批货」。
 *  中间允许夹一个修饰词（software / solutions / AI），因为 JD 里常写
 *  "Forward Deployed Software Engineer"。 */
// deployed / deployment 两种写法都收：实测 Adobe 的招聘帖岗位名写的是
// "Forward Deployment Engineering (AI/ML)"，同一个概念换了个词形。
// 单独的 "forward deployment" 是纯军事说法（前沿部署兵力），但后面跟角色词之后
// 就不会误伤——门的把关点始终是「后面是不是一群人」。
const ROLE_GATE = /forward[\s‐-―-]*deploy(?:ed|ment)\s+(?:senior\s+|staff\s+|principal\s+|software\s+|solutions?\s+|ai\s+|silicon\s+|full[\s-]?stack\s+){0,2}(?:engineer|engineering|architect|technologist)/i;

/** 证据强度。名字取得直白，因为它要被人读，不是被机器排序。 */
export const SIGNALS = ["role-title", "first-person-org", "org-description"] as const;
export type Signal = (typeof SIGNALS)[number];

export const SIGNAL_META: Record<Signal, { label: string; hint: string }> = {
  // 岗位名是最硬的一手材料：公司愿意用这个名字对外招人，说明这个角色真的存在。
  "role-title": { label: "岗位名命中", hint: "短语出现在职位名称里，说明这个岗位真的在招" },
  // 第一人称：「我们用 FDE」。仍是自述，但至少主语明确是这家公司自己。
  "first-person-org": { label: "第一人称自述", hint: "公司用「我们」描述这个组织，主语明确是它自己" },
  // 正文里提到，但主语不明。见 subjectUnclear 的注释——这一档可能根本不是在说这家公司。
  "org-description": { label: "正文提及", hint: "短语出现在正文里，但主语不明，可能在说别人" },
};

/** 短语附近有没有第一人称。
 *
 *  ============ 为什么需要这一档 ============
 *  EDGAR 全文检索命中的是「这份文件里出现过这个短语」，不是「这家公司有这个组织」。
 *  实测抓到一个真实的误判：SkyWater Technology 的文件里有
 *  "these forward-deployed engineers, training programs, we do a lot with universities
 *   because we want people to learn on the IonQ ecosystem" ——
 *  说话的人在讲 IonQ，SkyWater 只是那份材料的报送方。
 *  这类「文件属于 A、内容在说 B」的情况没法可靠自动识别（要做指代消解），
 *  所以这里不假装能识别，改成把能识别的那部分单独标出来：
 *  短语附近出现 we/our/us 的，主语大概率是报送方自己，可信度更高一档。
 *  剩下的留在最低档，并在 guessReason 里明写「主语待人确认」。 */
export function hasFirstPerson(quote: string): boolean {
  const found = ROLE_GATE.exec(quote);
  if (!found) return false;
  // 只看短语前后 120 字符：整段里出现 "we" 太容易了，那就没有区分度。
  const start = Math.max(0, found.index - 120);
  const around = quote.slice(start, found.index + found[0].length + 120);
  return /\b(we|our|us)\b/i.test(around);
}

export const DISCOVERY_CHANNELS = ["edgar-fts", "hn-hiring", "greenhouse-jd"] as const;
export type ChannelId = (typeof DISCOVERY_CHANNELS)[number];

export const CHANNEL_META: Record<ChannelId, { label: string; what: string; note: string }> = {
  "edgar-fts": {
    label: "SEC EDGAR 全文检索",
    what: "美股上市公司（含 F-1/6-K 的外国发行人）",
    note: "efts.sec.gov 官方全文检索，2001 年至今。命中的是法定披露文件，但命中位置多为 CEO 引语／战略段落。",
  },
  "hn-hiring": {
    label: "Hacker News Who-is-hiring",
    what: "创业公司（多为已融资的美国/欧洲早期公司）",
    note: "Algolia 公开 API。公司自己贴的 JD 原文，一手材料，但完全没有第三方核实。",
  },
  "greenhouse-jd": {
    label: "Greenhouse 公开招聘板",
    what: "用 Greenhouse 的公司的在招岗位",
    note: "只能按 slug 逐个查，无法枚举，所以只作为「给已发现的公司补岗位证据」用，不是发现渠道。",
  },
};

/** 一条证据。grade 写死成字面量类型——不是风格问题：
 *  只要类型上不存在别的可能，就没人能在别处「顺手升一级」。 */
export type Evidence = {
  channel: ChannelId;
  grade: "unverified";
  /** 命中的是哪个短语。 */
  term: string;
  /** 原文片段，逐字。空白被压成单空格（和 filing-extract 一致），但一个词都没改。 */
  quote: string;
  sourceUrl: string;
  sourceTitle: string;
  fetchedAt: string;
  signal: Signal;
};

/** 一个候选。relevance 同样写死 unclear。 */
export type Candidate = {
  /** 归一化后的去重键。 */
  key: string;
  name: string;
  listing: Listing;
  ticker?: string;
  cik?: string;
  relevance: "unclear";
  /** 建议的猜测，给人看的。绝不会是 practitioner——见 suggestGuess。 */
  guess: Relevance;
  guessReason: string;
  /** 这家最强的一条证据是什么强度。 */
  strongestSignal: Signal;
  /** 名单里已经有了。true 的这些不是新发现，留在文件里是为了让人看到渠道确实在工作。 */
  alreadyInRoster: boolean;
  evidence: Evidence[];
};

/** 被扔掉的东西也要记下来，并且记清楚为什么。
 *  否则「这个渠道到底漏了什么」永远查不出来，只能凭感觉猜。 */
export type Rejection = { name: string; channel: ChannelId; why: string; quote?: string };

export type CandidatesFile = {
  generatedAt: string;
  /** 读这份文件的人必须先看到的话。写进产物本身而不是只写在报告里——
   *  这个 JSON 会被单独打开、被别的脚本读，那时候报告不在手边。 */
  readThisFirst: string[];
  terms: string[];
  channels: Array<{ id: ChannelId; label: string; what: string; note: string; ok: boolean; detail: string }>;
  candidates: Candidate[];
  rejected: Rejection[];
};

/** 原始命中，三个渠道的解析结果都收敛到这个形状。 */
export type Finding = {
  name: string;
  listing: Listing;
  ticker?: string;
  cik?: string;
  channel: ChannelId;
  term: string;
  quote: string;
  sourceUrl: string;
  sourceTitle: string;
  fetchedAt: string;
};

// ============ 文本工具 ============

/** 空白压成单空格。HTML 转文本之后必须做，否则 quote 里会有几十个换行。
 *  这不算改原文——一个词都没动，只是把版面空白规整了。 */
export function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 短语命中处取一段上下文当 quote。
 *
 *  为什么要带上下文而不只截短语本身：只留「forward deployed engineering」六个词的话，
 *  人事后没法判断它是岗位名还是战略措辞，也就没法复核——那 quote 就白留了。
 *  实测 240 字符左右够看清一句话的主语和动词。 */
export function extractQuote(plain: string, term: string, window = 240): string | null {
  const flat = flatten(plain);
  // 用短语的词序列构造一个容忍连字符和多空格的正则——原文里
  // "forward-deployed engineers" 和 "forward deployed engineers" 都要能命中，
  // 而 EDGAR 的检索本身就是这么归一化的（搜带空格的短语会命中带连字符的原文）。
  const pattern = new RegExp(
    term.trim().split(/\s+/).map(escapeRegExp).join("[\\s\\u2010-\\u2015-]+"),
    "i",
  );
  const found = pattern.exec(flat);
  if (!found) return null;
  const start = Math.max(0, found.index - Math.floor(window / 2));
  const end = Math.min(flat.length, found.index + found[0].length + Math.floor(window / 2));
  const slice = flat.slice(start, end);
  return `${start > 0 ? "…" : ""}${slice}${end < flat.length ? "…" : ""}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 噪音门。见文件头：白名单，短语后面必须跟角色词。 */
export function passesRoleGate(quote: string): boolean {
  return ROLE_GATE.test(quote);
}

/** 这条证据算岗位名还是组织描述。
 *  titleish 是「已知是标题/岗位名字段」的那部分文本（Greenhouse 的 title、
 *  HN 帖子里管道符分段中的那一段）；没有就传空。 */
export function classifySignal(quote: string, titleish?: string): Signal {
  if (titleish && ROLE_GATE.test(titleish)) return "role-title";
  if (hasFirstPerson(quote)) return "first-person-org";
  return "org-description";
}

// ============ 去重与归一化 ============

/** 公司名清洗。HN 上的写法五花八门，实测踩到这三种：
 *      `[LiveKit]( http://livekit.io/ )`      markdown 链接
 *      `Lago ( https://getlago.com/ )(YCS21)`  名字后面挂网址和批次
 *      `Fieldguide (fieldguide.io)`            名字后面挂域名
 *  不清的后果是同一家公司在候选里出现三次（Lago 就真的出现了三次），
 *  而「候选有多少家」是这份东西最主要的读数，重复会直接把它读错。 */
export function cleanCompanyName(raw: string): string {
  return raw
    .replace(/[[\]]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[-–—,.;:|]+$/, "")
    .trim();
}

/** 公司名归一化成去重键。
 *  去掉法律后缀是必须的：EDGAR 里同一家会以 "Fusemachines Inc." 和
 *  "CSLM Holdings Inc." 两个主体出现（借壳上市前后），而 HN 上就叫 "Fusemachines"。 */
export function normalizeKey(name: string): string {
  return cleanCompanyName(name)
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/&/g, " and ")
    .replace(/\b(inc|corp|corporation|co|ltd|limited|llc|lp|plc|holdings?|technologies|technology|group|acquisition|sa|se|nv|ag|holdco)\b/g, " ")
    .replace(/[^a-z0-9一-鿿]+/g, "")
    .trim();
}

/** 名单里已有的键集合。名称、法定全名、别名都算——
 *  漏判的后果是把已盯的公司当成新发现，报告里的「新增几家」就虚高了。 */
export function rosterKeys(roster: RosterEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of roster) {
    for (const name of [entry.name, entry.legalName, ...(entry.aliases ?? [])]) {
      if (name) keys.add(normalizeKey(name));
    }
  }
  return keys;
}

/** 建议的相关度猜测。
 *
 *  ============ 这个函数的上限是硬的 ============
 *  它永远不返回 practitioner。「谁是 FDE 实践者」正是这份报告要回答的问题，
 *  用一个正则的匹配结果去预填答案，等于把题目当答案交上去。
 *  最强的证据（公司正在招一个名字就叫 Forward Deployed Engineer 的岗位）
 *  也只到 adjacent，而且理由里明写「待人读 JD 原文」。 */
export function suggestGuess(signal: Signal, evidenceCount: number): { guess: Relevance; reason: string } {
  if (signal === "role-title") {
    return {
      guess: "adjacent",
      reason: `岗位名里直接出现该短语（共 ${evidenceCount} 条证据），说明这个角色确实在招；但归属哪个部门、驻场多久、是不是 FDE 那种形态，要人读过 JD 原文才能定`,
    };
  }
  if (signal === "first-person-org") {
    return {
      guess: "adjacent",
      reason: `公司用第一人称描述这个组织（共 ${evidenceCount} 条证据），主语明确是它自己；但这是自述措辞，规模、归属、驻场方式都还没有材料`,
    };
  }
  return {
    guess: "unclear",
    reason: `只在正文里命中且主语不明（共 ${evidenceCount} 条证据），有可能整句在说别家公司（实测出现过这种误判），必须人读原文确认主语是谁`,
  };
}

const SIGNAL_RANK: Record<Signal, number> = { "role-title": 3, "first-person-org": 2, "org-description": 1 };

/** 把原始命中合并成候选。
 *
 *  纯函数，排序全部确定：同样的输入必须出同样的字节。
 *  为什么较真这个：这份文件会定期重跑，如果顺序随机，每次 diff 都是满屏假变更，
 *  真正新增的那一家就被淹没了——「变更页」也就没用了。 */
export function mergeFindings(findings: Finding[], knownKeys: Set<string>): { candidates: Candidate[]; rejected: Rejection[] } {
  const rejected: Rejection[] = [];
  const buckets = new Map<string, { name: string; listing: Listing; ticker?: string; cik?: string; evidence: Evidence[] }>();

  for (const item of findings) {
    const quote = flatten(item.quote);
    if (!quote) {
      rejected.push({ name: item.name, channel: item.channel, why: "没取到原文片段——没有证据的候选不产出" });
      continue;
    }
    if (!item.sourceUrl) {
      rejected.push({ name: item.name, channel: item.channel, why: "没有可回溯的来源 URL", quote: quote.slice(0, 120) });
      continue;
    }
    if (!passesRoleGate(quote)) {
      rejected.push({
        name: item.name,
        channel: item.channel,
        why: "短语后面不是角色词，判为军事/物流等其他语义（见 company-discovery 文件头的实测例子）",
        quote: quote.slice(0, 160),
      });
      continue;
    }
    const key = normalizeKey(item.name);
    if (!key) {
      rejected.push({ name: item.name, channel: item.channel, why: "公司名归一化后为空，无法作为候选" });
      continue;
    }

    const bucket = buckets.get(key) ?? { name: cleanCompanyName(item.name) || item.name, listing: item.listing, ticker: item.ticker, cik: item.cik, evidence: [] };
    // 身份信息以「更具体的那个」为准：有代码/CIK 的覆盖没有的，
    // 上市信息覆盖 private——同一家公司在 HN 上是创业公司、在 EDGAR 上已上市时，
    // 后者才是对的。
    if (!bucket.ticker && item.ticker) bucket.ticker = item.ticker;
    if (!bucket.cik && item.cik) bucket.cik = item.cik;
    if (bucket.listing === "private" && item.listing !== "private") bucket.listing = item.listing;
    bucket.evidence.push({
      channel: item.channel,
      grade: "unverified",
      term: item.term,
      quote,
      sourceUrl: item.sourceUrl,
      sourceTitle: item.sourceTitle,
      fetchedAt: item.fetchedAt,
      signal: classifySignal(quote, item.sourceTitle),
    });
    buckets.set(key, bucket);
  }

  // 第二遍：按股票代码再并一次。
  //
  // 为什么名字对不上还要并：借壳上市的公司在 EDGAR 里有两个申报主体，名字完全不同
  // 但代码是同一个。实测两组：
  //     Airship AI Holdings (AISP) ←→ BYTE Acquisition Corp. (AISP)
  //     Fusemachines Inc. (FUSE)   ←→ CSLM Holdings / CSLM Acquisition Corp. (FUSE)
  // 不并的话同一家公司在候选里算两家，「发现了几家」这个读数就是虚的。
  // 用代码而不是 CIK 来并：CIK 恰恰是按申报主体分配的，借壳前后不是同一个。
  const byTicker = new Map<string, string>();
  for (const [key, bucket] of [...buckets].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!bucket.ticker) continue;
    const primary = byTicker.get(bucket.ticker);
    if (primary === undefined) { byTicker.set(bucket.ticker, key); continue; }
    const target = buckets.get(primary);
    if (!target || target === bucket) continue;
    target.evidence.push(...bucket.evidence);
    if (!target.cik && bucket.cik) target.cik = bucket.cik;
    buckets.delete(key);
  }

  const candidates: Candidate[] = [];
  for (const [key, bucket] of buckets) {
    // 同一份文件里同一个短语可能命中多次，去掉完全相同的证据。
    const seen = new Set<string>();
    const evidence = bucket.evidence
      .filter(item => {
        const fingerprint = `${item.channel}|${item.sourceUrl}|${item.quote}`;
        if (seen.has(fingerprint)) return false;
        seen.add(fingerprint);
        return true;
      })
      .sort((a, b) => a.channel.localeCompare(b.channel) || a.sourceUrl.localeCompare(b.sourceUrl) || a.quote.localeCompare(b.quote));

    if (!evidence.length) continue; // 硬约束：没有证据就没有候选

    const strongestSignal = evidence.reduce<Signal>(
      (best, item) => (SIGNAL_RANK[item.signal] > SIGNAL_RANK[best] ? item.signal : best),
      "org-description",
    );
    const suggestion = suggestGuess(strongestSignal, evidence.length);
    candidates.push({
      key,
      name: bucket.name,
      listing: bucket.listing,
      ticker: bucket.ticker,
      cik: bucket.cik,
      relevance: "unclear",
      guess: suggestion.guess,
      guessReason: suggestion.reason,
      strongestSignal,
      alreadyInRoster: knownKeys.has(key),
      evidence,
    });
  }

  // 排序：先按证据强度，再按证据条数，最后按键名。前两个是给人看的（最值得先读的排前面），
  // 第三个是为了在前两个打平时也确定，保证同输入同输出。
  candidates.sort(
    (a, b) =>
      SIGNAL_RANK[b.strongestSignal] - SIGNAL_RANK[a.strongestSignal] ||
      b.evidence.length - a.evidence.length ||
      a.key.localeCompare(b.key),
  );
  rejected.sort((a, b) => a.channel.localeCompare(b.channel) || a.name.localeCompare(b.name) || (a.quote ?? "").localeCompare(b.quote ?? ""));
  return { candidates, rejected };
}

// ============ 各渠道的解析。全部纯函数，输入是已经拿到手的响应体 ============

/** EDGAR 全文检索的响应。只声明我们真正读的字段。 */
export type EdgarSearchResponse = {
  hits?: {
    hits?: Array<{
      _id?: string;
      _source?: { ciks?: string[]; display_names?: string[]; adsh?: string; form?: string; file_date?: string };
    }>;
  };
};

/** display_names 长这样：`Palantir Technologies Inc.  (PLTR)  (CIK 0001321655)`。
 *  拆出名字和代码。为什么不用 ciks 字段拿代码：那里只有 CIK，没有 ticker。 */
export function parseEdgarDisplayName(display: string): { name: string; ticker?: string; cik?: string } {
  const cik = /\(CIK\s+(\d+)\)/i.exec(display)?.[1];
  const withoutCik = display.replace(/\(CIK\s+\d+\)/i, "");
  // 代码段是剩下的第一个括号，可能有多个代码（`(AISP, AISPW)`），取第一个。
  const tickerGroup = /\(([A-Z0-9.,\s-]+)\)/.exec(withoutCik)?.[1];
  const ticker = tickerGroup?.split(",")[0]?.trim();
  const name = cleanCompanyName(withoutCik);
  return { name, ticker: ticker || undefined, cik };
}

/** 命中文件的可下载 URL。EDGAR 的 _id 是 `<accession>:<filename>`。 */
export function edgarDocUrl(hit: NonNullable<NonNullable<EdgarSearchResponse["hits"]>["hits"]>[number]): string | null {
  const source = hit._source;
  const cik = source?.ciks?.[0]?.replace(/^0+/, "");
  const accession = source?.adsh?.replace(/-/g, "");
  const file = hit._id?.split(":")[1];
  if (!cik || !accession || !file) return null;
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}/${file}`;
}

/** 检索结果 → 待取原文的清单。
 *  为什么还要再去下原文：检索接口不返回正文（`_source` 明确 exclude 了 doc_text），
 *  所以「命中了」和「命中在哪句话上」是两次请求。而没有原文片段的候选按硬约束不能产出。 */
export function planEdgarDocs(response: EdgarSearchResponse, term: string): Array<{ name: string; ticker?: string; cik?: string; url: string; title: string; term: string }> {
  const out: Array<{ name: string; ticker?: string; cik?: string; url: string; title: string; term: string }> = [];
  const seen = new Set<string>();
  for (const hit of response.hits?.hits ?? []) {
    const display = hit._source?.display_names?.[0];
    const url = edgarDocUrl(hit);
    if (!display || !url) continue;
    const identity = parseEdgarDisplayName(display);
    if (!identity.name) continue;
    // 一家公司只取一份文件就够了：目的是拿到一条能读的证据，不是穷举它提过几次。
    // 这同时把请求量压下来——207 份命中变成十几次下载。
    const key = normalizeKey(identity.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...identity,
      url,
      title: `${identity.name} ${hit._source?.form ?? "filing"}（${hit._source?.file_date ?? "日期未知"}）`,
      term,
    });
  }
  out.sort((a, b) => normalizeKey(a.name).localeCompare(normalizeKey(b.name)));
  return out;
}

/** HN Algolia 的响应。 */
export type HnSearchResponse = {
  hits?: Array<{ objectID?: string; story_title?: string; comment_text?: string; created_at?: string }>;
};

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'", "&#x2F;": "/", "&#47;": "/", "&nbsp;": " ",
};

export function decodeHnText(raw: string): string {
  return raw
    .replace(/<p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x2F;|&#47;|&amp;|&lt;|&gt;|&quot;|&#x27;|&#39;|&nbsp;/g, match => HTML_ENTITIES[match] ?? match)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

/** who-is-hiring 帖的首行格式是 `公司 | 地点 | 岗位 | …`，偶尔是 `公司|http://…|…`。
 *  取第一段当公司名。
 *
 *  为什么只信第一段：这个格式是版主定的，贴的人基本都遵守。想从自由文本里
 *  「智能识别公司名」的话，第一个失败案例就是把 "We're building the AI operating
 *  system for CPG brands like OLIPOP" 里的 OLIPOP 当成招聘方。宁可漏。 */
export function parseHnCompanyName(comment: string): { name: string | null; why?: string } {
  const first = decodeHnText(comment).split("\n").map(line => line.trim()).find(line => line.length > 0);
  if (!first) return { name: null, why: "评论为空" };
  if (!first.includes("|")) return { name: null, why: "首行没有管道符，不是标准的 who-is-hiring 版式，无法可靠取出公司名" };
  const name = cleanCompanyName(first.split("|")[0]!);
  if (!name) return { name: null, why: "管道符前为空" };
  if (name.length > 60) return { name: null, why: "首段过长，像句子而不是公司名" };
  if (/[.!?]\s/.test(name)) return { name: null, why: "首段像整句话而不是公司名" };
  if (/^(seeking|looking|location|remote|i'm|i am|hi\b)/i.test(name)) return { name: null, why: "这是求职者帖（who wants to be hired），不是公司" };
  // 首段是岗位名而不是公司名。实测有匿名 stealth 团队直接把职位写在最前面
  // （"Forward Deployed Engineer - backend - python | REMOTE …"），
  // 照收的话候选列表里会出现一家叫「Forward Deployed Engineer」的公司。
  if (ROLE_GATE.test(name)) return { name: null, why: "首段是岗位名而不是公司名（常见于匿名 stealth 团队的帖子），无法确定是哪家公司" };
  // 首段是一句招聘话术，公司名埋在里面。埋在句子里的名字提不准
  //（"We are hiring at deepset, makers of Haystack" 到底叫 deepset 还是 Haystack？），
  // 所以宁可弃用，让它出现在 rejected 里等人看。
  if (/^(we|our|join|hiring|now hiring)\b/i.test(name)) return { name: null, why: "首段是招聘话术而非公司名，公司名埋在句子里提不准" };
  return { name };
}

/** 从 who-is-hiring 评论里找出岗位名那一段。
 *  作用是把 signal 判成 role-title：管道符分段里如果有一段本身就是角色词命中，
 *  那这家是真的在招这个岗位，而不是在正文里随口提了一句。 */
export function hnRoleSegment(comment: string): string | undefined {
  const text = decodeHnText(comment);
  const first = text.split("\n").map(line => line.trim()).find(line => line.length > 0) ?? "";
  return first.split("|").map(part => part.trim()).find(part => ROLE_GATE.test(part));
}

export function parseHnHits(response: HnSearchResponse, term: string, fetchedAt: string): { findings: Finding[]; rejected: Rejection[] } {
  const findings: Finding[] = [];
  const rejected: Rejection[] = [];
  for (const hit of response.hits ?? []) {
    const story = hit.story_title ?? "";
    // 只要「谁在招人」，不要「谁想被招」——后者是个人，不是公司。
    if (!/who is hiring/i.test(story) || /who wants to be hired/i.test(story)) {
      continue;
    }
    const comment = hit.comment_text ?? "";
    const parsed = parseHnCompanyName(comment);
    if (!parsed.name) {
      rejected.push({ name: `HN#${hit.objectID ?? "?"}`, channel: "hn-hiring", why: parsed.why ?? "取不出公司名" });
      continue;
    }
    const plain = decodeHnText(comment);
    const quote = extractQuote(plain, term);
    if (!quote) {
      rejected.push({ name: parsed.name, channel: "hn-hiring", why: `评论里找不到「${term}」的原文位置` });
      continue;
    }
    const roleSegment = hnRoleSegment(comment);
    findings.push({
      name: parsed.name,
      listing: "private", // HN 上贴招聘的基本都是未上市公司；真上市的会在 EDGAR 渠道被纠正
      channel: "hn-hiring",
      term,
      quote,
      sourceUrl: `https://news.ycombinator.com/item?id=${hit.objectID ?? ""}`,
      // sourceTitle 同时充当 classifySignal 的 titleish：有岗位段就放它。
      sourceTitle: roleSegment ?? `${story}（HN 评论）`,
      fetchedAt,
    });
  }
  return { findings, rejected };
}

/** Greenhouse 公开招聘板的响应。 */
export type GreenhouseResponse = { jobs?: Array<{ title?: string; absolute_url?: string; content?: string; location?: { name?: string } }> };

/** 挑出岗位名命中的职位。
 *  这个渠道不做发现（slug 无法枚举），只给已发现的公司补最硬的那种证据。 */
export function parseGreenhouseJobs(response: GreenhouseResponse, companyName: string, slug: string, fetchedAt: string): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const job of response.jobs ?? []) {
    const title = job.title ?? "";
    if (!ROLE_GATE.test(title)) continue;
    const url = job.absolute_url;
    if (!url || seen.has(title)) continue;
    seen.add(title);
    out.push({
      name: companyName,
      listing: "private",
      channel: "greenhouse-jd",
      term: "job title",
      // quote 就是岗位名本身，逐字。JD 正文（content）是转义 HTML，
      // 这一版不抽——岗位名已经足够回答「这个角色存不存在」，正文要回答的是
      // 「归属哪个部门、驻场多久」，那要人读，机器截一段反而误导。
      quote: `${title}${job.location?.name ? `（${job.location.name}）` : ""}`,
      sourceUrl: url,
      sourceTitle: title,
      fetchedAt,
    });
  }
  out.sort((a, b) => a.quote.localeCompare(b.quote));
  return out;
}

/** 组装最终文件。单独一个函数是为了让测试能直接断言产物形状。 */
export function buildCandidatesFile(input: {
  generatedAt: string;
  candidates: Candidate[];
  rejected: Rejection[];
  channels: Array<{ id: ChannelId; ok: boolean; detail: string }>;
}): CandidatesFile {
  return {
    generatedAt: input.generatedAt,
    readThisFirst: [
      "这份文件里没有一条结论。全部 relevance=unclear，全部证据 grade=unverified。",
      "「候选」的意思是「公开文本里出现了这个短语」，不是「这家公司在做 FDE 模式」。后者要人读过原文才能定。",
      "读的顺序按 strongestSignal：role-title（在招这个岗位，最硬）> first-person-org（自己说有这个组织）> org-description（正文提到，主语可能是别家）。",
      "org-description 这一档尤其要当心：实测有整段在说别家公司、而这家只是文件报送方的情况。",
      "别把这份文件自动灌进 lib/fde-roster.ts。名单是经过判断的东西，往里灌未读过的候选会重演 207 家语料「相关性混杂」的老问题。",
      "rejected 数组和 candidates 一样重要：它记着渠道漏了什么、为什么漏。只看 candidates 会误判渠道的覆盖能力。",
    ],
    terms: [...DISCOVERY_TERMS],
    channels: input.channels.map(item => ({ id: item.id, ...CHANNEL_META[item.id], ok: item.ok, detail: item.detail })),
    candidates: input.candidates,
    rejected: input.rejected,
  };
}

/** 候选文件里所有证据的级别。测试用它断言「一条都没被升级」。
 *  写成导出函数而不是让测试自己遍历：遍历逻辑放在被测代码这边，
 *  以后候选结构变了（比如证据嵌套一层），测试不用跟着改就仍然守得住。 */
export function allGrades(file: CandidatesFile): SourceGrade[] {
  return file.candidates.flatMap(item => item.evidence.map(entry => entry.grade));
}

export function allRelevances(file: CandidatesFile): Relevance[] {
  return file.candidates.map(item => item.relevance);
}
