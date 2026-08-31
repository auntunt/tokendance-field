export interface FieldSignal {
  field: string;
  value: string;
  /**
   * A value can be represented by several independently verifiable terms.
   * For example, “数据中心运维” is supported only when both “数据中心” and
   * “运维” occur in the frozen reference chapters.
   */
  referenceTerms?: string[];
}

export interface FieldHit {
  field: string;
  value: string;
  referenceTerms: string[];
  hit: boolean;
}

export interface FieldHitReport {
  total: number;
  hits: number;
  rate: number;
  fields: FieldHit[];
}

function normalized(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

export function markdownChapterRange(markdown: string, from: number, to: number): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => new RegExp(`^##\\s+${from}\\.`).test(line));
  if (start < 0) throw new Error(`找不到第 ${from} 章`);
  const end = lines.findIndex((line, index) => index > start && new RegExp(`^##\\s+${to + 1}\\.`).test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

export function measureFieldHitRate(reference: string, signals: FieldSignal[]): FieldHitReport {
  const searchable = normalized(reference);
  const fields = signals
    .filter(signal => signal.value.trim())
    .map(signal => {
      const referenceTerms = (signal.referenceTerms?.length ? signal.referenceTerms : [signal.value])
        .map(term => term.trim())
        .filter(Boolean);
      return {
        field: signal.field,
        value: signal.value,
        referenceTerms,
        hit: referenceTerms.length > 0 && referenceTerms.every(term => searchable.includes(normalized(term))),
      };
    });
  const hits = fields.filter(field => field.hit).length;
  return {
    total: fields.length,
    hits,
    rate: fields.length === 0 ? 0 : hits / fields.length,
    fields,
  };
}
