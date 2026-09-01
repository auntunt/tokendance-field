import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  collectIndustryWeeklyFeed,
  fetchIndustryWeeklyFeed,
} from "../lib/collectors/industry-weekly";
import type { IndustryWeeklyCollection } from "../lib/dossier/types";

function usage(): never {
  console.error([
    "用法：",
    "  npm run industry:validate-feed -- <industry-id> https://relay.example.com/feed.json",
    "  npm run industry:validate-feed -- <industry-id> --file ./feed.json",
  ].join("\n"));
  process.exit(2);
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  return values.reduce<Record<T, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {} as Record<T, number>);
}

async function loadCollection(industryId: string, args: string[]): Promise<IndustryWeeklyCollection> {
  if (args[0] === "--file") {
    const path = args[1];
    if (!path) usage();
    return collectIndustryWeeklyFeed(industryId, await readFile(resolve(path), "utf8"));
  }

  const url = args[0];
  if (!url) usage();
  return fetchIndustryWeeklyFeed(industryId, url);
}

const [industryId, ...input] = process.argv.slice(2);
if (!industryId || input.length === 0) usage();

try {
  const collection = await loadCollection(industryId, input);
  if (collection.updates.length === 0) {
    throw new Error("feed 可以解析，但没有任何符合合同的有效条目");
  }

  const dates = collection.updates.map(item => item.record.foundAt).sort();
  const summary = {
    ok: true,
    industryId,
    updates: collection.updates.length,
    sources: collection.sources.length,
    dateRange: { from: dates[0], to: dates.at(-1) },
    kinds: countBy(collection.updates.map(item => item.record.kind)),
    sourceTypes: countBy(collection.sources.map(source => source.type)),
    assignedCompanies: collection.updates.filter(item => item.record.companyId).length,
    requiresFdeAssignment: collection.updates.filter(item => !item.record.companyId).length,
    weeklyAcceptanceReady: collection.updates.length >= 3,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.weeklyAcceptanceReady) {
    console.warn("警告：有效条目少于 3 条，本周无法仅靠这份 feed 达到 M6 最低选择数。");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, industryId, error: message }, null, 2));
  process.exitCode = 1;
}
