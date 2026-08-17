// 美股 5% 以上股东抽取：从 DEF 14A（委托书）的 beneficial ownership 表里取持股。
//
// 为什么是 DEF 14A 而不是 10-K：10-K 里没有股东表（只有股份总数）。
// 为什么不是 13F：13F 是持有方申报的，要凑齐一家公司的股东得反查全市场，且只覆盖机构。
// DEF 14A 这张表是**发行人**申报的，口径方向跟 A 股「十大流通股东」一致。
// 依据是《交易所法》第 14(a) 条下的 Schedule 14A Item 6 / Reg S-K Item 403，
// 属于法定披露，定级 statutory。
//
// ============ 口径：美股这张表和 A 股/港股都不一样 ============
// 本项目反复栽在「数字逐字正确、但字段问的是别的问题」这类错误上。
// 引语校验拦不住——引语是对的。只有针对口径的断言能拦。这张表埋了四个坑：
//
// 1) **beneficial ownership ≠ 持股。** SEC Rule 13d-3 的定义包含「60 天内可取得的股份」
//    ——未行使的期权、可转换证券、待归属的 RSU 都算进去。所以这里的股数会**大于**
//    该股东实际登记在册的股份，百分比的分母也会因此按人不同（每个人的分母是
//    「已发行股份 + 他自己那 60 天内可取得的部分」）。同一列的百分比之间因此
//    **不能相加**，加出来的「前 N 名合计」是个没有意义的数。所以这里不算合计。
//
// 2) **百分比是按股份类别算的。** Palantir 有 A/B/F 三类股，还单列一列
//    「Percentage of Votes」（投票权比例，跟持股比例是两件事，B 类是超级投票权）。
//    取错列就是把投票权当成持股。我们只取「% of class」并把类别写进 value。
//
// 3) **同一张表里混着两类主体。** 表格上半是董事和高管（个人，持股常常远低于 5%），
//    下半是 5% 以上股东（机构）。中间只靠一行「5% Stockholders」这样的单元格分隔。
//    分不清就会把某个董事的 0.1% 和 Vanguard 的 10% 并列进「主要股东」。
//    我们只取 5% 那一段，理由：董事高管持股属于 team 维度，不是 shareholders 维度。
//
// 4) **Accenture 把两类主体放在两张表里。** ACN 的主表只有董事，5% 股东在后面
//    另一张 4 行的小表里，前面是一句散文（「no person beneficially owned more than 5%
//    of Accenture plc's Class X ordinary shares」）。所以「找到那张表」不能只找一张。
//
// ============ 为什么不能复用 htmlToPlain ============
// filing-sources.ts 里的 htmlToPlain 把所有标签删掉再合并空白。对 10-K 的散文没问题，
// 但表格会塌成一串连续数字，股东名和它那一行的比例再也配不上——
// 这跟 A 股年报 PDF 不加 -layout 是同一个失败。所以这里自己走一条保留 <tr>/<td>
// 结构的解析路径。

import type { Sourced, SourceGrade } from "./fde-dimensions";

export type UsHolderRow = {
  /** 股东名称，已去掉脚注上标和地址行 */
  name: string;
  /** 股数原文，如 "63,802,647" */
  shares: string;
  /** 占该类别比例，如 "10.4"（不带 %）；表里给 "*"（小于 1%）时为 null */
  pctOfClass: string | null;
  /** 该行还原成的文本，作为引语 */
  quote: string;
};

export type UsHolderTable = {
  rows: UsHolderRow[];
  /** 表格所属的股份类别，如 "Class A Common Stock"；判不出来则 null */
  shareClass: string | null;
};

/** 拆出所有 <table>，连同它在原文里的偏移（偏移用来看它前面那段散文）。 */
export function splitTables(html: string): Array<{ start: number; html: string }> {
  const tables: Array<{ start: number; html: string }> = [];
  const pattern = /<table[\s\S]*?<\/table>/gi;
  for (const match of html.matchAll(pattern)) {
    tables.push({ start: match.index ?? 0, html: match[0] });
  }
  return tables;
}

