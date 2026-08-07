// 人物关系测绘。目的很具体：让销售知道该找谁、从哪条线切入。
//
// 三条纪律，和企业关系那侧完全一致，不因为"对象是人"就放松：
// 一、人物档案本身不是判断，不过闸。它是事实清单（谁在哪家、什么职务），
//     错了就改，不需要校准概率。所以 PersonRole 不带 constraints。
// 二、关于人物的**判断**（谁能拍板、从哪条线更短）仍然是普通情报，
//     以 evidence_records 形式走完整六道门。切入建议不能绕过纪律。
// 三、PII 边界在 ontology.ts 用字段白名单固化。这里只消费那份白名单，
//     不新增任何承载私生活的字段。
import { Signal, gateState } from "./field-core";
import { PersonRelationId, PersonRole } from "./ontology";

export type PersonNode = PersonRole & { id: string; createdAt: string };

/** 人物之间、或人物与主体之间的边。来源是情报的 edges，不是人物档案自身。 */
export type PersonLink = {
  from: string;
  to: string;
  relation: PersonRelationId | string;
  /** 支撑这条边的情报里最高过闸数。0–6。和企业关系图同一套语义。 */
  bestGate: number;
  executable: boolean;
  signalIds: string[];
};

/** 一个人在一次切入分析里的位置。分数只排序，不授权。 */
export type EntryPoint = {
  person: PersonNode;
  /** 已签署（六道门全过）的相关判断数。 */
  signedJudgments: number;
  /** 相关但尚未过闸的判断数——这些是待补齐的功课，不是证据。 */
  openJudgments: number;
  /** 我方是否写明了通路。空白不等于没有通路，等于还没查。 */
  hasPath: boolean;
  /** 排序用的粗分。它只回答"先看谁"，不回答"能不能去"。 */
  priority: number;
};

function norm(text: string) {
  return text.trim().toLowerCase();
}

/** 一个人的所有叫法：本名 + 括号里的花名。
 *  命中判定和"这个名字是不是他自己"必须用同一套别名，否则名册写「李全（全哥）」、
 *  情报里写「李全」时，前者认得出他、后者却把他当成一个主体列进关联里。 */
function aliasesOf(person: PersonNode) {
  const name = person.name.trim();
  if (!name) return [];
  return [name, ...(name.match(/[（(]([^）)]+)[）)]/g) || []).map(part => part.replace(/[（()）]/g, ""))]
    .map(item => item.replace(/[（(][^）)]*[）)]/g, "").trim())
    .filter(item => item.length >= 2);
}

/** 人名在情报里的出现判定。用全名匹配，避免"李全"命中"李全德"这类误伤。 */
function mentions(signal: Signal, person: PersonNode) {
  const aliases = aliasesOf(person);
  if (!aliases.length) return false;
  const haystack = `${signal.title}\n${signal.evidence}\n${(signal.edges || []).map(edge => `${edge.from} ${edge.to}`).join("\n")}`;
  // 中文没有词边界，\b 不管用：直接 includes 会让"李全"命中"李全德"。
  // 认错人会把销售的功夫下错方向，所以要求命中处两侧都不是汉字或字母。
  return aliases.some(alias => hasStandaloneMatch(haystack, alias));
}

const HANZI = /[一-龥]/;
/** 紧跟这些字时可以确定是语流而非姓名延续。按实际语料逐步加，不求穷尽。 */
const FOLLOW_PARTICLE = /[在是的和与对给由从把被为向就也都还将已曾说表示主导负责分管兼任出任担任牵头拍]/;
/** 中文姓名后面天然紧跟动词或助词（"李全在会上"），不能要求两侧留空。
 *  真正要防的只有一种情况：短名被更长的姓名包含（"李全" vs "李全德"）。
 *  所以只在前后各多看一个汉字、且拼出的更长串仍像姓名时，才判为误伤。 */
