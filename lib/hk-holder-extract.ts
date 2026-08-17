// 港股主要股东抽取：从年报《董事会报告》里那张「主要股东」表取持股。
//
// 法律依据（写进 value 里，因为口径的合法性来自它）：
// 表的标题是 SUBSTANTIAL SHAREHOLDERS，内容是「根据证券及期货条例（SFO）第XV部
// 第2、3分部须向公司及联交所披露、并记录于按第336条存置的登记册内的权益」。
// 这是**法定披露**，所以定级 statutory —— 比 A 股那条东方财富 F10 路线
// （independent，二手结构化数据）高一级。
//
// ============ 口径：这个文件最容易出错的地方 ============
// 本项目反复栽在同一类错误上：数字**逐字正确**，但被放进了一个在问别的问题的字段里。
// 引语校验拦不住这种错——引语是对的。只有针对口径的断言能拦。
//
// 港股这张表专门埋了三个坑，全部实测过：
//
// 1) **一行有两个百分比列，含义不同。** 第四范式（6682）的表头是
//    「percentage of shareholding in Domestic Shares/H Shares of the Company」
//    和「percentage of shareholding in the total share capital of the Company」。
//    Beijing New Wisdom 那一行是 18.62% 和 7.13%。18.62% 是「占内资股这一类的比例」，
//    7.13% 才是「占总股本」。商汤（0020）同样两列：17.35%（占该类别）/ 17.08%（占总股本）。
//    我们统一取**最后一个**百分比 = 占已发行总股本。理由：这是唯一在四家之间
//    可比的口径，也是唯一能回答「主要股东及持股比例」这个字段标签的数。
//    取错列的后果不是差几个点——是把「占某一类股份的比例」冒充成「占公司的比例」。
//
// 2) **同一个股东会占多行，因为按股份类别分开披露。** 6682 的 Beijing New Wisdom
//    同时持内资股（占总股本 7.13%）和 H 股（5.23%）。**绝不把这两个数加起来**：
//    加总是一次口径转换，需要确认两行是同一主体且无重叠计算（Paradigm Investment
//    和 Paradigm Chuqi 就是「受控法团权益」互相穿透的同一批股份，加起来会重复计算）。
//    我们原样保留每一行并标注股份类别，让报告显示「7.13%（Domestic Shares）」，
//    而不是自己算一个总数。
//
// 3) **5% 门槛是按类别算的，所以会看到占总股本远低于 5% 的行。** 商汤的
//    Vision Worldwide 占 A 类股 16.97%，但只占总股本 0.26%。这**不是**脏数据，
//    不能按「小于 5% 就丢掉」过滤——那样会丢掉一个真实的主要股东。
//
// 另外：(L) = 好仓（long position），(S) = 淡仓（short），(P) = 可供借出的股份。
// 只取 (L)。淡仓不是持股，混进「持股比例」是纯错。
//
// ============ 刻意不做的事 ============
// 不算「前 N 名合计」。港股这张表的行数由 5% 法定门槛决定，不是「前十」，
// 各家行数不一样（0354 是 2 行、0020 是 4 行、6682 是 8 行），
// 合计之间不可比；而且上面第 2 点说了，穿透持股加总会重复计算。
// A 股那条路线能给「前十合计」是因为那是固定的十大流通股东口径。这里没有对应物，
// 就空着——空格在报告里显示成待办，错数会以最高可信度出现在报告里。

import type { Sourced, SourceGrade } from "./fde-dimensions";

export type HkHolderRow = {
  /** 股东名称，已去掉「(Note 3)」这类脚注标记 */
  name: string;
  /** 占已发行总股本的比例，如 "7.13"（不带 %） */
  totalPct: string;
  /** 股份类别，如 "Domestic Shares" / "H Shares" / "Class B Shares"；无法判定时 null */
  shareClass: string | null;
  /** 该行原文，作为引语 */
  quote: string;
};

/** 表头锚点。中英文都要认：金蝶（0268）是中英对照排版，英文标题被中文标题挤到别处，
 *  只认英文会漏。 */
