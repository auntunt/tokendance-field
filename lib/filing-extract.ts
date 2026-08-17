// 从法定披露原文里抽字段。规则式，不过模型。
//
// ============ 为什么这一层不用模型 ============
// 报告里每条事实都要能被读的人点回原文核对。规则抽出来的东西有两个性质是
// 模型给不了的：一是同样输入永远同样输出（定期重跑时「变更页」才有意义，
// 否则模型的措辞漂移会显示成一堆假变更）；二是抽不到就是抽不到，
// 不会为了填满字段而顺手编一个看起来合理的值。
//
// 这里的每条规则都必须返回 quote —— 原文逐字片段。抽不出 quote 的一律返回 null。
// 理由：没有 quote 就没法核对，而不能核对的「法定披露级」比空着更危险。
//
// ============ 刻意不抽的东西 ============
// 「前 10 名股东」那张表。PDF 转文本后单元格竖排拆行，公司名和它那一行的
// 持股比例对不上（实测「中国移动通信有限公司」被拆成三行、中间还插着别的列）。
// 要配对就得靠猜，而把某个比例配到错误的股东名下，比这一格空着有害得多——
// 空格会显示成待办，错配会以「法定披露」的最高可信度出现在报告里。
// 版面分析是另一个量级的工程，这一版明确不做，报告里这格就该是空的。
//
// 相反，年报里大量「标签换行接值」的字段是干净的（控股股东性质、研发人员数量、
// 实际控制人姓名、员工构成合计），这些才是这一层抽的东西。

import type { DimensionId, SourceGrade, Sourced } from "./fde-dimensions";

export type Extracted = {
  dimension: DimensionId;
  key: string;
  value: string;
  quote: string;
};

/** 把抽取结果装成带出处的事实。级别由「这是什么文件」决定，不由抽取方式决定。 */
export function toSourced(item: Extracted, source: string, sourceUrl: string, fetchedAt: string, grade: SourceGrade = "statutory"): Sourced {
  return { value: item.value, grade, source, sourceUrl, fetchedAt, quote: item.quote };
}

/** 取 label 之后最近的一个「像值」的片段。
 *
 *  年报版面的通例是标签和值同行、中间大量空格；被挤到下一行的也很常见。
 *  所以往后看一小段窗口，而不是只看当前行——窗口开小是故意的：
 *  开大了会跨到下一个标签的值上去，抽出来的东西看着有值其实错位。 */
/** 值本身允许超出 window 的余量。够长到容下一个完整的数字或短语，
 *  又短到不会跨进下一个表格单元格（空行截断仍然先生效）。 */
const VALUE_TAIL = 40;

function afterLabel(text: string, label: RegExp, valuePattern: RegExp, window = 160): { value: string; quote: string } | null {
  // 试遍所有出现位置，而不是只试第一处。
  // 为什么：10-K 里「we had 」先出现在一句无关的话里（讲历史增长），
  // 只看第一处会抽空，而真正的员工数在第三处。实测踩过这个。
  const scan = new RegExp(label.source, label.flags.includes("g") ? label.flags : label.flags + "g");
  for (let match = scan.exec(text); match; match = scan.exec(text)) {
    // 窗口在第一个空行处截断。
    // 年报的通例是「标签　值」同在一个表格行内，空行标志这一行结束；
    // 跨过空行再找到的数字属于下一个字段。实测：
    // 「报告期末在职员工的数量合计（人） 16,818」后面紧跟空行，
    // 再往下是「当期领取薪酬员工总人数（人） 19,254」——
    // 不截断的话，标签缺值时会把 19,254 抽成员工总数，
    // 而错位的值在报告里看起来和正确的值一模一样，比空着危险得多。
    // window 限定的是「值可以从哪里开始」，不是「值可以延伸到哪里」。
    // 两者混在一起会把值本身截断：pdftotext -layout 的表格行里标签和数字之间
    // 隔着几十个空格，恒生电子「现场实施 … 1,567」整行长度超过 60，
    // 于是 window=60 正好切在数字中间，抽出「1,56」——比抽空危险得多，
    // 因为 1,56 看上去仍像一个人数。所以先按 window 找起点，
    // 再从起点往后单独给值留出余量去匹配。
    const raw = text.slice(match.index, match.index + window + VALUE_TAIL);
    const cut = raw.search(/\n[ \t]*\n/);
    const slice = cut > 0 ? raw.slice(0, cut) : raw;
    const body = slice.slice(match[0].length);
    const found = valuePattern.exec(body);
    // 起点必须落在 window 之内；越界说明这一处的标签后面没跟值。
    if (!found || match[0].length + found.index > window) continue;
    const quote = slice.slice(0, match[0].length + found.index + found[0].length).replace(/\s+/g, " ").trim();
    return { value: found[0].trim(), quote };
  }
  return null;
}