/** 单元格内 HTML → 文本。跟 htmlToPlain 的区别是它只处理一个格子，
 *  所以可以放心把所有空白合成一个空格而不会破坏结构。 */
function cellText(raw: string): string {
  return raw
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&#x2019;|&rsquo;/gi, "’")
    .replace(/&#8212;|&#x2014;|&mdash;/gi, "—")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

/** <table> → 二维单元格数组。空行（全部格子都空）丢掉，
 *  因为 EDGAR 的表格里充满了纯排版用的空行。 */
export function tableToCells(tableHtml: string): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
      cells.push(cellText(cellMatch[1]));
    }
    if (cells.some(cell => cell.length > 0)) rows.push(cells);
  }
  return rows;
}

/** 大额股数：至少 5 位含千分位。5 位是下限，因为 ACN 的小表里有 47,931,575，
 *  而董事持股常常是 4 位数——这个门槛顺带把「一看就不是机构」的行滤掉一部分。 */
const SHARE_CELL = /^\(?[\d,]{5,}\)?$/;

/** 一行「像不像数据行」：第一格是名字（≥3 个字母），后面某一格是大额股数。
 *
 *  为什么用结构判据而不是按标题定位：
 *  最初的做法是「找 beneficial ownership 标题，取它后面第一张表」，
 *  实测 6 家里错 3 家——SNOW 和 PL 命中的是目录/页脚里的 1 行小表，ACN 标题一次都没命中。
 *  改成「扫所有表、按行的形状打分」之后 6 家全中。 */
function scoreTable(cells: string[][]): number {
  let score = 0;
  for (const row of cells) {
    if (row.length < 2) continue;
    const first = row[0];
    if ((first.match(/[A-Za-z]/g) ?? []).length < 3) continue;
    if (row.slice(1).some(cell => SHARE_CELL.test(cell))) score += 1;
  }
  return score;
}

/**
 * 找出委托书里的 beneficial ownership 表。
 *
 * 返回可能多于一张：ACN 把董事和 5% 股东分成两张表（见文件头口径第 4 点）。
 * 门槛用 score >= 3：低于 3 行的「表」基本都是排版用的小方块。
 */
export function findOwnershipTables(html: string): Array<{ start: number; cells: string[][]; score: number }> {
  const found: Array<{ start: number; cells: string[][]; score: number }> = [];
  for (const table of splitTables(html)) {
    const near = cellText(html.slice(Math.max(0, table.start - 3000), table.start)).toLowerCase();
    const own = cellText(table.html).toLowerCase();
    // C3.ai 的表格自身文本里不含 "beneficial"（表头只写 Name / Shares / Percent），
    // 所以必须同时看它前面那 3000 字符的上下文，否则这一家会 0 分。
    if (!own.includes("beneficial") && !near.includes("beneficial")) continue;
    const cells = tableToCells(table.html);
    const score = scoreTable(cells);
    if (score >= 3) found.push({ start: table.start, cells, score });
  }
  found.sort((a, b) => b.score - a.score);
  return found;
}

/** 「5% 股东」小标题。委托书里这一段的写法各家不同，实测这几种覆盖 PLTR/SNOW/AI/PL/APPN。
 *  ACN 不在此列——它那句话是散文，见 FIVE_PCT_PROSE。 */
const FIVE_PCT_HEADING =
  /(greater than\s*5|more than\s*5|5%\s*(or greater\s*)?(stock|share|holder|owner)|five percent|principal (stockholders|shareholders)|substantial shareholder)/i;

// 这里曾经有个 DIRECTORS_HEADING，按董事高管小标题去划 5% 段的下界。
// 它被删掉是因为那个判据本身是错的：它要求出现 "executive"，
// 而 C3.ai 的小标题只写 "Directors and Officers"，于是下界没划上，
// 23 行董事持股全被当成 5% 以上股东抽了出来。
// 现在的下界判据是「之后任何一个单格行」——不认字面词，只认表格结构。

