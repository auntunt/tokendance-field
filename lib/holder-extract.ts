// 股东数据抽取层：把东方财富 F10 的原始行变成带 quote 的事实。
//
// 定级为什么钉死 independent（对照 corpus-import.ts 的「定级的诚实原则」）：
// 这是东方财富整理过的二手结构化数据，不是巨潮/SEC 的法定披露原文。
// 数字大概率对，但中间过了一层别人的加工，我们没法逐条回到原始公告核对。
// 所以按「独立第三方」记，不按「法定披露」记。宁可低估。
// 注意 corpus-import.ts 的 SELF_HINTS 里含 "eastmoney."，靠 URL 推定会掉到 self；
// 这里显式传 grade，不走 URL 推定——URL 推定是给没有出处信息的语料兜底用的。
//
// 口径为什么必须写进 value（项目已经因为口径标错出过三次事故）：
// 1. 这个接口是「十大流通股东」，不是「十大股东」。两者能差很多：
//    大股东的限售股不在流通盘里，流通榜上的名字和比例都跟总榜不一样。
// 2. 接口同一行里有两个比例字段：HOLD_RATIO 是占总股本，
//    FREE_HOLDNUM_RATIO 是占流通股。实测软通动力 2026-07-07 期
//    十行 HOLD_RATIO 合计 20.5972%，FREE_HOLDNUM_RATIO 合计 27.1373%。
//    不写清用的哪个，读者会拿去跟年报的「持股比例」直接比，必然对不上。
// 3. 报告期日期必须带。股东名单每季度变，不带日期的名单等于没有名单。
//
// 刻意不抽的东西：
// - 增减持变动。接口的 HOLD_NUM_CHANGE / HOLDNUM_CHANGE_NAME / XZCHANGE 会互相矛盾：
//   实测 2026-07-07 期 rank 6 香港中央结算 HOLD_NUM_CHANGE=-878224 却标 HOLDNUM_CHANGE_NAME=增加、
//   XZCHANGE=771093；rank 10 反过来 HOLD_NUM_CHANGE=300743 标 减少、XZCHANGE=-1696688。
//   三个字段谁是准的无法从接口本身判定，抽出来就是编数据。所以整块不抽。
// - 实际控制人。这个接口没有控制关系字段，只有持股名单。
//   持股第一 ≠ 实际控制人（科大讯飞流通榜第一是中国移动通信有限公司，
//   而年报里的实际控制人是刘庆峰）。由持股比例反推控制人是无根据的推断，不做。
//   controller 字段仍然只由年报原文（statutory）来填。

import type { DimensionId, Sourced, SourceGrade } from "./fde-dimensions";
import type { HolderRow } from "./holder-sources";

export type HolderFact = {
  dimension: DimensionId;
  key: string;
  value: string;
  quote: string;
};

/** 选中的报告期 + 该期已按名次排好的行 */
export type HolderPeriod = {
  endDate: string;
  rows: HolderRow[];
};

function str(row: HolderRow, key: string): string {
  const raw = row[key];
  if (raw === null || raw === undefined) return "";
  return String(raw).trim();
}

