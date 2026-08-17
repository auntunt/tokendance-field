// 报告的判断层。
//
// 为什么要这一层：原来的报告是「概览 + 60 张公司卡 + 待办」，读者拿到 231×30
// 个格子，得自己归纳出结论——而归纳恰恰是报告该做的事。参考那份人写的研报
// 头部是五条判断，每条带证据等级、支撑、反例、推论，名单排在最后一章。
// 这个文件负责生成「能算出来的那几条判断」。
//
// 关键的自我约束：这里只出能回溯到具体行的判断。
//   能算的：集中度（某个取值占比多少）、交叉表里的空格（哪类公司某字段全空）、
//           缺口本身（某字段几乎查不到，说明它不在公开渠道里）、异常样本。
//   算不出的：「护城河在客户关系不在技术里」这种因果解释——它需要人读完卡片
//           再下结论。这类留 manual 位，由人写，不假装是自动产出的。
//
// 判断不过六道门，也不写 evidence_records。它只是把已有事实重新组织，
// 不新增任何主张——所以 `lib/field-core.ts` 不因这个文件改动一个字。

import { ALL_FIELDS, DIMENSIONS, type DimensionId, type SourceGrade } from "./fde-dimensions";
import { coverageOf, fact, LISTING_LABEL, RELEVANCE_META, type CompanyProfile, type Listing, type Relevance } from "./company-profile";

/**
 * 判断能拿出去讲到什么程度。这三档不是我随口分的，是从支撑它的事实的来源级别
 * 推出来的——一条判断的硬度不可能超过它最软的那条支撑。
 */
export const CONFIDENCE = ["public", "internal", "lead"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const CONFIDENCE_META: Record<Confidence, { label: string; hint: string }> = {
  public: { label: "可对外", hint: "支撑全部来自法定披露或三方，数字能直接引用" },
  internal: { label: "内部参考", hint: "方向对，但支撑里有自述来源，数字别往外引" },
  lead: { label: "仅线索", hint: "支撑不足或样本太小，需要人工核实才能定" },
};

/**
 * 这条判断在讲什么。
 *
 * 这个区分是必须的，不是分类癖。原来 11 条判断平铺在一个列表里，其中 5 条讲的
 * 是「我们抓到哪一步」（覆盖率、盲区、离群值、还有多少未判定），而且插在中间——
 * 读者从上往下读，第 5 条就撞上「67% 还没判定」，整份报告的观感立刻从
 * 「这批公司什么样」变成「这个系统做完了多少」。
 *
 * 两类都要留：覆盖率边界是读结论的前提，删掉就变成了只报好消息。
 * 但它们不能混在一起平铺——companies 那几条是报告的正文，corpus 那几条是脚注。
 */
export type JudgmentScope = "companies" | "corpus";

/** 一条判断。structure 决定它渲染成什么样，但每条都必须有支撑和反例检查。 */
export type Judgment = {
  /** 判断本身。一句话，必须能被数据反驳——不能是「值得关注」这种没有反面的话。 */
  claim: string;
  confidence: Confidence;
  /** 讲公司还是讲我们自己的数据。不给默认算讲公司——人工判断都是讲公司的。 */
  scope?: JudgmentScope;
  /** 支撑：具体数字 + 它是怎么算出来的。读者应该能照着复算。 */
  support: string;
  /**
   * 反例检查。有反例就写出来，没有就写「无」——
   * 不写这一栏的判断等于只报了对自己有利的那一半数据。
   */
  counter: string;
  /** 推论：这条判断改变什么决定。没有推论的判断是废话。 */
  implication?: string;
  /** 这条是算出来的还是人写的。人写的要标出来，不能混在自动结论里冒充确定性产物。 */
  origin: "computed" | "manual";
};

/** 人工判断的输入。跑报告时从 JSON 传进来，没有就只出可计算的那几条。 */
export type ManualJudgment = {
  claim: string;
  confidence: Confidence;
  support: string;
  counter: string;
  implication?: string;
};

/** 一条判断的支撑里最软的来源级别，决定它的证据等级。 */
function confidenceFromGrades(grades: SourceGrade[]): Confidence {
  if (!grades.length) return "lead";
  if (grades.some(g => g === "unverified")) return "lead";
  if (grades.some(g => g === "self")) return "internal";
  return "public";
}

/** 按取值分组计数，顺带记下每个取值背后的来源级别。 */
type Bucket = { value: string; count: number; grades: SourceGrade[] };

function bucketBy(
  profiles: CompanyProfile[],
  pick: (p: CompanyProfile) => { value: string; grade: SourceGrade } | null,
): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const profile of profiles) {
    const hit = pick(profile);
    if (!hit || !hit.value.trim()) continue;
    const existing = map.get(hit.value) ?? { value: hit.value, count: 0, grades: [] };
    existing.count += 1;
    existing.grades.push(hit.grade);
    map.set(hit.value, existing);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "zh"));
}

function pct(part: number, whole: number): string {
  return whole ? `${((part / whole) * 100).toFixed(0)}%` : "0%";
}

/** 一条判断至少要有多少家公司垫底才配叫判断。
 *  低于这个数的分组占比毫无意义——3 家里 2 家占 67%，那是巧合不是结构。 */
const MIN_SAMPLE = 8;

/**
 * 规则一：某个维度的资料几乎全查不到 —— 缺口本身就是结论。
 *
 * 这是这份数据里最诚实的一类判断。「交付人数与客户数之比」全表 0 条，
 * 说明的不是我们没抓，而是这个数字不在任何公开渠道里；而它恰好是判断
 * FDE 模式最关键的比值。这种「想要的正好拿不到」比覆盖率数字有用得多。
 */
