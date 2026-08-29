// 情报的“发生时间”与“入库时间”必须分开。
// createdAt 只表示系统什么时候收录；首页“最近发生了什么”应从材料原文中取事件/披露日期。

export type DatedSignal = {
  id?: string;
  title?: string;
  evidence?: string;
  source?: string;
  sourceUrl?: string;
  createdAt?: string;
};

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function validDate(y: number, m: number, d: number, now: Date): Date | null {
  if (y < 2000 || y > now.getUTCFullYear() + 1 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const value = new Date(Date.UTC(y, m - 1, d));
  if (value.getUTCFullYear() !== y || value.getUTCMonth() !== m - 1 || value.getUTCDate() !== d) return null;
  if (value.getTime() > now.getTime() + 86400000) return null;
  return value;
}

/** 从正文、标题或 URL 中取最近一个已经发生的完整日期。 */
export function latestObservedDate(text: string, now = new Date()): Date | null {
  const found: Date[] = [];
  const push = (y: number, m: number, d: number) => {
    const value = validDate(y, m, d, now);
    if (value) found.push(value);
  };
  for (const match of text.matchAll(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) push(+match[1], +match[2], +match[3]);
  for (const match of text.matchAll(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/g)) push(+match[1], +match[2], +match[3]);
  for (const match of text.matchAll(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})/gi)) {
    push(+match[3], MONTHS[match[1].toLowerCase()], +match[2]);
  }
  return found.length ? new Date(Math.max(...found.map(item => item.getTime()))) : null;
}

export function signalEventDate(signal: DatedSignal, now = new Date()): Date | null {
  return latestObservedDate(`${signal.title || ""} ${signal.evidence || ""} ${signal.source || ""} ${signal.sourceUrl || ""}`, now);
}

/** 有明确事件日期的永远排在无日期材料前；同为有日期时按日期倒序。 */
export function compareSignalEventDate(a: DatedSignal, b: DatedSignal, now = new Date()): number {
  const left = signalEventDate(a, now)?.getTime();
  const right = signalEventDate(b, now)?.getTime();
  if (left !== undefined && right !== undefined && left !== right) return right - left;
  if (left !== undefined && right === undefined) return -1;
  if (left === undefined && right !== undefined) return 1;
  return 0;
}

export function signalEventDateLabel(signal: DatedSignal, now = new Date()): string | null {
  return signalEventDate(signal, now)?.toISOString().slice(0, 10) || null;
}
