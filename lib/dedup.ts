// 语料判重——唯一的判重出口。collect 和 extract 都必须从这里过。
//
// 为什么不按 URL 判重：同一份法定披露会同时挂在巨潮、交易所和一堆转载媒体上，
// URL 全都不一样。按 URL 判，等于每被转载一次就重新抽一次；更糟的是台账里会留下
// 几条看起来互相独立的记录——那是把转载伪装成第二来源，会虚高"有好几家都这么说"。
//
// 判重不拦人。它只回答两件事：这段语料见过没有、上次是谁给的。
// 要不要再抽一遍是人的决定。但重复语料绝不许悄悄变成一条新证据。
//
// 判重与六道门无关，也永远不许碰门：门问的是"这个判断的证据够不够"，
// 判重问的是"这段材料是不是同一份"。两件事混在一起，就会出现
// "因为查重通过所以证据变硬"这种荒谬推论。见 tests/discipline.test.mjs。
import { createHash } from "node:crypto";
import { normalizeCorpus } from "./normalize-text";

/** 归一化后参与哈希的最大字符数。超长语料截断——前 5 万字足以区分两份披露。 */
const FINGERPRINT_LIMIT = 50_000;

export type CorpusSighting = {
  id: string;
  fingerprint: string;
  sourceName: string;
  sourceUrl: string | null;
  entryPoint: "collect" | "extract" | "query";
  seenAt: string;
  textLength: number;
  candidatesCount: number;
};

export type RepeatVerdict = {
  /** 这段语料之前见过。 */
  seen: boolean;
  /** 第一次见到的时间。 */
  firstSeenAt: string;
  /** 第一次是谁给的。 */
  firstSource: string;
  /** 一共见过几次（含这次之前的所有次）。 */
  timesSeen: number;
  /** 这次的来源与第一次不同——说明是转载，不是第二个独立来源。 */
  differentSource: boolean;
  /** 给人看的一句话。 */
  message: string;
};

// 归一化规则不在这里——它同时被前端版图层使用，单独放在 lib/normalize-text.ts。
// 这里原样转出，判重的对外接口不变（tests/dedup.test.mjs 仍从 dedup 取 normalizeCorpus）。
// 千万不要在这里再抄一份：两份归一化规则一旦分叉，前端会说“两个来源”而后端说
// “同一份转载”，而两边都自称事实。
export { normalizeCorpus } from "./normalize-text";

/** 语料指纹。同一份文本无论排版怎么变，指纹相同。 */
export function corpusFingerprint(text: string): string {
  const normalized = normalizeCorpus(text).slice(0, FINGERPRINT_LIMIT);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/** 判重台账。与 collection_log 分开：那张表以 URL 为中心，抽取入口根本没有 URL。 */
export function ensureCorpusTable(db: Pick<Db, "exec">) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS corpus_log (
      id TEXT PRIMARY KEY NOT NULL,
      fingerprint TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_url TEXT,
      entry_point TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      text_length INTEGER NOT NULL,
      candidates_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS corpus_fingerprint_idx ON corpus_log(fingerprint);
  `);
}

type Row = { id: string; fingerprint: string; source_name: string; source_url: string | null; entry_point: string; seen_at: string; text_length: number; candidates_count: number };
// 直接用 better-sqlite3 自己的类型。手写结构类型跟它的 prepare 重载签名对不上，
// 而放宽成 any 就等于把这一层的类型检查关掉。
type Db = InstanceType<typeof import("better-sqlite3")>;

/** 这段语料之前的所有记录，最早的在前。 */
export function priorSightings(db: Db, fingerprint: string): CorpusSighting[] {
  ensureCorpusTable(db);
  const rows = db.prepare(
    "SELECT * FROM corpus_log WHERE fingerprint=? ORDER BY seen_at ASC"
  ).all(fingerprint) as Row[];
  return rows.map(row => ({
    id: row.id, fingerprint: row.fingerprint, sourceName: row.source_name,
    sourceUrl: row.source_url, entryPoint: row.entry_point === "collect" ? "collect" : row.entry_point === "query" ? "query" : "extract",
    seenAt: row.seen_at, textLength: row.text_length, candidatesCount: row.candidates_count,
  }));
}

/**
 * 判重结论。只描述事实，不给建议、不给分数，也不阻止任何事。
 * 调用方拿到 seen=true 之后怎么做，是调用方的决定——本函数不替它决定。
 */
export function repeatVerdict(prior: CorpusSighting[], thisSource: string): RepeatVerdict | null {
  if (!prior.length) return null;
  const first = prior[0];
  const differentSource = first.sourceName.trim() !== thisSource.trim();
  // 转载与重抓要分开说。同一个来源重复给同一份东西，是重复操作；
  // 换个来源给同一份东西，是转载——后者更要紧，因为它会被误当成第二个独立来源。
  const message = differentSource
    ? `这段材料见过了。${first.seenAt.slice(0, 10)} 由「${first.sourceName}」给过同样一份，逐字一致。换了个来源不等于多了一个消息源——转载不算第二来源。`
    : `这段材料见过了。${first.seenAt.slice(0, 10)} 从「${first.sourceName}」收过同样一份，逐字一致。`;
  return { seen: true, firstSeenAt: first.seenAt, firstSource: first.sourceName, timesSeen: prior.length, differentSource, message };
}

/**
 * 记一次见到。台账只增不改。
 *
 * id 必须把来源和入口算进去：曾经只用「时间戳 + 指纹」拼 id，配上 INSERT OR REPLACE，
 * 结果同一毫秒内同一份语料从两个来源进来会撞 id，后一条直接盖掉前一条——
 * 「来源A 也给过这份」这个事实被静默抹掉，于是"见过几次"和"第一次是谁给的"全都不可信。
 * 判重层的全部价值就在这两个数上，所以这里用纯 INSERT，撞了就报错，绝不静默覆盖。
 */
export function recordSighting(db: Db, entry: Omit<CorpusSighting, "id">): string {
  ensureCorpusTable(db);
  const salt = createHash("sha256")
    .update(`${entry.seenAt}|${entry.sourceName}|${entry.sourceUrl ?? ""}|${entry.entryPoint}`)
    .digest("hex").slice(0, 10);
  const id = `corpus-${entry.fingerprint.slice(0, 8)}-${salt}`;
  db.prepare(
    "INSERT OR IGNORE INTO corpus_log (id,fingerprint,source_name,source_url,entry_point,seen_at,text_length,candidates_count) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, entry.fingerprint, entry.sourceName, entry.sourceUrl, entry.entryPoint, entry.seenAt, entry.textLength, entry.candidatesCount);
  return id;
}