function judgeBlindSpots(profiles: CompanyProfile[]): Judgment[] {
  if (profiles.length < MIN_SAMPLE) return [];
  const empty: string[] = [];
  const thin: Array<{ label: string; filled: number }> = [];
  for (const spec of ALL_FIELDS) {
    let filled = 0;
    for (const profile of profiles) if (fact(profile, spec.dimension, spec.key)) filled += 1;
    if (filled === 0) empty.push(spec.label);
    else if (filled / profiles.length < 0.05) thin.push({ label: spec.label, filled });
  }
  if (!empty.length && !thin.length) return [];

  const out: Judgment[] = [];
  if (empty.length) {
    out.push({
      claim: `有 ${empty.length} 个字段在全部 ${profiles.length} 家里一条都没查到——这些是公开渠道的盲区，不是抓取的疏漏`,
      confidence: "public",
      support: `全表零命中的字段：${empty.join("、")}。分母是在册 ${profiles.length} 家，`
        + `每家都跑过同一套抓取，所以这不是采样问题。`,
      counter: thin.length
        ? `不算全空但接近的还有：${thin.map(t => `${t.label}（${t.filled} 家）`).join("、")}——这几个说明渠道存在但极稀疏。`
        : "无。其余字段都有至少 5% 的命中率。",
      implication: "这些字段要么改走访谈/内部渠道，要么就该从报告的字段表里删掉——留着只会让覆盖率永远难看。",
      scope: "corpus",
      origin: "computed",
    });
  }
  return out;
}

/**
 * 规则二：某个字段的取值高度集中 —— 集中度是结构，不是偶然。
 *
 * 只对「有值的那些家」算占比，不拿全表当分母：混着空值算出来的百分比
 * 既不是集中度也不是覆盖率，两头不靠。
 */
function judgeConcentration(profiles: CompanyProfile[]): Judgment[] {
  const out: Judgment[] = [];
  const watch: Array<{ dim: DimensionId; key: string; label: string; noun: string }> = [
    { dim: "business", key: "pricing", label: "收费模式", noun: "计费" },
    { dim: "business", key: "verticals", label: "行业垂直领域", noun: "赛道" },
    { dim: "business", key: "geography", label: "地域分布", noun: "地域" },
  ];
  for (const item of watch) {
    const buckets = bucketBy(profiles, p => {
      const entry = fact(p, item.dim, item.key);
      return entry ? { value: String(entry.value).trim(), grade: entry.grade } : null;
    });
    const withValue = buckets.reduce((sum, b) => sum + b.count, 0);
    // 只有样本量是硬门槛。不排除「只有一个取值」的情况：那是集中度最极端的形态，
    // 下面 counter 那一栏本来就写了这种情况该怎么说（信息量有限）。
    if (withValue < MIN_SAMPLE) continue;
    const top = buckets[0];
    if (top.count / withValue < 0.5) continue; // 不到一半不叫集中
    const rest = buckets.slice(1, 4).map(b => `${b.value} ${b.count}`).join("、");
    out.push({
      claim: `${item.noun}高度集中在「${top.value}」：有值的 ${withValue} 家里占 ${pct(top.count, withValue)}`,
      confidence: confidenceFromGrades(top.grades),
      support: `${top.value} ${top.count} 家 / 共 ${withValue} 家填了「${item.label}」这一格。`
        + `分母只算有值的，没把空着的 ${profiles.length - withValue} 家算进去。`,
      counter: rest ? `其余分布：${rest}。` : "无其他取值——只有一种，这条判断的信息量因此有限。",
      implication: `按「${item.label}」区分这批公司几乎无效，得换别的切面才能分开它们。`,
      origin: "computed",
    });
  }
  return out;
}

/**
 * 规则三：分组之间的覆盖差 —— 「查得到」本身是这批公司的一个属性。
 *
 * 上市与未上市的资料完整度差多少，是这份数据自己产生的最硬的一条结论：
 * 它不依赖任何对公司的解读，只依赖法定披露制度的存在。
 */
function judgeVisibilityGap(profiles: CompanyProfile[]): Judgment[] {
  if (profiles.length < MIN_SAMPLE) return [];
  const listed = profiles.filter(p => p.listing !== "private");
  const priv = profiles.filter(p => p.listing === "private");
  if (listed.length < 3 || priv.length < 3) return [];

  const avg = (group: CompanyProfile[]) => {
    const total = group.reduce((sum, p) => sum + coverageOf(p).filled, 0);
    return group.length ? total / group.length : 0;
  };
  const hardOf = (group: CompanyProfile[]) => group.reduce((sum, p) => {
    const c = coverageOf(p);
    return sum + c.byGrade.statutory + c.byGrade.independent;
  }, 0);

  const listedAvg = avg(listed);
  const privAvg = avg(priv);
  if (privAvg > 0 && listedAvg / privAvg < 1.5) return [];
  const ratio = privAvg > 0 ? (listedAvg / privAvg).toFixed(1) : "∞";

  return [{
    claim: `上市公司平均查到 ${listedAvg.toFixed(1)} 项，未上市 ${privAvg.toFixed(1)} 项——差 ${ratio} 倍，`
      + `而差距全部来自法定披露`,
    confidence: "public",
    support: `${listed.length} 家上市（${LISTING_LABEL["us"]}/${LISTING_LABEL["cn-a"]}/${LISTING_LABEL.hk}/${LISTING_LABEL.otc}）`
      + `共 ${hardOf(listed)} 项法定或三方来源；${priv.length} 家未上市共 ${hardOf(priv)} 项。`
      + `两组跑的是同一套抓取、同一套字段。`,
    counter: privAvg === 0
      ? "无。未上市那组平均为零，连反例都没有。"
      : `未上市里也有查得到的：说明未上市不等于查不到，只是拿不到硬来源。`,
    implication: "想让未上市公司这一半有内容，只能靠招聘页、备案号、中标公告这类侧面证据——"
      + "它们的级别天花板是自述，不可能补成法定披露。",
    scope: "corpus",
    origin: "computed",
  }];
}

