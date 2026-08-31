const BLOCK_TAGS = /<\/?(?:article|aside|blockquote|br|div|dl|dt|dd|h[1-6]|li|main|ol|p|section|table|tbody|td|th|thead|tr|ul)[^>]*>/gi;
const SCRIPT_OR_STYLE = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&gt;": ">",
  "&lt;": "<",
  "&nbsp;": " ",
  "&quot;": '"',
  "&#39;": "'",
};

export function sourceText(input: string): string {
  const withoutScripts = input.replace(SCRIPT_OR_STYLE, " ");
  const withBreaks = withoutScripts.replace(BLOCK_TAGS, "\n");
  const withoutTags = withBreaks.replace(/<[^>]+>/g, " ");
  const decoded = withoutTags.replace(/&(amp|gt|lt|nbsp|quot|#39);/g, entity => ENTITIES[entity] ?? entity);
  return decoded
    .split(/\r?\n/)
    .map(line => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function sourceLines(input: string): string[] {
  return sourceText(input).split("\n").filter(Boolean);
}

export function isoDateFromText(input: string): string {
  const match = input.match(/(20\d{2})[年\-/.](\d{1,2})[月\-/.](\d{1,2})/);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

export function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
