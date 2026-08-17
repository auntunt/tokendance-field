// 把持股类字段的值排成表格。**纯展示层解析，不碰数据。**
//
// 为什么不让抽取器直接产出结构化的行：
// `Sourced.value` 是逐字保留的原文，变更页拿它逐字比对。改成对象就得改
// 抽取、合并、diff 三处，而且下一次重跑会因为形状变了而报出一整页假变更。
// 所以原文仍然是唯一的真值，这里只在渲染时把它读成行。
//
// 因此这个函数有一条硬规矩：**认不出来就整段退回原文**。
// 宁可显示成一段散文，也不能猜着摆进表格——摆错了的表格看起来比散文更可信。
//
// 还有一条：口径子句一个字都不许丢。
// 「十大流通股东占总股本比例」和「占流通股比例」是两个数，差一倍还不止。
// 表格把数字排整齐之后，这句话是唯一能说明这些数字到底在量什么的东西，
// 所以它从正文挪到表题里，位置变了，内容不动。

/** 表里的一行。pct 是原文里的数字，不重算、不四舍五入。 */
export type HolderRow = {
  name: string;
  /** 原样保留的百分数文本，如 "19.23"。 */
  pct: string;
  /** 括号里的补充：股份类别、股东类型、持股数。 */
  note?: string;
};

export type HolderTable = {
  /** 名单前面的引子，如「截至 2026-04-06」「2026-03-31 报告期十大流通股东」。 */
  preamble?: string;
  rows: HolderRow[];
  /** 名单后面的附注，如「股份类别：Class A Common Stock」「集中度……」。原文照搬。 */
  notes?: string;
  /** 口径与数据来源子句，原文照搬。 */
  basis?: string;
};

/** 口径 / 数据来源子句从哪里开始。这两个词是抽取器统一写的，不是碰运气。 */
const BASIS = /(口径：|数据来源：)/;

/** 名单项前面的序号。`1. 北京用友科技有限公司 26.9582%` 里的 `1. ` 不是名字的一部分，
 *  它表达的是排位，而排位由行的顺序原样保留了。要求点号后必须有空格，
 *  否则 `1.8507%` 这种以数字开头的值会被当成序号切掉。 */
const ORDINAL = /^\d{1,2}\.\s+/;

/** `名称（类别）12.34%` —— A 股接口那种把类型放中间的写法。 */
const NOTE_MID = /^(.+?)（([^（）]+)）\s*(\d+(?:\.\d+)?)%$/;
/** `名称 12.34%（补充）` —— SEC / 港股那种把补充放尾巴的写法。 */
const NOTE_TAIL = /^(.+?)\s+(\d+(?:\.\d+)?)%(?:\s*（([^（）]+)）)?$/;

/** 名字里出现这些说明这一段是散文，不是表格行——句读只会出现在句子里。 */
const PROSE = /[，。：；]/;

/**
 * 认得出来就返回表，认不出来返回 null（调用方原样渲染成散文）。
 * 少于两行也返回 null：一行的「表」只是把一句话套了个框。
 */
export function parseHolders(value: string): HolderTable | null {
  const text = String(value ?? "").trim();
  if (!text) return null;

  // 先摘口径。它固定在最后，切掉它能让后面的解析简单很多。
  let body = text;
  let basis: string | undefined;
  const hit = body.search(BASIS);
  if (hit >= 0) {
    basis = body.slice(hit).replace(/[。；]+$/, "").trim();
    body = body.slice(0, hit).trim();
  }

  // 名单只占其中一句。「。」之后往往还有附注（股份类别、集中度、接口取舍说明），
  // 那些句子每一句都有信息量，不能因为它们不是名单就把整段丢掉——
  // 早先那版正是这么丢的：11 家排出了表，另外 6 家 SEC 名单和 3 家十大流通股东
  // 因为后面跟了一句附注就整段退回散文。
  const sentences = body.split("。").map(part => part.trim()).filter(Boolean);
  if (!sentences.length) return null;

  // 名单句 = 分号最多的那一句。附注句里不会有一串分号。
  let pick = 0;
  let best = -1;
  sentences.forEach((sentence, index) => {
    const score = (sentence.match(/；/g) || []).length;
    if (score > best) { best = score; pick = index; }
  });
  let list = sentences[pick];
  const notes = sentences.filter((_, index) => index !== pick).join("。") || undefined;

  // 引子：名单之前那个以「：」结尾的说明。名单本身用「；」分隔，
  // 所以第一个「；」之前的冒号就是分界。
  let preamble: string | undefined;
  const colon = list.indexOf("：");
  if (colon >= 0) {
    const firstSemi = list.indexOf("；");
    if (firstSemi < 0 || colon < firstSemi) {
      preamble = list.slice(0, colon).trim();
      list = list.slice(colon + 1).trim();
    }
  }

  const segments = list.split("；").map(part => part.trim()).filter(Boolean);
  if (segments.length < 2) return null;

  const rows: HolderRow[] = [];
  for (const segment of segments) {
    const item = segment.replace(ORDINAL, "").trim();
    const mid = NOTE_MID.exec(item);
    const tail = mid ? null : NOTE_TAIL.exec(item);
    if (!mid && !tail) return null; // 有一段认不出来，整段退回散文
    const name = (mid ? mid[1] : tail![1]).trim();
    const pct = mid ? mid[3] : tail![2];
    const note = (mid ? mid[2] : tail![3])?.trim();
    // 名字过长或带句读，说明匹配到的是一句话的尾巴而不是一个股东名。
    if (!name || name.length > 64 || PROSE.test(name)) return null;
    rows.push(note ? { name, pct, note } : { name, pct });
  }
  return {
    ...(preamble ? { preamble } : {}),
    rows,
    ...(notes ? { notes } : {}),
    ...(basis ? { basis } : {}),
  };
}