/**
 * 规则四：相关度判定本身的进度 —— 名单还没被判断过，这件事必须说在前面。
 *
 * 这条是给读者的免责，也是给我们自己的待办：如果绝大多数还是「待判定」，
 * 那么这份报告目前是一份「候选池」，而不是一份「同行名单」。
 */
function judgeRelevanceProgress(profiles: CompanyProfile[]): Judgment[] {
  if (profiles.length < MIN_SAMPLE) return [];
  const tally = new Map<Relevance, number>();
  for (const p of profiles) tally.set(p.relevance, (tally.get(p.relevance) ?? 0) + 1);
  const unclear = tally.get("unclear") ?? 0;
  if (unclear / profiles.length < 0.5) return [];
  const judged = profiles.length - unclear;
  const breakdown = [...tally.entries()]
    .filter(([k]) => k !== "unclear")
    .map(([k, v]) => `${RELEVANCE_META[k].label} ${v}`)
    .join("、");

  return [{
    claim: `${profiles.length} 家里有 ${unclear} 家（${pct(unclear, profiles.length)}）还没判定和 FDE 模式的关系——`
      + `所以这目前是候选池，不是同行名单`,
    confidence: "public",
    support: `已判定 ${judged} 家${breakdown ? `：${breakdown}` : ""}。`
      + `判定需要 JD 原文或年报里的组织描述作依据，不能从行业标签推。`,
    counter: judged > 0
      ? `已判定的那 ${judged} 家是可用的——它们有明确依据，不受这条影响。`
      : "无。一家都还没判定。",
    implication: "引用这份名单时要说清是候选池。把「候选」当「同行」用，是这套数据最容易出的错。",
    scope: "corpus",
    origin: "computed",
  }];
}

/**
 * 规则五：异常样本 —— 资料齐全度远超同组的那几家，通常是抓取口径出了问题。
 *
 * 报出来不是为了夸它们，是为了让人去核：一家未上市公司如果字段比上市公司还全，
 * 大概率是语料里混进了通稿或者同名公司。
 */
function judgeOutliers(profiles: CompanyProfile[]): Judgment[] {
  if (profiles.length < MIN_SAMPLE) return [];
  const scored = profiles.map(p => ({ p, filled: coverageOf(p).filled }));
  const total = scored.reduce((s, x) => s + x.filled, 0);
  const mean = total / scored.length;
  if (mean <= 0) return [];
  const top = scored.filter(x => x.filled >= mean * 3 && x.filled >= 6)
    .sort((a, b) => b.filled - a.filled).slice(0, 5);
  if (!top.length) return [];

  const names = top.map(x => `${x.p.name}（${x.filled} 项）`).join("、");
  const grades: SourceGrade[] = [];
  for (const x of top) {
    for (const spec of ALL_FIELDS) {
      const entry = fact(x.p, spec.dimension, spec.key);
      if (entry) grades.push(entry.grade);
    }
  }
  return [{
    claim: `有 ${top.length} 家的资料齐全度是全表均值（${mean.toFixed(1)} 项）的 3 倍以上——先核这几家，再用整表的数`,
    confidence: confidenceFromGrades(grades),
    support: `${names}。均值 ${mean.toFixed(1)} 项来自在册 ${profiles.length} 家。`,
    counter: `齐全不等于错——上市公司本来就该更全。要核的是里面的未上市公司。`,
    implication: "整表的平均覆盖率会被这几家拉高。看趋势时应该同时看中位数。",
    scope: "corpus",
    origin: "computed",
  }];
}

// ============ 交叉表：情报在两个字段之间，不在单个字段里 ============
//
// 上面五条规则有一个共同的毛病，是我做完第一版才看出来的：它们全都在说
// 「这份数据自己」——覆盖率多少、哪几格是空的、谁是离群值。那是数据质量报告。
// 读者要的是这些公司在做什么、怎么收钱、彼此差在哪。
//
// 差别不在措辞上，在算法上：单字段统计最多得出「126 家项目制」这种全表口径，
// 而它对任何决定都没用——真正有用的是「零售消费 13 家里项目制只占 15%，
// 政务治理 22 家里占 91%」。同一个字段，交叉之后才出结论。
//
// 所以下面这几条一律是二维的：某个分类字段 × 另一个分类字段，
// 找组间差异最大的那一格。用 label 而不是 value 做键（见 Sourced.label）。

type Axis = { dim: DimensionId; key: string; label: string };

const AXIS: Record<string, Axis> = {
  sector: { dim: "business", key: "verticals", label: "赛道" },
  billing: { dim: "business", key: "pricing", label: "计费方式" },
  stage: { dim: "funding", key: "rounds", label: "融资阶段" },
  founder: { dim: "team", key: "priorAffil", label: "创始人背景" },
  region: { dim: "business", key: "geography", label: "地域" },
};

function labelOf(profile: CompanyProfile, axis: Axis): string | null {
  const entry = fact(profile, axis.dim, axis.key);
  const text = entry?.label?.trim();
  return text ? text : null;
}

/** 一行交叉表：某个 row 取值下，各 col 取值的分布。 */
type CrossRow = {
  row: string;
  total: number;
  cells: Map<string, number>;
  grades: SourceGrade[];
};