function hasStandaloneMatch(haystack: string, needle: string) {
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) {
    const before = haystack[index - 1] || "";
    const after = haystack[index + needle.length] || "";
    // 前面紧贴汉字 → 命中的是别人名字的后半截（"小李全"），弃掉。
    if (HANZI.test(before)) continue;
    // 后面紧贴汉字时无法只靠字形分辨"李全德"和"李全在"，
    // 用姓名长度约束：2 字名被撑到 3 字仍可能是姓名，故排除；
    // 3 字以上的名字已足够独特，紧跟汉字视为正常语流。
    if (needle.length <= 2 && HANZI.test(after) && !FOLLOW_PARTICLE.test(after)) continue;
    return true;
  }
  return false;
}

/**
 * 从一个目标主体出发，列出可切入的人——销售场景的主入口。
 * 反向（从一个人看他连着哪些主体）用 orgsOfPerson 走同一套边。
 */
export function entryPointsFor(employer: string, people: PersonNode[], signals: Signal[]): EntryPoint[] {
  const target = norm(employer);
  const roster = target ? people.filter(person => norm(person.employer) === target) : people;
  return roster
    .map(person => {
      const related = signals.filter(signal => mentions(signal, person));
      const signedJudgments = related.filter(signal => gateState(signal).executable).length;
      const openJudgments = related.length - signedJudgments;
      const hasPath = Boolean(person.ourPath.trim());
      // 已签署的判断权重最高，通路其次，未过闸的只算很轻的一点线索。
      // 这个分只用来排"先看谁"。它不是可信度，更不是许可。
      const priority = signedJudgments * 10 + (hasPath ? 4 : 0) + Math.min(openJudgments, 5);
      return { person, signedJudgments, openJudgments, hasPath, priority };
    })
    .sort((a, b) => b.priority - a.priority || a.person.name.localeCompare(b.person.name));
}

/** 从一个人出发，看他连着哪些主体。履历流动和多主体兼任是预判业务变化的线索。 */
export function orgsOfPerson(person: PersonNode, signals: Signal[]) {
  const hits = signals.filter(signal => mentions(signal, person));
  const orgs = new Map<string, { org: string; bestGate: number; signalIds: string[] }>();
  // gate 与 signalId 由调用处给：名册来的雇主关系没有情报支撑，
  // 它是录入时的事实声明，不该被塞进一个假 Signal 去走门。
  const self = new Set(aliasesOf(person).map(norm));
  const add = (org: string, gate: number, signalId?: string) => {
    const name = org.trim();
    // 人自己不算他连着的主体。按别名比，花名和本名都要排除。
    if (!name || self.has(norm(name))) return;
    const existing = orgs.get(name);
    if (existing) {
      existing.bestGate = Math.max(existing.bestGate, gate);
      if (signalId) existing.signalIds.push(signalId);
      return;
    }
    orgs.set(name, { org: name, bestGate: gate, signalIds: signalId ? [signalId] : [] });
  };
  for (const signal of hits) {
    const gate = gateState(signal).passed;
    for (const edge of signal.edges || []) { add(edge.from, gate, signal.id); add(edge.to, gate, signal.id); }
  }
  // 雇主一栏是名册自述，过门数记 0：写着不等于查过。
  if (person.employer.trim()) add(person.employer, 0);
  return [...orgs.values()].sort((a, b) => b.bestGate - a.bestGate || a.org.localeCompare(b.org));
}

/** 组织架构树。只从 reports_to 边构建，不猜层级。 */
export function reportingTree(people: PersonNode[], links: PersonLink[]) {
  const byName = new Map(people.map(person => [norm(person.name), person]));
  const parent = new Map<string, string>();
  for (const link of links) {
    if (link.relation !== "reports_to") continue;
    if (byName.has(norm(link.from)) && byName.has(norm(link.to))) parent.set(norm(link.from), norm(link.to));
  }
  const children = new Map<string, PersonNode[]>();
  const roots: PersonNode[] = [];
  for (const person of people) {
    const key = norm(person.name);
    const up = parent.get(key);
    if (up && byName.has(up)) {
      const list = children.get(up) || [];
      list.push(person);
      children.set(up, list);
    } else roots.push(person);
  }
  return { roots, childrenOf: (person: PersonNode) => children.get(norm(person.name)) || [] };
}