function num(row: HolderRow, key: string): number | null {
  const raw = row[key];
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * END_DATE 接口给的是 "2026-07-07 00:00:00" 这种，只取日期部分。
 * 不用 new Date() 解析：那会引入时区，同一份缓存在不同机器上跑出不同日期，
 * 直接破坏「同输入同输出」的确定性要求。纯字符串切片是确定的。
 */
export function dateOf(row: HolderRow): string {
  const raw = str(row, "END_DATE");
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

/**
 * 按 END_DATE 分组取最新一期。
 * 这是本文件存在的头号理由：不分组的话 100 行里有 10 个 HOLDER_RANK=1，
 * 看起来像十个并列第一大股东，实际是十个季度混在一起。
 * 排序用字符串比较——END_DATE 已是 YYYY-MM-DD，字典序即时间序，且确定。
 */
export function latestPeriod(rows: HolderRow[]): HolderPeriod | null {
  const byDate = new Map<string, HolderRow[]>();
  for (const row of rows) {
    const date = dateOf(row);
    if (!date) continue;
    const bucket = byDate.get(date);
    if (bucket) bucket.push(row);
    else byDate.set(date, [row]);
  }
  if (byDate.size === 0) return null;
  const newest = [...byDate.keys()].sort().reverse()[0];
  const picked = [...(byDate.get(newest) ?? [])];
  // 名次排序：缺 HOLDER_RANK 的行排到最后，不让它们插队污染前十
  picked.sort((a, b) => {
    const ra = num(a, "HOLDER_RANK");
    const rb = num(b, "HOLDER_RANK");
    if (ra === null && rb === null) return 0;
    if (ra === null) return 1;
    if (rb === null) return -1;
    return ra - rb;
  });
  return { endDate: newest, rows: picked };
}

/** 报告里出现的固定口径前缀。只在这里定义一次，防止 value 和测试各写一份、日后漂开。 */
// 名单口径和比例口径是两件事，必须分别说清。
// 名单是「流通股东」榜（限售股不计入，所以榜上名字跟年报总榜不一样）；
// 比例用 HOLD_RATIO＝占总股本，不用 FREE_HOLDNUM_RATIO＝占流通股。
// 为什么选 HOLD_RATIO：它跟年报「持股比例」同口径，能直接跟 statutory 事实对照；
// FREE_HOLDNUM_RATIO 的分母是流通盘，跨公司、跨期都在变，单看一个数没有意义，
// 而且接口给的是 6.694057596018 这种十二位小数，写进报告只是噪音。
// 两个都留在 quote 里，谁想按流通盘口径复算都行。
export const FREE_FLOAT_CAVEAT =
  "口径：名单为十大流通股东（不是十大股东，限售股不计入流通盘）；比例为接口 HOLD_RATIO 字段＝占总股本比例，不是占流通股比例";

/**
 * 单行拼成可核对串。格式跟接口字段名一一对应，
 * 拿着这串能直接回到接口响应里 grep 到那一行。
 * 不做任何四舍五入或单位换算——加工过的数就没法核对了。
 */
function rowQuote(row: HolderRow): string {
  return [
    `HOLDER_RANK=${str(row, "HOLDER_RANK")}`,
    `HOLDER_NAME=${str(row, "HOLDER_NAME")}`,
    `FREE_HOLDNUM_RATIO=${str(row, "FREE_HOLDNUM_RATIO")}`,
    `HOLD_RATIO=${str(row, "HOLD_RATIO")}`,
    `HOLDER_TYPE=${str(row, "HOLDER_TYPE")}`,
    `END_DATE=${str(row, "END_DATE")}`,
  ].join(", ");
}

/**
 * 比例格式化：保留接口原值的有效位，不自己补零也不截断。
 * 早期版本用 toFixed(2) 把 5.018 变成 5.02，导致 value 里的数跟 quote 里的数不一致，
 * 复核的人会以为我们算错了。现在 value 直接用原值。
 */
function ratioText(row: HolderRow, key: string): string {
  const n = num(row, key);
  return n === null ? "未披露" : `${n}%`;
}

/**
 * 十大流通股东名单。这是 PDF 路线做不到、结构化接口能做到的那一块：
 * filing-extract.ts 的注释里记着「中国移动通信有限公司」在 pdftotext 下被拆成三行、
 * 跟别的列串在一起，所以年报路线整块放弃了持股名单。接口按行给，行列对应关系不会错。
 */
function majorHoldersFact(period: HolderPeriod, secucode: string): HolderFact | null {
  const rows = period.rows.filter(row => str(row, "HOLDER_NAME") !== "");
  if (rows.length === 0) return null;
  const listed = rows.slice(0, 10);
  const names = listed.map(row => {
    const rank = str(row, "HOLDER_RANK") || "-";
    return `${rank}. ${str(row, "HOLDER_NAME")} ${ratioText(row, "HOLD_RATIO")}`;
  });
  // 集中度并在这一格的尾部，不另开字段——同一份数据、同一个口径。
  // 曾经它单独占用 capTable（「股权结构变动」），那是口径错配，见下面的注释。
  const concentration = concentrationSuffix(period, secucode);
  const value = [
    `${period.endDate} 报告期十大流通股东：`,
    names.join("；"),
    `。${concentration ? `${concentration.text}` : ""}${FREE_FLOAT_CAVEAT}。`,
    `数据来源：东方财富 F10 RPT_F10_EH_FREEHOLDERS（${secucode}）`,
  ].join("");
  const quote = [
    `RPT_F10_EH_FREEHOLDERS SECUCODE=${secucode} 报告期 END_DATE=${period.endDate}：`,
    listed.map(rowQuote).join("｜"),
    concentration?.quote ?? "",
  ].join("");
  return { dimension: "shareholders", key: "majorHolders", value, quote };
}

/**
 * 机构持仓。fde-dimensions.ts 里 institutional 的 where 写的是
 * 「13F / 港交所披露易 / 沪深股通」——A 股拿不到 13F，但流通榜里的机构席位
 * 是同一类信息的可得替代：基金、私募、投资公司、以及代表沪深股通的香港中央结算。
 * 所以这里只统计机构类持有人，并且把「按 HOLDER_TYPE 判定」写进 value，
 * 让读者知道分类是接口给的、不是我们判断的。
 */
const INSTITUTION_TYPES = ["证券投资基金", "私募基金", "投资公司", "信托", "保险", "券商", "证券账户", "QFII", "社保"];

function isInstitution(row: HolderRow): boolean {
  const type = str(row, "HOLDER_TYPE");
  if (type === "") return false;
  if (type === "个人") return false;
  return INSTITUTION_TYPES.some(t => type.includes(t)) || type === "其它";
}

function institutionalFact(period: HolderPeriod, secucode: string): HolderFact | null {
  const rows = period.rows.filter(row => str(row, "HOLDER_NAME") !== "" && isInstitution(row));
  if (rows.length === 0) return null;
  // 合计只在每一行的比例都拿到时才给，缺一行就不给合计——
  // 少加一个持有人的合计数是错数，比不给更糟。
  const ratios = rows.map(row => num(row, "HOLD_RATIO"));
  const complete = ratios.every(r => r !== null);
  const sum = complete
    // 单位是百分比，浮点相加会留下 27.137300000000002 这种尾巴；
    // 定点到 4 位再还原，保证同输入同输出，且不虚增精度。
    ? `${Math.round(ratios.reduce((acc, r) => acc + (r ?? 0), 0) * 10000) / 10000}%`
    : "未披露（个别持有人比例缺失，不给合计）";
  const names = rows.map(row => `${str(row, "HOLDER_NAME")}（${str(row, "HOLDER_TYPE")}）${ratioText(row, "HOLD_RATIO")}`);
  const value = [
    `${period.endDate} 报告期十大流通股东中机构类持有人 ${rows.length} 席，合计持股占总股本 ${sum}：`,
    names.join("；"),
    `。${FREE_FLOAT_CAVEAT}；机构与个人的区分取接口 HOLDER_TYPE 字段，非本项目判定。`,
    `数据来源：东方财富 F10 RPT_F10_EH_FREEHOLDERS（${secucode}）`,
  ].join("");
  const quote = [
    `RPT_F10_EH_FREEHOLDERS SECUCODE=${secucode} 报告期 END_DATE=${period.endDate} 机构类持有人：`,
    rows.map(rowQuote).join("｜"),
  ].join("");
  return { dimension: "shareholders", key: "institutional", value, quote };
}

/**
 * 集中度：第一大流通股东占比 + 前十合计。这是一个**横截面**，不是变动。
 *
 * 这一条曾经被写进 capTable 字段，那是错的，而且是这个项目栽过三次的同一种错：
 * 值本身逐字正确，却装在问另一个问题的字段里。capTable 的标签是「股权结构变动」,
 * 装一个自己都注明「横截面，非变动」的值进去，读者会把它读成变动数据。
 * 引语校验拦不住这种错——引语是对的。只有针对口径的断言能拦。
 *
 * 更糟的是它还引发了第二个事故：年报路线给科大讯飞的 capTable 写了 statutory 的
 * 「控股股东报告期内未发生变更」——那才是真的在回答「变动」这个问题。
 * 这条 independent 的横截面把它顶掉了，statutory 从 54 掉到 50。
 *
 * 所以现在集中度不单开字段，而是并进 majorHolders 的尾部：
 * 同一份数据、同一个口径（十大流通股东横截面），本来就该在一格里。
 * 「变动」留给年报——只有年报会正面回答它。跨期比较靠 reports/history 快照 diff。
 */
function concentrationSuffix(period: HolderPeriod, secucode: string): { text: string; quote: string } | null {
  const rows = period.rows.filter(row => str(row, "HOLDER_NAME") !== "");
  if (rows.length === 0) return null;
  const top = rows[0];
  const topRatio = num(top, "HOLD_RATIO");
  if (topRatio === null) return null;
  const ratios: Array<number | null> = rows.slice(0, 10).map(row => num(row, "HOLD_RATIO"));
  if (ratios.some(r => r === null)) return null;
  const total = Math.round(ratios.reduce<number>((acc, r) => acc + (r ?? 0), 0) * 10000) / 10000;
  return {
    text: [
      `集中度（横截面，非变动）：第一大流通股东 ${str(top, "HOLDER_NAME")} 持 ${topRatio}%，`,
      `十大流通股东合计持股占总股本 ${total}%，共 ${rows.length} 名披露；`,
      `本条只反映该报告期的持股结构，不含增减持变动`,
      `（接口的 HOLD_NUM_CHANGE 与 HOLDNUM_CHANGE_NAME 存在互相矛盾的行，故不采用）。`,
    ].join(""),
    quote: [
      `｜RPT_F10_EH_FREEHOLDERS SECUCODE=${secucode} 报告期 END_DATE=${period.endDate} 合计口径：`,
      rows.slice(0, 10).map(rowQuote).join("｜"),
    ].join(""),
  };
}

/**
 * 抽取入口。抓不到就返回空数组——绝不用「暂无数据」之类的占位事实填坑，
 * 那会让覆盖率虚高，而覆盖率是这个项目唯一的进度指标。
 *
 * 注意这里**不产出 capTable**。见 concentrationSuffix 的注释：
 * capTable 问的是「股权结构变动」，接口给的是单期横截面，答不上那个问题。
 * 变动这一格留给年报（它有「控股股东报告期内变更」的正面回答），
 * 这条路线不去抢它。
 */
export function extractHolderFacts(rows: HolderRow[], secucode: string): HolderFact[] {
  const period = latestPeriod(rows);
  if (!period) return [];
  const facts = [
    majorHoldersFact(period, secucode),
    institutionalFact(period, secucode),
  ];
  // 铁律：没 quote 就不是事实。这里做最后一道拦截，
  // 免得日后有人加字段时忘了拼 quote 还能混进产物。
  return facts.filter((f): f is HolderFact => !!f && f.quote.trim() !== "" && f.value.trim() !== "");
}

/** 选中的报告期，供上层写进 filing 元信息（报告里要显示「取到了哪一期」） */
export function periodOf(rows: HolderRow[]): string | null {
  return latestPeriod(rows)?.endDate ?? null;
}

/**
 * 转 Sourced。grade 默认 independent 且没有 statutory 的调用路径——
 * 参数保留是为了跟 filing-extract.ts 的 toSourced 结构一致，
 * 但默认值必须是 independent：这是任务的硬约束，也是诚实定级的要求。
 */
export function toSourced(
  fact: HolderFact,
  source: string,
  sourceUrl: string,
  fetchedAt: string,
  grade: SourceGrade = "independent",
): Sourced {
  return { value: fact.value, grade, source, sourceUrl, fetchedAt, quote: fact.quote };
}