function crossTab(profiles: CompanyProfile[], rowAxis: Axis, colAxis: Axis): CrossRow[] {
  const rows = new Map<string, CrossRow>();
  for (const profile of profiles) {
    const r = labelOf(profile, rowAxis);
    const c = labelOf(profile, colAxis);
    if (!r || !c) continue; // 两边都得有标签，否则这家不进交叉表
    const entry: CrossRow = rows.get(r)
      ?? { row: r, total: 0, cells: new Map<string, number>(), grades: [] };
    entry.total += 1;
    entry.cells.set(c, (entry.cells.get(c) ?? 0) + 1);
    const colFact = fact(profile, colAxis.dim, colAxis.key);
    if (colFact) entry.grades.push(colFact.grade);
    rows.set(r, entry);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total || a.row.localeCompare(b.row, "zh"));
}

/** 一条交叉表判断里，每组要有多少家才算得上一组。比 MIN_SAMPLE 松一点：
 *  交叉之后每组必然变小，卡在 8 家就只剩两三个赛道能参与比较。 */
const MIN_GROUP = 5;

/** 「算不算项目制」的唯一口径。
 *
 *  必须只有一处。这个正则在判断里、在交叉表里、在两张表的高亮列里各要用一次，
 *  写三遍就会漂：我第一版在判断里用了 /项目制|私有化|定制/，它连带命中
 *  「平台+定制」，于是判断写 75%、正下方的表格是 63%——同一份数据两个数字，
 *  读者不会去找哪个对，只会不信整份报告。
 *
 *  「平台+定制」不算项目制：它有产品底座，定制发生在底座之上，
 *  现金流结构和纯项目制不是一回事。 */
const PROJECT_BILLING = /^项目制|私有化/;

/**
 * 规则六：同一个字段在不同分组里的分布差异 —— 这是交叉表最直接的用法。
 *
 * 找的是「最高组 vs 最低组」的极差。举例：项目制在物业设施占 100%、
 * 在零售消费占 15%，差 6 倍——这说明计费方式不是商务谈出来的，是场景定的。
 * 单看全表「126 家项目制占 61%」永远看不到这一点。
 */
type SpreadCopy = {
  /** 被统计的那类取值叫什么，用在支撑句里。 */
  noun: string;
  /** claim 的前半句，由调用方给——不同的交叉表结论不一样，套同一个模板会写出
   *  「想换查不到融资，换的是赛道」这种病句。 */
  headline: (high: string, low: string) => string;
  implication: string;
};

function judgeCrossSpread(
  profiles: CompanyProfile[], rowAxis: Axis, colAxis: Axis, target: RegExp, copy: SpreadCopy,
): Judgment[] {
  const rows = crossTab(profiles, rowAxis, colAxis).filter(r => r.total >= MIN_GROUP);
  if (rows.length < 3) return [];

  const shareOf = (r: CrossRow) => {
    let hit = 0;
    for (const [col, n] of r.cells) if (target.test(col)) hit += n;
    return { hit, share: hit / r.total };
  };
  const scored = rows.map(r => ({ r, ...shareOf(r) })).sort((a, b) => b.share - a.share);
  const high = scored[0];
  const low = scored[scored.length - 1];
  // 极差不到 40 个百分点就不算结构性差异，只是分布不均。
  if (high.share - low.share < 0.4) return [];

  const ladder = scored.map(s => `${s.r.row} ${pct(s.hit, s.r.total)}（${s.hit}/${s.r.total}）`).join("、");
  const zeros = scored.filter(s => s.hit === 0).map(s => s.r.row);
  const confidence = confidenceFromGrades([...high.r.grades, ...low.r.grades]);
  return [{
    claim: copy.headline(
      `${high.r.row} ${pct(high.hit, high.r.total)}`,
      `${low.r.row} ${pct(low.hit, low.r.total)}`,
    ),
    confidence,
    support: `按${rowAxis.label}拆开看${copy.noun}的占比：${ladder}。`
      + `每组分母只算${rowAxis.label}和${colAxis.label}都有取值的公司，`
      + `所以各组能横向比。只保留 ${MIN_GROUP} 家以上的组。`
      + gradeNote(confidence, colAxis.label),
    counter: zeros.length
      ? `${zeros.join("、")}这几组一家都没有——极值组的样本本来就小，别把 0% 读成「不可能」，读成「这批数据里没见到」。`
      : `每组都有，差别只是比例——所以这是程度差异，不是有无差异。`,
    implication: copy.implication,
    origin: "computed",
  }];
}

/** 把「为什么只能到这个等级」写进支撑里。
 *  只标一个「仅线索」而不说原因，读者只会以为是我保守；说清是来源级别的问题，
 *  他才知道该去补什么才能把这条升成可对外。 */
function gradeNote(confidence: Confidence, fieldLabel: string): string {
  if (confidence === "public") return "";
  if (confidence === "internal") {
    return `（等级：${fieldLabel}这一格有一部分是公司自述，比例方向可信，具体数字别外引。）`;
  }
  return `（等级：${fieldLabel}这一格有相当比例来自语料摘要、没有独立出处，`
    + `所以只标仅线索——差异的方向可以用，百分比要核过才能引。）`;
}

/**
 * 规则八：把剩下的交叉轴全扫一遍 —— 手挑三对，就只能出三条结论。
 *
 * 上面 judgeCrossSpread 的三处调用是手写的：赛道×计费、创始人×计费、赛道×融资。
 * 但覆盖率 90% 以上的轴有 5 个（赛道、计费、融资阶段、地域、创始人背景），
 * 两两组合有 10 对——手挑意味着剩下 7 对里的结论永远不会被发现，
 * 而它们和被挑中的那三对用的是同一份数据、同样的算法。
 *
 * 所以这里不挑，全扫，让数据自己决定哪一对值得说：每对交叉表算出
 * 「最高组 - 最低组」的极差，只有超过阈值的才成为判断。没有结论的组合
 * 自己就消失了，不需要我预先知道哪对有料。
 *
 * 措辞是模板化的，比手写的那三条钝——这是有意的取舍：宁可多出几条钝但真的结论，
 * 也不要因为没人手写文案而把结论丢掉。手写那三条保留在前面，扫出来的排在后面。
 *
 * 去重靠 seen：手写的三对已经出过判断，同一对不能再出一遍。
 */
