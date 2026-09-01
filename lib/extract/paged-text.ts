export interface PagedTextPage {
  pageNumber: number;
  text: string;
}

function trailingPageNumber(text: string): number | null {
  const match = text.match(/(?:^|\n)\s*(\d{1,4})\s*$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function splitPagedText(text: string): PagedTextPage[] {
  return text.split("\f").flatMap((raw, index) => {
    const cleaned = raw.trim();
    if (!cleaned) return [];
    return [{ pageNumber: trailingPageNumber(cleaned) ?? index + 1, text: cleaned }];
  });
}

export function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function excerptAround(text: string, pattern: RegExp, radius = 180): string {
  const match = pattern.exec(text);
  if (!match || match.index === undefined) return "";
  const start = Math.max(0, match.index - radius);
  const end = Math.min(text.length, match.index + match[0].length + radius);
  return compactText(text.slice(start, end));
}
