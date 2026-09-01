import { contentFingerprint, stableId } from "../dossier/id";
import type { EvidencePointer, IndustryUpdateRecord, IndustryWeeklyCollection, SourceType } from "../dossier/types";

interface FeedItem {
  date?: unknown;
  kind?: unknown;
  companyId?: unknown;
  title?: unknown;
  summary?: unknown;
  url?: unknown;
  sourceType?: unknown;
}

const KINDS = new Set<IndustryUpdateRecord["kind"]>(["peer_case", "procurement", "policy", "vendor_move", "target_action"]);
const SOURCE_TYPES = new Set<SourceType>(["filing", "official", "third_party"]);
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const FEED_TIMEOUT_MS = 15_000;

function validSourceUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function collectIndustryWeeklyFeed(industryId: string, content: string): IndustryWeeklyCollection {
  const parsed = JSON.parse(content) as { items?: FeedItem[] };
  if (!Array.isArray(parsed.items)) throw new Error("行业周报列表缺少 items");
  const sources = [];
  const updates = [];
  for (const item of parsed.items) {
    if (typeof item.date !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(item.date)) continue;
    if (typeof item.kind !== "string" || !KINDS.has(item.kind as IndustryUpdateRecord["kind"])) continue;
    if (typeof item.title !== "string" || !item.title.trim() || !validSourceUrl(item.url)) continue;
    const title = item.title.trim();
    const summary = typeof item.summary === "string" && item.summary.trim() ? `${title}：${item.summary.trim()}` : title;
    const fingerprint = contentFingerprint(`${item.title}\n${summary}`);
    const sourceId = stableId("src", item.url, fingerprint);
    const sourceType = typeof item.sourceType === "string" && SOURCE_TYPES.has(item.sourceType as SourceType)
      ? (item.sourceType as SourceType)
      : "third_party";
    const source = {
      id: sourceId, url: item.url, type: sourceType, publishedAt: item.date,
      fingerprint, pageOrExcerpt: summary,
    };
    const evidence: EvidencePointer = { sourceId, excerpt: summary };
    const companyId = typeof item.companyId === "string" ? item.companyId.trim() : "";
    const record: IndustryUpdateRecord = {
      id: stableId("update", industryId, item.url, item.title),
      industryId,
      foundAt: item.date,
      kind: item.kind as IndustryUpdateRecord["kind"],
      companyId,
      summary,
      promotedToEventId: "",
    };
    sources.push(source);
    updates.push({
      record,
      evidence: {
        industry_id: evidence, found_at: evidence, kind: evidence,
        ...(companyId ? { company_id: evidence } : {}), summary: evidence,
      },
    });
  }
  return {
    sources: [...new Map(sources.map(source => [source.id, source])).values()],
    updates: [...new Map(updates.map(update => [update.record.id, update])).values()],
  };
}

export async function fetchIndustryWeeklyFeed(industryId: string, url: string): Promise<IndustryWeeklyCollection> {
  if (!validSourceUrl(url)) throw new Error(`行业周报中转源必须使用 HTTPS：${url}`);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`行业周报中转源请求失败：${response.status} ${url}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_FEED_BYTES) throw new Error(`行业周报中转源超过 2 MB：${url}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_FEED_BYTES) throw new Error(`行业周报中转源超过 2 MB：${url}`);
  return collectIndustryWeeklyFeed(industryId, new TextDecoder().decode(bytes));
}