/**
 * 从一张混合表里切出「5% 以上股东」那一段。
 *
 * 判据是「单格行」：表格里用来当小标题的那一行只有一个非空单元格
 * （其余格子是空的占位 <td>）。这比按行号切稳——各家董事人数不一样。
 *
 * 切不出来就返回 null（而不是退回整张表）。理由：整张表含董事高管，
 * 把他们并进「主要股东」是文件头第 3 点那个错。宁可这家显示空缺。
 */
export function sliceFivePercentRows(cells: string[][]): string[][] | null {
  const labelRows: Array<{ index: number; text: string }> = [];
  cells.forEach((row, index) => {
    const filled = row.filter(cell => cell.length > 0);
    if (filled.length === 1) labelRows.push({ index, text: filled[0] });
  });

  const startLabel = labelRows.find(row => FIVE_PCT_HEADING.test(row.text));
  if (!startLabel) return null;

  // 下界：5% 段之后**任何**一个单格小标题。
  //
  // 一开始只把「董事高管」那几种写法当下界，结果 C3.ai 漏了——
  // 它的下界写作「Directors and Officers」，不含 "executive"，正则没命中，
  // 于是 5% 段一路吃到表尾，23 行里混进了全部董事高管（正是文件头第 3 点那个错）。
  // 改成「下一个单格行就是边界」之后不需要枚举各家写法：
  // 单格行在这类表里只有一个用途，就是当小标题。
  const endLabel = labelRows.find(row => row.index > startLabel.index);
  const end = endLabel ? endLabel.index : cells.length;
  return cells.slice(startLabel.index + 1, end);
}

/** 百分比格：可能写成 "10.4", "10.4%", "*"（表示小于 1%）。
 *  "*" 要认出来但不能当成 0——它是「小于 1%」，不是零。 */
const PCT_CELL = /^\(?(\d{1,2}(?:\.\d+)?)\s*%?\)?$/;
const LESS_THAN_ONE = /^\*+$/;

/** 名字格里可能连着地址一起（ACN 的表头就叫「Name and Address of Beneficial Owner」，
 *  一格里是「The Vanguard Group 100 Vanguard Blvd. Malvern, PA 19355 (1)」）。
 *
 *  必须**截掉**地址而不是丢掉整行——一开始写成「含地址特征就跳过」，
 *  结果 ACN 两个股东全被滤光了。地址是名字的一部分，不是另一行。 */
/** 判据是「门牌号」：一个 1~5 位数字，后面跟一个大写开头的词。
 *
 *  为什么不枚举 Street/Avenue/Suite 这些词：BlackRock 的地址是
 *  「50 Hudson Yards New York, NY 10001」，没有任何街道后缀词，
 *  枚举法漏掉它，结果股东名变成「BlackRock, Inc. 50 Hudson Yards New York」。
 *  门牌号这个判据不依赖词表。风险是名字里本来就带数字的机构会被截断，
 *  所以要求数字前必须是空格且数字后紧跟大写词——「3M Company」「Fivespan Partners」
 *  这类都不匹配（前者数字后是小写 M 的一部分，后者根本没有独立数字）。 */
const ADDRESS_START = /\s(?=\d{1,5}\s+[A-Z])|\sP\.?O\.?\s+Box\s/;

/** 州缩写白名单。
 *
 *  为什么必须白名单而不是 /[A-Z]{2}$/：后者把「Fivespan Partners, LP」的 LP
 *  当成州缩写切掉了，股东名少了组织形式。LP / LLC / PC / SA 这些都是两个大写字母。 */
const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

function stripAddress(raw: string): string {
  const match = ADDRESS_START.exec(raw);
  const cut = match ? raw.slice(0, match.index) : raw;
  // 收尾：截完可能留下「…Malvern, PA」这种残片。只切真州名。
  const tail = /,\s*([A-Z]{2})\s*$/.exec(cut);
  const trimmed = tail && US_STATES.has(tail[1]) ? cut.slice(0, tail.index) : cut;
  return trimmed.replace(/[,\s]+$/, "").trim();
}