function judgeAllCrossSpreads(profiles: CompanyProfile[], seen: Set<string>): Judgment[] {
  const axes = ["sector", "billing", "stage", "founder", "region"];
  const out: Array<Judgment & { spread: number }> = [];

  for (const rowKey of axes) {
    for (const colKey of axes) {
      if (rowKey === colKey) continue;
      if (seen.has(`${rowKey}×${colKey}`)) continue;
      const rowAxis = AXIS[rowKey];
      const colAxis = AXIS[colKey];
      // 门槛用 SWEEP_MIN_GROUP 而不是 MIN_GROUP：支撑句里写的是「只保留 N 家以上的组」，
      // 如果这里按 5 家建表、句子里写 8，那张阶梯会列出 5 家的组——
      // 数字和说明不一致，读者就有理由不信整条判断。
      // 基线也跟着只在这些组上算，和阶梯同一个分母。
      const rows = crossTab(profiles, rowAxis, colAxis).filter(r => r.total >= SWEEP_MIN_GROUP);
      if (rows.length < 3) continue;

      // 列轴的每个取值都试一次当「被统计的那一类」，取极差最大的那个。
      // 不预设看哪一类：预设就等于又在手挑了。
      const cols = new Set<string>();
      for (const r of rows) for (const c of r.cells.keys()) cols.add(c);

      // 基线：这个取值在「所有两轴都有值的公司」里本来占多少。
      // 没有基线的极差是假发现：院所/央国企在有创始人数据的 84 家里本来就占 68%，
      // 所以「平台+定制 7 家全是院所」只比基线高 32 个百分点，几乎是必然的；
      // 而第一版把它当成头条结论报了三遍（换个行轴就再报一次）。
      const grandTotal = rows.reduce((s, r) => s + r.total, 0);
      const baseline = new Map<string, number>();
      for (const col of cols) {
        let n = 0;
        for (const r of rows) n += r.cells.get(col) ?? 0;
        baseline.set(col, n / grandTotal);
      }

      let best: { col: string; spread: number; lift: number; base: number; scored: Array<{ r: CrossRow; hit: number; share: number }> } | null = null;
      for (const col of cols) {
        const scored = rows.map(r => {
          const hit = r.cells.get(col) ?? 0;
          return { r, hit, share: hit / r.total };
        }).sort((a, b) => b.share - a.share);
        // 全表占比过小的取值不看：3 家分散在 5 个组里，极差必然是 100%-0%，
        // 那是样本噪声不是结构。
        const totalHit = scored.reduce((s, x) => s + x.hit, 0);
        if (totalHit < MIN_SAMPLE) continue;
        // 极值两端的组都必须够大。5/5 = 100% 读起来像铁律，
        // 其实换一家公司的归类就变成 80%——那不是结构，是四舍五入。
        const high = scored[0];
        const low = scored[scored.length - 1];
        if (high.r.total < SWEEP_MIN_GROUP || low.r.total < SWEEP_MIN_GROUP) continue;
        const spread = high.share - low.share;
        const base = baseline.get(col) ?? 0;
        // lift：最高组比基线高出多少。这才是「发现」的大小。
        const lift = high.share - base;
        if (lift < SWEEP_MIN_LIFT) continue;
        // 排序按 spread，但门槛卡 lift——两个都要过。
        if (!best || spread > best.spread) best = { col, spread, lift, base, scored };
      }
      if (!best || best.spread < SWEEP_MIN_SPREAD) continue;

      const { col, scored, spread, base } = best;
      const high = scored[0];
      const low = scored[scored.length - 1];
      const ladder = scored.map(s => `${s.r.row} ${pct(s.hit, s.r.total)}（${s.hit}/${s.r.total}）`).join("、");
      const zeros = scored.filter(s => s.hit === 0).map(s => s.r.row);
      const confidence = confidenceFromGrades([...high.r.grades, ...low.r.grades]);
      const ratio = low.share > 0 ? (high.share / low.share) : null;

      out.push({
        spread,
        claim: `${high.r.row}的公司里「${col}」占 ${pct(high.hit, high.r.total)}，`
          + `${low.r.row}只有 ${pct(low.hit, low.r.total)}`
          + (ratio && ratio >= 2 ? `——差 ${ratio.toFixed(1)} 倍` : "——差 " + Math.round(spread * 100) + " 个百分点"),
        confidence,
        support: `按${rowAxis.label}拆开看「${col}」在${colAxis.label}里的占比：${ladder}。`
          + `每组分母只算${rowAxis.label}和${colAxis.label}都有取值的公司，`
          + `所以各组能横向比。只保留 ${SWEEP_MIN_GROUP} 家以上的组。`
          // 基线必须写进支撑。不写的话，「某组占 100%」读起来像铁律，
          // 读者无法判断它究竟是发现还是这个取值本来就到处都是。
          + `另外「${col}」在这批公司里的基线占比是 ${pct(Math.round(base * grandTotal), grandTotal)}，`
          + `所以最高那组比基线高出 ${Math.round((high.share - base) * 100)} 个百分点——`
          + `这个差值才是这条判断的实际发现，不是那个 ${pct(high.hit, high.r.total)}。`
          + gradeNote(confidence, colAxis.label),
        counter: zeros.length
          ? `${zeros.join("、")}这几组一家都没有——别把 0% 读成「不可能」，读成「这批数据里没见到」。`
          : `每组都有，差别只是比例——这是程度差异，不是有无差异。`,
        implication: `${rowAxis.label}和${colAxis.label}不是独立的两个标签：`
          + `知道一家公司的${rowAxis.label}，就已经能猜出它的${colAxis.label}大概是什么。`
          + `反过来，按${colAxis.label}筛同行会系统性偏向某几个${rowAxis.label}。`,
        scope: "companies",
        origin: "computed",
      });
      // 两个方向都标掉。交叉表转置之后是同一张表：赛道×计费 和 计费×赛道
      // 讲的是同一件事，出两条判断就是把一个发现说两遍。
      seen.add(`${rowKey}×${colKey}`);
      seen.add(`${colKey}×${rowKey}`);
    }
  }

  // 极差大的排前面：差 6 倍的结论比差 41 个百分点的更值得占版面。
  return out.sort((a, b) => b.spread - a.spread).map(({ spread: _spread, ...j }) => j);
}

