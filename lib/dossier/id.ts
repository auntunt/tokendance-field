import { createHash } from "node:crypto";

export function stableId(prefix: string, ...parts: string[]): string {
  const normalized = parts.map(part => part.trim().toLowerCase()).join("\u001f");
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 20);
  return `${prefix}_${digest}`;
}

export function contentFingerprint(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}
