import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fetchIndustryWeeklyFeed } from "../lib/collectors/industry-weekly";
import { checkProductionConfig } from "../lib/production-config";

function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    env[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return env;
}

function argument(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const args = process.argv.slice(2);
const envFile = argument(args, "--file", ".env");
const skipFeed = args.includes("--skip-feed");

try {
  const env = parseEnv(await readFile(resolve(envFile), "utf8"));
  const config = checkProductionConfig(env);
  for (const issue of config.issues) {
    const mark = issue.level === "error" ? "✖" : "!";
    console.log(`${mark} ${issue.key}  ${issue.message}`);
  }
  const errors = config.issues.filter((issue) => issue.level === "error");
  if (errors.length > 0) {
    throw new Error(`生产配置有 ${errors.length} 项不可用`);
  }
  console.log(`✔ 生产配置  ${config.feedUrls.length} 个中转地址，路径与密钥规则通过`);

  if (skipFeed) {
    console.log("! 行业周报  已跳过真实 Feed 请求，仅完成静态检查");
  } else {
    const collections = await Promise.all(
      config.feedUrls.map((url) => fetchIndustryWeeklyFeed(env.INDUSTRY_WEEKLY_INDUSTRY_ID, url)),
    );
    const updateIds = new Set(collections.flatMap((collection) =>
      collection.updates.map((update) => update.record.id),
    ));
    if (updateIds.size < 3) {
      throw new Error(`真实 Feed 合计只有 ${updateIds.size} 条有效记录，不能满足每周至少 3 条的验收下限`);
    }
    console.log(`✔ 行业周报  ${updateIds.size} 条去重后的有效记录`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`生产检查失败：${message}`);
  process.exitCode = 1;
}