function stripFootnotes(raw: string): string {
  return raw
    .replace(/\((\d{1,2}|[a-z])\)/g, " ")
    .replace(/\[\d+\]/g, " ")
    .replace(/[†‡§¶*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 把切好的行转成结构化股东行。
 *
 * 取「第一个大额股数」和「它之后的第一个百分比」，而不是「最后一个百分比」。
 * 跟港股相反，理由是版面不同：港股一行有「占类别 / 占总股本」两列，要后者；
 * 美股这张表一行是「股数 / 占该类别比例」，有些公司（PLTR）在后面还多一列
 * 「Percentage of Votes」——那是**投票权**，不是持股（B 类股一股多票）。
 * 取最后一个就会把投票权当持股，正是文件头第 2 点那个错。
 */
export function parseUsHolderRows(rows: string[][]): UsHolderRow[] {
  const out: UsHolderRow[] = [];
  for (const row of rows) {
    const filled = row.filter(cell => cell.length > 0);
    if (filled.length < 2) continue;

    const name = stripAddress(stripFootnotes(filled[0]));
    if ((name.match(/[A-Za-z]/g) ?? []).length < 3) continue;
    // 「as a group」是汇总行，不是某个股东。放进主要股东列表是错的口径。
    if (/as a group|all directors|total/i.test(name)) continue;

    const shareIndex = filled.findIndex((cell, index) => index > 0 && SHARE_CELL.test(cell));
    if (shareIndex < 0) continue;
    const shares = filled[shareIndex].replace(/[()]/g, "");

    let pctOfClass: string | null = null;
    for (const cell of filled.slice(shareIndex + 1)) {
      if (LESS_THAN_ONE.test(cell)) break; // 小于 1%，留 null 而不是写 0
      const match = PCT_CELL.exec(cell);
      if (match) {
        pctOfClass = match[1];
        break;
      }
    }

    out.push({ name, shares, pctOfClass, quote: filled.join(" | ") });
  }
  return out;
}

/**
 * 独立的 5% 股东小表（Accenture 那种）。
 *
 * 为什么需要这条单独的路：ACN 的主表只有董事高管，5% 股东在后面另一张 4 行小表里，
 * 前面是一句散文（「Beneficial Ownership of More Than 5% ... no person beneficially
 * owned more than 5% of Accenture plc's Class X ordinary shares」）。
 * 这张小表只有 2 个股东，scoreTable 打 2 分，过不了主检测的 >=3 门槛——
 * 那个门槛是为了滤掉排版用的小方块，不能为它放宽（放宽会引进一堆噪声表）。
 * 所以这里换判据：**它前面那段散文里必须出现「more than 5%」这类措辞**，
 * 再加「表内有大额股数行」。散文锚点比行数可靠。
 */
export function findStandaloneFivePercentTable(html: string): { start: number; cells: string[][] } | null {
  const candidates: Array<{ start: number; cells: string[][]; rows: number }> = [];
  for (const table of splitTables(html)) {
    const near = cellText(html.slice(Math.max(0, table.start - 2000), table.start));
    if (!/(more than|greater than|exceeding)\s*5\s*%/i.test(near)) continue;
    const cells = tableToCells(table.html);
    const rows = scoreTable(cells);
    if (rows < 1 || cells.length > 12) continue; // 大表交给主检测，这里只收小表
    candidates.push({ start: table.start, cells, rows });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.rows - a.rows);
  return { start: candidates[0].start, cells: candidates[0].cells };
}

/** 表格所属的股份类别。判不出来返回 null——
 *  单一股份类别的公司本来就不写，null 是正确答案不是失败。 */
export function shareClassOfTable(html: string, tableStart: number, cells: string[][]): string | null {
  const header = cells.slice(0, 4).flat().join(" ");
  const near = cellText(html.slice(Math.max(0, tableStart - 1200), tableStart));
  const match = /(Class\s+[A-Z]\s+(?:Ordinary Shares|Common Stock|ordinary shares|common stock))/.exec(`${header} ${near}`);
  return match ? match[1].replace(/\s+/g, " ") : null;
}

/** 「as of <日期>」= 这张横截面表的记录日（record date）。
 *
 *  跟港股同一个理由：委托书的**提交日**和表的**记录日**不是一天。
 *  也跟港股一样，日期只做字符串处理，不构造 Date——
 *  `new Date("December 31, 2025").toISOString()` 在东八区会退成 12-30，
 *  日期漂一天会在变更页里渲染成一条假变更。 */
const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

export function recordDate(html: string, tableStart: number): string | null {
  // 窗口要 8000 而不是 3000：Snowflake 把「as of April 30, 2026」写在一大段
  // 计算口径说明的中间，离表格 5000 多字符。窗口短了不是抽错，是静默抽不到。
  // 用 cellText 而不是原始 HTML：Palantir 写的是「as of April&#160;6, 2026」，
  // 不解实体的话 \s 匹配不上 &#160;，日期会漏。
  const near = cellText(html.slice(Math.max(0, tableStart - 8000), tableStart));
  // 取**最后**一个匹配：离表格最近的那个才是这张表的口径日期，
  // 前面可能还有别的章节留下的日期。
  const matches = [...near.matchAll(/as of\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/gi)];
  if (!matches.length) return null;
  const match = matches[matches.length - 1];
  const month = MONTHS[match[1].toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${month}-${match[2].padStart(2, "0")}`;
}

/** 口径说明，跟着事实一起进 value。
 *  写在 value 里而不只写注释：报告是给别人看的，读者拿到 6.9% 时
 *  必须同时知道它含 60 天内可取得的股份、且是占某一类股份的比例。 */
export const US_BASIS =
  "口径：SEC Rule 13d-3 实益拥有权（含 60 天内可取得的股份，如期权/可转换证券/待归属 RSU），" +
  "非登记在册持股；百分比为占该股份类别的比例，非占总股本，亦非投票权比例；" +
  "仅取「5% 以上股东」段，董事高管持股不在此列；因各人分母不同，比例之间不可相加";

function toSourced(
  value: string,
  source: string,
  sourceUrl: string,
  fetchedAt: string,
  quote: string,
  grade: SourceGrade = "statutory",
): Sourced {
  return { value, grade, source, sourceUrl, fetchedAt, quote };
}

/**
 * 抽出 majorHolders 一条事实。
 *
 * 跟港股那条一样，刻意**不**填 institutional（那个字段问的是机构持仓合计，
 * 这张表分不出机构/个人——C3.ai 的第一名 Thomas M. Siebel 是创始人个人持股），
 * 也**不**填 controller（实际控制人是法律认定，不是「持股最多的那个」；
 * Palantir 的控制权在创始人投票协议里，不在这张 5% 表里）。
 * 更不填「前 N 名合计」——见文件头口径第 1 点，分母不同不能相加。
 */
export function extractUsHolderFacts(
  html: string,
  source: string,
  sourceUrl: string,
  fetchedAt: string,
): { majorHolders?: Sourced } {
  const main = findOwnershipTables(html)[0];
  let cells = main ? sliceFivePercentRows(main.cells) : null;
  let anchor = main?.start ?? 0;
  let shareClass = main ? shareClassOfTable(html, main.start, main.cells) : null;

  if (!cells) {
    const standalone = findStandaloneFivePercentTable(html);
    if (!standalone) return {};
    cells = standalone.cells;
    anchor = standalone.start;
    shareClass = shareClassOfTable(html, standalone.start, standalone.cells);
  }

  const rows = parseUsHolderRows(cells);
  if (!rows.length) return {};

  const asOf = recordDate(html, anchor);
  const rendered = rows
    .map(row => `${row.name} ${row.pctOfClass ? `${row.pctOfClass}%` : "<1%"}（${row.shares} 股）`)
    .join("；");
  const classNote = shareClass ? `股份类别：${shareClass}。` : "";
  const prefix = asOf ? `截至 ${asOf}：` : "";

  return {
    majorHolders: toSourced(
      `${prefix}${rendered}。${classNote}${US_BASIS}`,
      source,
      sourceUrl,
      fetchedAt,
      rows.slice(0, 3).map(row => row.quote).join(" / "),
    ),
  };
}