/** 扫出来的交叉判断至少要有多大极差才配上榜。
 *  比手写那三条的 40% 严一档：模板化措辞本来就钝，
 *  差异不够大的话读者读完只会觉得「所以呢」。 */
const SWEEP_MIN_SPREAD = 0.45;

/** 极值两端的组各自至少要有多少家。
 *
 *  比 MIN_GROUP（5）严：5/5 = 100% 读起来像铁律，其实换一家公司的归类
 *  就变成 80%。第一版就是卡在 5 上，于是「挂牌/准上市 5 家全是院所背景」
 *  和「平台+定制 7 家全是院所」两条都上了榜——两条都是小样本的四舍五入。 */
const SWEEP_MIN_GROUP = 8;

/** 最高组比基线高出多少才算发现。
 *
 *  这个门槛是这次修正的关键。院所/央国企在有创始人数据的 84 家里本来就占 68%，
 *  所以「某组 100% 是院所」只比基线高 32 个百分点——它接近必然，不是情报。
 *  没有这道门槛时，同一个基线偏高的取值会在不同行轴下反复上榜：
 *  第一版 11 条里有 3 条都在说「院所占 100%」，换个行轴就再说一遍。 */
const SWEEP_MIN_LIFT = 0.35;

/**
 * 规则七：某种模式全部卡在同一个位置 —— 「看起来最好的模式还没被验证能长大」。
 *
 * 这是交叉表里最容易被漏掉的一类：不看某组占比多少，看它的另一个字段
 * 是否全部落在同一档。按效果付费听起来是最优模式，但如果这 11 家
 * 全停在 A 轮及更早，那它是个未验证的假设，不是可复制的路径。
 */
function judgeStalledPattern(profiles: CompanyProfile[]): Judgment[] {
  const EARLY = /无公开融资|种子|天使|Pre-A|^A 轮$/;
  const LATE = /B 轮|C 轮|挂牌|准上市|战略|产业投资/;
  const rows = crossTab(profiles, AXIS.billing, AXIS.stage).filter(r => r.total >= MIN_GROUP);
  if (rows.length < 2) return [];

  // 只出一条。第一版对每个卡住的计费类都出一张卡，结果「软硬一体 18 家全停在
  // A 轮」和「按效果付费 11 家全停在 A 轮」两张卡除了名字和数字之外逐字相同——
  // 那正是我要去掉的信息堆砌。同一个现象说一次，其余的并进同一条的支撑里。
  const stalled: Array<{ row: string; total: number; early: number }> = [];
  for (const r of rows) {
    let late = 0, early = 0;
    for (const [stage, n] of r.cells) {
      if (LATE.test(stage)) late += n;
      else if (EARLY.test(stage)) early += n;
    }
    if (late > 0 || early < MIN_GROUP) continue; // 有一家走到后期就不叫卡住
    stalled.push({ row: r.row, total: r.total, early });
  }
  if (!stalled.length) return [];
  stalled.sort((a, b) => b.total - a.total);

  // 对照组：全表哪些计费类走到了后期。没有对照，「全停在早期」可能只是这批公司都年轻。
  const lateRows = rows.filter(r => [...r.cells].some(([s]) => LATE.test(s)));
  const lateDetail = lateRows.map(r => {
    let late = 0;
    for (const [s, n] of r.cells) if (LATE.test(s)) late += n;
    return `${r.row} ${late}/${r.total}`;
  }).join("、");

  const names = stalled.map(s => `「${s.row}」${s.total} 家`).join("、");
  return [{
    claim: stalled.length > 1
      ? `${stalled.length} 种计费模式全员卡在 A 轮及更早（${names}）——最像「好模式」的那几种，一家都没证明能长大`
      : `「${stalled[0].row}」这 ${stalled[0].total} 家全部停在 A 轮及更早——这个模式还没有一家证明它能长大`,
    confidence: "lead",
    support: stalled.map(s =>
      `${s.row}：${s.total} 家，无融资/种子/天使/Pre-A/A 轮 ${s.early} 家，B 轮及以后 0 家`).join("；")
      + "。"
      + (lateDetail
        ? `对照——同一份名单里走到后期的分布在：${lateDetail}。所以「走到后期」这件事本身是发生过的，只是没发生在上面这几类里。`
        : `不过全名单走到后期的也是 0 家，所以这条的对照组是空的，差异说明不了什么。`),
    counter: `每类样本都只有十几家，而且「没走到 B 轮」也可能只是因为这批公司普遍成立时间短，`
      + `不能直接读成「模式走不通」。这就是它只标仅线索的原因。`,
    implication: `把它当待验证的假设，不是结论。要证实或推翻，看这几类里的头部`
      + `在未来 12 个月的融资和续约情况。`,
    origin: "computed",
  }];
}