const ANCHOR = /SUBSTANTIAL SHAREHOLDER|Substantial Shareholders['’]\s*Interests|主要股東及其他人士|主要股東/g;

/** 股数：至少 7 位含千分位，用来确认「这一行是数据行不是表头」。
 *  为什么要这个而不是只看百分比：表头行里也会出现 "(2)" 之类的数字，
 *  但不会出现 37,034,191 这种量级的股数。 */
const SHARES = /^[\d,]{7,}/;

/** 百分比 + 可选的好仓/淡仓标记。金蝶把 (L)/(S) 直接缀在百分比后面：19.23% (L)。 */
const PCT_WITH_SIDE = /(\d+\.\d+)\s*%\s*(\((?:L|S|P)\))?/g;

/** 股份类别的两种出现位置，都得认（-layout 会按原版面断行）：
 *
 *  A) 紧跟在股数后面，同一行：「19,684,400 H Shares (L)」「37,034,191 Domestic」
 *     —— 注意第二个例子里 "Shares" 被断到下一行了，所以只能匹配限定词本身。
 *  B) 完全落在下一行的股数列位置：商汤是「6,906,080,602 …17.35% …17.08%」
 *     下一行才是「Class B Shares」。
 *
 *  为什么不能把整段合并起来用「Domestic\s+Shares」去匹配：合并后中间会插进
 *  别的列（"Domestic  18.62%  corporations  Shares"），连不上；而单独匹配裸 "H"
 *  又会命中一堆无关的字母。所以按位置分两种情况处理。 */
const CLASS_AFTER_NUM = /^\s*(Domestic|H|Class\s+[AB])\b/;
const CLASS_FULL = /(Domestic|H|Class\s+[AB])\s+Shares/i;

/** 股数：不带 % 的大额数字。用 end 位置来判断续行是否属于同一列。 */
const SHARES_IN_LINE = /([\d,]{7,})(?!\s*%)/;

/** 把限定词补成完整类别名，报告里显示的是这个串。 */
function normalizeClass(qualifier: string): string {
  const cleaned = qualifier.replace(/\s+/g, " ").trim();
  return /^Class/i.test(cleaned) ? `${cleaned} Shares` : `${cleaned} Shares`;
}

/** 从一行（及其后续行）判定股份类别。找不到就返回 null——
 *  单一股份类别的公司（0354、0268）本来就没有这一列，null 是正确答案，不是失败。 */
function shareClassOf(lines: string[], index: number, sharesEnd: number): string | null {
  const line = lines[index];
  const rest = line.slice(sharesEnd);
  const immediate = CLASS_AFTER_NUM.exec(rest);
  if (immediate) return normalizeClass(immediate[1]);

  // 往后看两行，只看股数列附近的窗口，避免命中别的列里的字。
  for (const next of lines.slice(index + 1, index + 3)) {
    const window = next.slice(Math.max(0, sharesEnd - 40), sharesEnd + 40);
    const full = CLASS_FULL.exec(window);
    if (full) return normalizeClass(full[1]);
  }
  return null;
}

/** 去掉股东名后面的脚注标记：「Beijing New Wisdom(3) (4)」→「Beijing New Wisdom」，
 *  「Bank of Communications Trustee (Note 1)」→「Bank of Communications Trustee」。 */
function stripNotes(raw: string): string {
  return raw
    .replace(/\s*\((?:Note|附註|附注)\s*\d+\)/gi, "")
    .replace(/\s*\(\d+\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 月份名 → 月份数字。
 *
 *  为什么手写映射而不用 new Date(...)：
 *  `new Date("31 December 2025").toISOString()` 在东八区会退成 2025-12-30——
 *  实测四家报告全被算成 12-30，而原文写的是 31 December 2025。
 *  这个项目要求「定期重跑结果可比」，日期漂一天会在变更页里渲染成一条假变更。
 *  lib/holder-extract.ts 里已经为同一个理由约定了「日期只做字符串处理」，这里照办。 */
const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

/** 一行里字母/汉字够不够多，用来排除纯数字行和分隔行。 */
function looksLikeName(text: string): boolean {
  return (text.match(/[A-Za-z一-鿿]/g) ?? []).length >= 3;
}

/**
 * 找到那张表。
 *
 * 为什么不能直接用第一个锚点：这几个词在年报里出现好几次——目录、
 * 「主要股东权益」章节的交叉引用、以及真正的表。商汤（0020）的第一个命中
 * 落在脚注区（两栏排版把脚注和正文交错在一起），取到的是一段文字不是表。
 *
 * 判据用「后面一段里数字最多」：表格区的数字密度远高于散文。
 * 这比按章节标题层级找稳，因为四家的标题层级写法都不一样。
 */
export function findHolderSection(text: string, window = 12_000): { start: number; body: string } | null {
  const hits: number[] = [];
  for (const match of text.matchAll(ANCHOR)) hits.push(match.index ?? 0);
  if (!hits.length) return null;
  let best = hits[0];
  let bestScore = -1;
  for (const hit of hits) {
    const score = (text.slice(hit, hit + 3500).match(/\d/g) ?? []).length;
    if (score > bestScore) {
      bestScore = score;
      best = hit;
    }
  }
  return { start: best, body: text.slice(best, best + window) };
}

/**
 * 定位「股东名」那一列的缩进。
 *
 * 为什么必须按缩进筛行，不能只看「这行有数字有百分比」：
 * -layout 输出里，脚注、续行、页眉页脚都可能带数字和百分号。
 * 表格的第一列有固定缩进（跟 Name 表头对齐），非表格行几乎不会正好对上。
 * 实测四家的缩进各不相同（0354 是 5、0020 是 6、6682 和 0268 是 0），
 * 所以不能写死，必须从表头行读出来。
 */
export function nameColumnIndent(body: string): number | null {
  for (const line of body.split("\n")) {
    const match = /^(\s*)(Name of Shareholder|Name of shareholder|Name)(\s|$)/.exec(line);
    if (match) return match[1].length;
  }
  return null;
}

/**
 * 抽出所有主要股东行。
 *
 * 取「最后一个百分比」= 占已发行总股本，理由见文件头口径第 1 点。
 * 遇到淡仓 (S) 整行跳过，理由见文件头。
 */
export function extractHkHolderRows(text: string): HkHolderRow[] {
  const section = findHolderSection(text);
  if (!section) return [];
  const indent = nameColumnIndent(section.body);
  if (indent === null) return [];

  const lines = section.body.split("\n");
  const rows: HkHolderRow[] = [];
  const seen = new Set<string>();

  /** 上一个「有名字的行」的股数列结束位置和名字。
   *
   *  为什么需要它：同一股东按股份类别分多行披露时，第二行起名字列是空的
   *  （6682 的 Beijing New Wisdom 第二行只有「Interest in controlled  27,195,592 H  8.48%  5.23%」）。
   *  按名字列缩进筛行会把这些续行全丢掉——丢掉的正是 H 股那 5.23%，
   *  结果报告里这家股东看起来只持内资股，是一个沉默的错。 */
  let carry: { name: string; pctEnd: number } | null = null;

  lines.forEach((line, index) => {
    const sharesMatch = SHARES_IN_LINE.exec(line);
    if (!sharesMatch) return;
    const sharesEnd = (sharesMatch.index ?? 0) + sharesMatch[1].length;

    const percents = [...line.matchAll(PCT_WITH_SIDE)];
    if (!percents.length) return;
    const last = percents[percents.length - 1];
    // 淡仓不是持股。整行丢掉，不是「退一格取上一个百分比」——
    // 上一个很可能是同一笔淡仓的类别占比，一样不是持股。
    if (last[2] === "(S)") return;
    const pctEnd = (last.index ?? 0) + last[0].trimEnd().length;

    const lineIndent = line.length - line.trimStart().length;
    const cells = line.trim().split(/\s{2,}/).map(cell => cell.trim()).filter(Boolean);
    // ±1 容差：有些行首是全角空格，或被 -layout 挪了一格。
    const isNamed = Math.abs(lineIndent - indent) <= 1 && cells.length >= 3 && looksLikeName(stripNotes(cells[0]));

    let name: string;
    if (isNamed) {
      name = stripNotes(cells[0]);
      carry = { name, pctEnd };
    } else if (carry && Math.abs(pctEnd - carry.pctEnd) <= 3) {
      // 续行判据：**最后一个百分比的右边界**跟上一条命名行对齐。
      //
      // 为什么用百分比列而不是股数列：数值列是右对齐的，但股数那一格连着股份类别
      // 一起对齐（「37,034,191 Domestic」和「27,195,592 H」右边界相同，
      // 光看数字本身则差 7 列），而且 6682 里有一行把「23,689,267 H Shares (L)」
      // 整个左移了。最后一个百分比的右边界在同一张表里始终一致（实测 6682 全是第 137 列）。
      //
      // 光看「有数字有百分比」不够——脚注里也有（6682 脚注 (6) 就带 23,689,267 H Shares），
      // 但脚注是散文，不会正好落在表格的百分比列上。
      name = carry.name;
    } else {
      return;
    }

    const totalPct = last[1];
    const shareClass = shareClassOf(lines, index, sharesEnd);
    const key = `${name}|${totalPct}|${shareClass ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);

    rows.push({ name, totalPct, shareClass, quote: line.trim().replace(/\s{2,}/g, " ") });
  });

  return rows;
}

/** 表里那句「as at <日期>」= 这张横截面表的截止日。
 *
 *  为什么要单独取：年报的**披露日**（4 月发布）和表的**基准日**（12 月 31 日）
 *  差了四个月。报告里如果拿披露日当持股日期，读者会以为这是 4 月的持股情况。
 *  取不到就返回 null，由调用方退回披露日——但那时 value 里不会声称基准日。 */
export function asAtDate(text: string): string | null {
  const section = findHolderSection(text, 2500);
  if (!section) return null;
  // 两种写法都有：0354 是「as at 31 December 2025」，0020/6682 是「as at December 31, 2025」。
  const match = /as at\s+(?:(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})|([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4}))/i.exec(section.body);
  if (!match) return null;

  const day = match[1] ?? match[5];
  const monthName = (match[2] ?? match[4]).toLowerCase();
  const year = match[3] ?? match[6];
  const month = MONTHS[monthName];
  if (!month) return null;
  return `${year}-${month}-${day.padStart(2, "0")}`;
}

/** 口径说明。跟着每条事实一起进 value，因为脱离它这些数字会被读错。
 *
 *  为什么写在 value 里而不只写在注释里：注释只有改代码的人看得到，
 *  而这些数字会被渲染到分享给别人的报告里。报告的读者拿到 5.23% 时，
 *  必须同时看到「这是占总股本、按类别披露、只含好仓」。 */
export const HK_BASIS =
  "口径：SFO 第XV部第2、3分部须披露、并记录于按第336条存置的登记册的权益；" +
  "百分比为占已发行总股本（非占单一股份类别）；仅好仓(L)，不含淡仓(S)；" +
  "5% 门槛按股份类别计算，故可能出现占总股本低于 5% 的股东";

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
 * 把行转成两条事实：主要股东（majorHolders）和第一大股东（controller 的候选）。
 *
 * 为什么**不**填 institutional：那个字段的注释写着「13F / 港交所披露易 / 沪深股通」，
 * 问的是机构持仓合计。这张表里分不出哪些是机构——BlackRock 和 Fullgoal 是机构，
 * Easy Key Holdings 是创始人的持股平台，Hu Yuanman 是个人。
 * 按名字猜「像不像机构」就是在编。空着。
 *
 * 为什么**不**填 controller：实际控制人是一个法律认定，不是「持股最多的那个」。
 * 0268 的 Easy Key 持 19.23% 是最大股东，但年报里认定的实际控制人要看
 * 「控股股东」章节的表述。这张表答不了那个问题。所以只给 majorHolders，
 * 第一大股东的信息作为它的一部分呈现，不冒充 controller。
 */
export function extractHkHolderFacts(
  text: string,
  source: string,
  sourceUrl: string,
  fetchedAt: string,
): { majorHolders?: Sourced } {
  const rows = extractHkHolderRows(text);
  if (!rows.length) return {};

  const asAt = asAtDate(text);
  const rendered = rows
    .map(row => `${row.name} ${row.totalPct}%${row.shareClass ? `（${row.shareClass}）` : ""}`)
    .join("；");

  const prefix = asAt ? `截至 ${asAt}：` : "";
  const value = `${prefix}${rendered}。${HK_BASIS}`;

  return {
    majorHolders: toSourced(
      value,
      source,
      sourceUrl,
      fetchedAt,
      // 引语给前三行就够复核了，全量太长；但必须是逐字原文。
      rows.slice(0, 3).map(row => row.quote).join(" / "),
    ),
  };
}