/** 年报里大量是非项写成「□适用☑不适用」这样的勾选框。
 *  直接把这串符号当值填进报告是没用的——读的人看不出它在回答什么问题。
 *  所以在这一层就翻成人话，并把紧随其后的说明句一起带上。 */
function checkbox(text: string, label: RegExp, applies: string, notApplies: string, window = 220): { value: string; quote: string } | null {
  const scan = new RegExp(label.source, label.flags.includes("g") ? label.flags : label.flags + "g");
  for (let match = scan.exec(text); match; match = scan.exec(text)) {
    const slice = text.slice(match.index, match.index + window);
    const box = /([□☑])\s*适用\s*([□☑])\s*不适用/.exec(slice);
    if (!box) continue;
    const checkedApplies = box[1] === "☑";
    // 勾选后面往往紧跟一句说明（「公司报告期控股股东未发生变更。」），
    // 它比勾选本身有信息量，能带上就带上。
    const tail = /[。\n]\s*([^\n。]{6,60}。)/.exec(slice.slice(box.index + box[0].length));
    const note = tail?.[1]?.trim();
    const value = note ? `${checkedApplies ? applies : notApplies}——${note}` : checkedApplies ? applies : notApplies;
    return { value, quote: slice.slice(0, box.index + box[0].length + (note ? note.length + 2 : 0)).replace(/\s+/g, " ").trim() };
  }
  return null;
}

/** 抓一整段（从标题到下一个标题），用作 quote。段落太长的截断，
 *  截断时保留开头——披露文本的结论通常在段首。 */
function section(text: string, start: RegExp, maxLen = 400): { value: string; quote: string } | null {
  const match = start.exec(text);
  if (!match) return null;
  const raw = text.slice(match.index, match.index + maxLen).replace(/\s+/g, " ").trim();
  if (!raw) return null;
  return { value: raw.slice(0, 220), quote: raw };
}

const NUM = /-?[\d,]+(?:\.\d+)?/;
const PCT = /-?[\d.]+%/;

/** A 股年报的抽取规则。
 *  每条规则都独立——一条抽不到不影响其它条，因为不同公司的年报缺项各不相同。 */