/**
 * 规则八：出身决定路径 —— 创始人背景 × 计费方式。
 *
 * 参考那份研报里最锋利的一条就是这个交叉：大厂系敢按效果收钱，
 * 院所/央国企系几乎只能做项目制。它说明的不是能力差别，是准入方式的差别：
 * 可量化的场景才能按效果结算，靠关系准入的场景只能按项目计价。
 */
function judgeOriginPath(profiles: CompanyProfile[]): Judgment[] {
  const rows = crossTab(profiles, AXIS.founder, AXIS.billing).filter(r => r.total >= MIN_GROUP);
  if (rows.length < 2) return [];
  const scored = rows.map(r => {
    let proj = 0;
    for (const [b, n] of r.cells) if (PROJECT_BILLING.test(b)) proj += n;
    return { r, proj, share: proj / r.total };
  }).sort((a, b) => b.share - a.share);
  const high = scored[0], low = scored[scored.length - 1];
  if (high.share - low.share < 0.25) return [];

  const detail = scored.map(s => {
    const top = [...s.r.cells.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k} ${v}`).join("、");
    return `${s.r.row}（${s.r.total} 家）项目制 ${pct(s.proj, s.r.total)}，分布：${top}`;
  }).join("；");

  const inJudgment = rows.reduce((s, r) => s + r.total, 0);
  const labeled = profiles.filter(p => labelOf(p, AXIS.founder)).length;
  const confidence = confidenceFromGrades([...high.r.grades, ...low.r.grades]);
  return [{
    claim: `创始人上一段经历决定了收费方式：`
      + `${high.r.row}项目制占 ${pct(high.proj, high.r.total)}，${low.r.row}只占 ${pct(low.proj, low.r.total)}`,
    confidence,
    support: `${detail}。分母是两个字段都有取值的公司。`
      + gradeNote(confidence, AXIS.billing.label),
    // 这里要分清三个数，混起来就是在虚报分母：
    // 全表 207 → 有背景标签 84 → 进了这条判断 79（只算 5 家以上的组）。
    counter: `全表 ${profiles.length} 家里只有 ${labeled} 家能查到创始人背景，`
      + `其中 ${inJudgment} 家落在 5 家以上的组里、进了这条判断——`
      + `剩下那 ${profiles.length - labeled} 家不在这条结论的范围内，别当成全名单的规律。`
      + `而且一家公司可能有多个背景标签，这里按「体制内优先」收成了一个桶。`,
    implication: `看一家公司的天花板，先看创始人上一段在哪——它同时预测了客户类型和毛利结构。`,
    origin: "computed",
  }];
}

/** 判断集合：算出来的排前面（可回溯），人写的排后面并标注。 */
export type JudgmentSet = {
  computed: Judgment[];
  manual: Judgment[];
  all: Judgment[];
  /** 讲这批公司的。这是报告的正文，渲染在最上面。 */
  companies: Judgment[];
  /** 讲这份数据自己的（覆盖率、盲区、还有多少没判定）。是脚注，不是正文。
   *  必须保留：不说清边界就等于只报好消息。但不能和上面那些平铺在一起。 */
  corpus: Judgment[];
};

export function buildJudgments(profiles: CompanyProfile[], manual: ManualJudgment[] = []): JudgmentSet {
  // 顺序就是重要性顺序，读者从上往下读。
  // 前面是关于这些公司的（交叉表出来的实质结论），后面才是关于这份数据的
  // （覆盖率、盲区、离群值）。第一版把顺序搞反了：一进门全是数据质量，
  // 读者读完仍然不知道这些公司在做什么。
  const computed = [
    // 「定制」不能进这个正则：它会连带命中「平台+定制」，那是另一种模式
    // （有产品底座，定制在上面），混进项目制会把差异抹平。
    ...judgeCrossSpread(profiles, AXIS.sector, AXIS.billing, PROJECT_BILLING, {
      noun: "项目制",
      headline: (high, low) => `收费方式是赛道定的，不是商务谈出来的：${high}，${low}`,
      implication: "想做订阅或按效果付费，赛道选择在进场那一刻就决定了大半，"
        + "不是靠后期商务谈判能改的。反过来说，进政务/能源这类场景就该按项目制去设计现金流。",
    }),
    ...judgeOriginPath(profiles),
    ...judgeStalledPattern(profiles),
    ...judgeCrossSpread(profiles, AXIS.sector, AXIS.stage, /无公开融资/, {
      noun: "查不到任何公开融资",
      headline: (high, low) => `「查不到融资」也是分赛道的：${high}，${low}`,
      implication: "在高比例的那几个赛道里，靠融资数据库找同行会系统性漏掉大半——"
        + "得改用中标公告、算法备案、招聘页这类侧面渠道。这也是这份名单的价值区所在。",
    }),
    // 手挑的三对之外，剩下的交叉轴全扫一遍。
    // seen 里放的是上面已经手写过的那三对，避免同一对出两条判断——
    // 手写的措辞更准，所以保留手写的、跳过扫出来的。
    // 两个方向都要标：交叉表转置之后是同一张表，
    // 只标 sector×billing 的话扫描会再出一条 billing×sector，说的是同一件事。
    ...judgeAllCrossSpreads(profiles, new Set([
      "sector×billing", "billing×sector",
      "founder×billing", "billing×founder",
      "sector×stage", "stage×sector",
    ])),
    ...judgeConcentration(profiles),
    // 下面这几条讲的是「我们抓到哪一步」，不是这批公司什么样。
    // 它们带 scope:"corpus"，渲染时会被分到脚注区去。
    ...judgeRelevanceProgress(profiles),
    ...judgeVisibilityGap(profiles),
    ...judgeBlindSpots(profiles),
    ...judgeOutliers(profiles),
  ];
  const manualJudgments: Judgment[] = manual.map(m => ({ ...m, origin: "manual" as const }));
  const all = [...computed, ...manualJudgments];
  // 不给 scope 的默认算讲公司：人工判断全都是讲公司的，
  // 而漏标一条 corpus 的后果（它跑到正文里）比反过来轻。
  return {
    computed,
    manual: manualJudgments,
    all,
    companies: all.filter(j => (j.scope ?? "companies") === "companies"),
    corpus: all.filter(j => j.scope === "corpus"),
  };
}

/** 给报告渲染的交叉表。判断里写的是极值两端，这张表让读者看到中间那几档，
 *  自己核对结论——只给结论不给表，读者没法反驳我。 */
export type CrossTable = {
  title: string;
  rowLabel: string;
  cols: string[];
  rows: Array<{ row: string; total: number; counts: number[]; shares: number[] }>;
  /** 被高亮的那一列（判断里用的那类取值），渲染时加重。 */
  highlight: string | null;
  note: string;
};

export function sectorBillingTable(profiles: CompanyProfile[]): CrossTable | null {
  const rows = crossTab(profiles, AXIS.sector, AXIS.billing).filter(r => r.total >= MIN_GROUP);
  if (rows.length < 3) return null;
  // 列按全表总量排序，这样各行的列顺序一致，能上下对着看。
  const totals = new Map<string, number>();
  for (const r of rows) for (const [c, n] of r.cells) totals.set(c, (totals.get(c) ?? 0) + n);
  const cols = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const scored = rows.map(r => {
    let proj = 0;
    for (const [c, n] of r.cells) if (PROJECT_BILLING.test(c)) proj += n;
    return { r, share: proj / r.total };
  }).sort((a, b) => b.share - a.share);
  return {
    title: "赛道 × 计费方式",
    rowLabel: "赛道",
    cols,
    rows: scored.map(({ r }) => ({
      row: r.row,
      total: r.total,
      counts: cols.map(c => r.cells.get(c) ?? 0),
      shares: cols.map(c => (r.cells.get(c) ?? 0) / r.total),
    })),
    highlight: cols.find(c => PROJECT_BILLING.test(c)) ?? null,
    note: `按项目制占比从高到低排。每行分母是「这个赛道里两个字段都有取值的公司数」，`
      + `所以行之间能横向比，但各行分母不同——不要把百分比加总。`
      + `只列 ${MIN_GROUP} 家以上的赛道。`,
  };
}

export function founderBillingTable(profiles: CompanyProfile[]): CrossTable | null {
  const rows = crossTab(profiles, AXIS.founder, AXIS.billing).filter(r => r.total >= MIN_GROUP);
  if (rows.length < 2) return null;
  const totals = new Map<string, number>();
  for (const r of rows) for (const [c, n] of r.cells) totals.set(c, (totals.get(c) ?? 0) + n);
  const cols = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const labeled = profiles.filter(p => labelOf(p, AXIS.founder)).length;
  return {
    title: "创始人背景 × 计费方式",
    rowLabel: "创始人背景",
    cols,
    rows: rows.map(r => ({
      row: r.row,
      total: r.total,
      counts: cols.map(c => r.cells.get(c) ?? 0),
      shares: cols.map(c => (r.cells.get(c) ?? 0) / r.total),
    })),
    highlight: cols.find(c => PROJECT_BILLING.test(c)) ?? null,
    note: `全表 ${profiles.length} 家里只有 ${labeled} 家能查到创始人背景，这张表只覆盖那一部分。`
      + `多标签的公司按「体制内优先」收成一个桶。`,
  };
}

/** 一眼能读的比例条要的数据：标签 + 数量 + 占比。渲染在 report-html.ts。 */
export type BarRow = { label: string; count: number; share: number; hint?: string };

/** 按维度算「每个维度查到了多少」，给概览的横条用。 */
export function dimensionBars(profiles: CompanyProfile[]): BarRow[] {
  return DIMENSIONS.map(dim => {
    let filled = 0;
    for (const profile of profiles) {
      for (const field of dim.fields) if (fact(profile, dim.id, field.key)) filled += 1;
    }
    const cells = profiles.length * dim.fields.length;
    return {
      label: dim.label,
      count: filled,
      share: cells ? filled / cells : 0,
      hint: `${dim.fields.length} 字段 × ${profiles.length} 家`,
    };
  }).sort((a, b) => b.share - a.share);
}

/** 按字段算完整度，给「先看清缺口再看结论」那一节。 */
export function fieldBars(profiles: CompanyProfile[]): BarRow[] {
  return ALL_FIELDS.map(spec => {
    let filled = 0;
    for (const profile of profiles) if (fact(profile, spec.dimension, spec.key)) filled += 1;
    return {
      label: spec.label,
      count: filled,
      share: profiles.length ? filled / profiles.length : 0,
      hint: spec.where,
    };
  }).sort((a, b) => b.share - a.share);
}

/** 上市地分布，给「它们是谁」那一节的分组条。 */
export function listingBars(profiles: CompanyProfile[]): BarRow[] {
  const tally = new Map<Listing, number>();
  for (const p of profiles) tally.set(p.listing, (tally.get(p.listing) ?? 0) + 1);
  return [...tally.entries()]
    .map(([key, count]) => ({
      label: LISTING_LABEL[key],
      count,
      share: profiles.length ? count / profiles.length : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