export function extractFromAnnualReport(text: string): Extracted[] {
  const out: Extracted[] = [];
  const push = (dimension: DimensionId, key: string, hit: { value: string; quote: string } | null) => {
    if (hit && hit.value.trim()) out.push({ dimension, key, value: hit.value.trim(), quote: hit.quote });
  };

  // ---- 股东信息 ----
  // 实控人：年报有「实际控制人姓名」表格，也有正文「公司实际控制人为 XXX」。
  // 两种都试，正文那句更可靠（表格会被拆行）。
  // 姓名属于公开职业事实（法定披露强制公开实控人身份），符合 lib/ontology.ts 的边界。
  //
  // 两条都用 ^ 锚住：值必须紧跟在标签后面，中间不许隔着换行。
  // 不锚的话，标签后面没有合法人名时会一路往后扫，扫到几行之后
  // 毫不相关的中文短语上——用友网络实测抽出「子公司详见附注十」当实控人，
  // 而它带着完整引语、级别写着「法定披露」，页面上看不出是错的。
  // 行尾也要算合法终止符：年报正文里「本企业最终控制方是王文京」后面直接换行，
  // 只认标点的话真名反而被跳过，空着又让上面那种误配有机会补位。
  push("shareholders", "controller",
    afterLabel(text, /公司实际控制人为/, /^[ \t]*[一-龥]{2,8}(?=[，。、（(\n]|及其|$)/, 60)
    ?? afterLabel(text, /本企业最终控制方是/, /^[ \t]*[一-龥]{2,8}(?=[，。、（(\n]|$)/, 60)
    ?? afterLabel(text, /实际控制人性质：/, /^[ \t]*[^\s]{2,20}/, 80));

  // 控股股东：注意「无控股主体」也是一个有效答案（股权分散），
  // 它恰恰是股东结构的关键事实，不能因为不是人名就丢掉。
  push("shareholders", "majorHolders",
    afterLabel(text, /控股股东性质[：:]/, /[^\s]{2,24}/, 80));

  // 股权结构变动：只取「是否变更」这个明确的是非项。
  push("shareholders", "capTable",
    checkbox(text, /控股股东报告期内变更/, "报告期内控股股东发生变更", "报告期内控股股东未发生变更", 200));

  // ---- 团队 ----
  // headcount 这个字段的 label 是「交付团队规模」，不是「公司总人数」。
  // 年报的「专业构成」里有「技术人员」一行，那才是最接近交付人力的口径
  // （软通动力 91,849 人里技术人员 85,978——两个数放在这一格里意思完全不同）。
  // 所以优先取技术人员，并且把总人数一起写出来给分母，让人自己看比例；
  // 没有专业构成表时才退回总人数，且必须标明这是全员口径。
  {
    // 「技术人员」这三个字必须锚定在「专业构成」那张表里取，不能全文找第一处。
    // 原因是它在年报里到处出现，而且都不是人数：
    //   ·「核心技术人员、持股 5%以上股东…」——这是关联关系声明的套话
    //   ·「为技术人员提供专业开发环境…大模型智能体平台 6,166,665.17」——
    //      后面那个数是产品收入金额，抽出来会变成「东方国信有 616 万技术人员」
    // 实测这两种误配都发生过（科大讯飞抽成 5 人、东方国信抽成 6,166,665 人）。
    // 所以先切出专业构成表的范围，只在里面找。
    const tableStart = /专业构成类别/.exec(text);
    const tableEnd = tableStart ? text.indexOf("教育程度", tableStart.index) : -1;
    const table = tableStart
      ? text.slice(tableStart.index, tableEnd > 0 ? tableEnd : tableStart.index + 600)
      : "";
    // 各家的专业构成分类名不统一。「技术人员」是最常见的写法，但恒生电子
    // 分得更细，直接有一行「现场实施 1,567」——那是字面意义上的驻场交付人数，
    // 比任何「技术人员」都更接近这份报告要问的东西，必须优先取它。
    // 顺序即优先级：越接近「交付」的口径排越前。
    const tech = table
      ? (afterLabel(table, /现场实施/, NUM, 60)
        ?? afterLabel(table, /交付人员/, NUM, 60)
        ?? afterLabel(table, /实施人员/, NUM, 60)
        ?? afterLabel(table, /技术人员/, NUM, 60)
        ?? afterLabel(table, /产品技术/, NUM, 60))
      : null;
    // 取到的是哪一类要写进值里——「现场实施 1,567」和「技术人员 1,567」
    // 在这份报告里的含义完全不同，不标出来读的人无从判断。
    const techLabel = tech
      ? (["现场实施", "交付人员", "实施人员", "技术人员", "产品技术"].find(name => tech.quote.includes(name)) ?? "技术人员")
      : "技术人员";
    const all = afterLabel(text, /报告期末在职员工的数量合计（人）/, NUM, 120)
      ?? afterLabel(text, /在职员工的数量合计/, NUM, 120);
    // 数值自检：技术人员不可能多于全体员工。
    // 锚定已经挡掉了已知的两种误配，但版面还会变，而这一层的错误
    // 会以「法定披露」的最高可信度出现在报告里。所以留一道算术闸门：
    // 不成立就退回只报全员，宁可少一个数，不要一个不可能的数。
    const toNumber = (raw: string) => Number(raw.replace(/,/g, ""));
    const sane = tech && all && toNumber(tech.value) > 0 && toNumber(tech.value) <= toNumber(all.value);
    if (tech && all && sane) {
      push("team", "headcount", {
        value: `${techLabel} ${tech.value} 人 / 全员 ${all.value} 人（年报「专业构成」口径）`,
        quote: `${tech.quote}｜${all.quote}`,
      });
    } else if (all) {
      push("team", "headcount", { value: `全员 ${all.value} 人（年报未披露专业构成，非交付口径）`, quote: all.quote });
    }
  }

  // 交付/技术团队规模。放在 fdeLeads（「谁负责交付」）而不是 execs——
  // execs 是「核心高管与分工」，研发人员总数不回答那个问题，填进去就是错标。
  // 这里明确写成「研发人员」而不是「交付人员」：年报的口径是研发，
  // 把它当交付人数用是我们的推断，推断不能伪装成披露原文。
  {
    const rd = afterLabel(text, /研发人员数量（人）/, NUM, 120);
    if (rd) push("team", "fdeLeads", { value: `研发人员 ${rd.value} 人（年报口径为研发，非交付岗口径）`, quote: rd.quote });
  }

  // ---- 业务 ----
  push("business", "customers",
    afterLabel(text, /前五名客户合计销售金额占年度销售总额比例/, PCT, 160));

  push("business", "whatTheySell",
    section(text, /公司从事的主要业务|报告期内公司所处行业情况|主要业务及经营模式/, 500));

  // ---- FDE 落地方式 ----
  // ratio 这个字段问的是「交付人数与客户数之比」。年报给不出这个比值：
  // 它披露研发人员占比，不披露客户数（只披露前五大客户的销售额占比）。
  // 所以这一格**故意留空**，不拿研发占比去顶。
  // 曾经想过把 59.70% 填进去——那会让读报告的人以为我们拿到了人效数据，
  // 而它其实只是研发人员在全体员工里的比例，和客户数一点关系都没有。
  // 研发占比本身有价值，放进「产品化路径」的观察材料里，标明口径。
  {
    const rd = afterLabel(text, /研发人员数量占比/, PCT, 120);
    if (rd) push("fde", "productization", { value: `研发人员占全体员工 ${rd.value}（年报口径，用于观察研发/交付人力结构）`, quote: rd.quote });
  }

  // ---- 背景调查 ----
  push("background", "litigation",
    checkbox(text, /重大诉讼、仲裁事项/, "报告期内有重大诉讼或仲裁", "报告期内无重大诉讼、仲裁事项", 260));

  push("background", "partnerships",
    checkbox(text, /与日常经营相关的关联交易/, "报告期内有日常经营关联交易", "报告期内无日常经营关联交易", 200));

  return out;
}

/** 10-K 的抽取规则。英文披露的行内散文比中文表格好抽，
 *  但数字大多在 XBRL 表格里，这一版不抽表格。 */
export function extractFrom10K(text: string): Extracted[] {
  const out: Extracted[] = [];
  const push = (dimension: DimensionId, key: string, hit: { value: string; quote: string } | null) => {
    if (hit && hit.value.trim()) out.push({ dimension, key, value: hit.value.trim(), quote: hit.quote });
  };

  push("team", "headcount",
    afterLabel(text, /we had /, /[\d,]+ full-time employees/, 80));

  push("business", "whatTheySell",
    section(text, /Overview\s+We (?:build|are|provide)|Our platforms/, 500));

  push("background", "competitors",
    section(text, /Competition\s+(?:We|The market)/, 400));

  push("background", "litigation",
    section(text, /Legal Proceedings\s+(?:From time to time|We are|For a discussion)/, 300));

  return out;
}

/** 「他们怎么称呼这个角色」——全文词频核查。
 *
 *  为什么单独做一条：这是整份报告里最核心的问题，而它的答案可能是**零**。
 *  实测 Palantir 2025 年 10-K 里「Forward Deployed」出现 0 次，
 *  而 FDE 这个词本身就出自这家公司。这个「0」是有信息量的结论：
 *  说明这个岗位名不进法定披露，只活在招聘页和对外叙事里。
 *  所以命中和未命中都要产出一条事实，而不是没命中就沉默。 */
export function termAudit(text: string, terms: string[]): { value: string; quote: string } {
  const counts = terms.map(term => {
    const matches = text.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));
    return { term, count: matches?.length ?? 0 };
  });
  const hit = counts.filter(item => item.count > 0);
  const value = hit.length
    ? hit.map(item => `${item.term}×${item.count}`).join("、")
    : `全文未出现：${terms.join(" / ")}`;

  // quote：命中就给第一处上下文，未命中给不出上下文，写明核查范围与字数，
  // 让读的人知道这个「0」是在多大范围里数出来的。
  let quote = `全文 ${text.length} 字符内检索：${counts.map(item => `${item.term}=${item.count}`).join(", ")}`;
  if (hit.length) {
    const first = new RegExp(hit[0].term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").exec(text);
    if (first) quote = text.slice(Math.max(0, first.index - 150), first.index + 250).replace(/\s+/g, " ").trim();
  }
  return { value, quote };
}
