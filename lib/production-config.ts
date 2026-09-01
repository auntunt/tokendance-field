export interface ProductionConfigIssue {
  key: string;
  level: "error" | "warning";
  message: string;
}

export interface ProductionConfigCheck {
  issues: ProductionConfigIssue[];
  feedUrls: string[];
}

const PLACEHOLDER = /replace-with|your-gateway|example\.com/i;

function valueOf(env: Record<string, string | undefined>, key: string): string {
  return env[key]?.trim() ?? "";
}

export function checkProductionConfig(
  env: Record<string, string | undefined>,
): ProductionConfigCheck {
  const issues: ProductionConfigIssue[] = [];
  const error = (key: string, message: string): void => {
    issues.push({ key, level: "error", message });
  };
  const warning = (key: string, message: string): void => {
    issues.push({ key, level: "warning", message });
  };

  const accessUser = valueOf(env, "FIELD_ACCESS_USER");
  const accessPassword = valueOf(env, "FIELD_ACCESS_PASSWORD");
  if (!accessUser) error("FIELD_ACCESS_USER", "必须配置站点登录用户名");
  if (accessPassword.length < 12 || PLACEHOLDER.test(accessPassword)) {
    error("FIELD_ACCESS_PASSWORD", "必须使用至少 12 字符且不是示例占位值的登录密码");
  }

  const requiredPaths = {
    DATABASE_PATH: "/data/tokendance-field.sqlite",
    DOSSIER_DB_PATH: "/data/fde-dossier.sqlite",
    FIELD_REPORTS_DIR: "/reports",
  } as const;
  for (const [key, expected] of Object.entries(requiredPaths)) {
    const actual = valueOf(env, key);
    if (actual !== expected) error(key, `生产环境必须配置为 ${expected}`);
  }

  const cronSecret = valueOf(env, "CRON_SECRET");
  if (cronSecret.length < 32 || PLACEHOLDER.test(cronSecret)) {
    error("CRON_SECRET", "必须使用至少 32 字符且不是示例占位值的独立随机密钥");
  } else if (cronSecret === accessPassword) {
    error("CRON_SECRET", "不能与站点登录密码复用");
  }

  const industryId = valueOf(env, "INDUSTRY_WEEKLY_INDUSTRY_ID");
  if (industryId !== "construction-digitalization") {
    error("INDUSTRY_WEEKLY_INDUSTRY_ID", "当前生产验收必须使用 construction-digitalization");
  }

  const rawFeedUrls = valueOf(env, "INDUSTRY_WEEKLY_FEED_URLS")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const feedUrls = [...new Set(rawFeedUrls)];
  if (feedUrls.length === 0) {
    error("INDUSTRY_WEEKLY_FEED_URLS", "至少配置一个中转 HTTPS JSON 地址");
  }
  if (feedUrls.length !== rawFeedUrls.length) {
    warning("INDUSTRY_WEEKLY_FEED_URLS", "包含重复地址，已按 URL 去重检查");
  }
  for (const url of feedUrls) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        error("INDUSTRY_WEEKLY_FEED_URLS", `只允许 HTTPS：${url}`);
      }
      if (parsed.username || parsed.password) {
        error("INDUSTRY_WEEKLY_FEED_URLS", `URL 不得内嵌用户名或密码：${parsed.host}`);
      }
      if (PLACEHOLDER.test(parsed.hostname)) {
        error("INDUSTRY_WEEKLY_FEED_URLS", `仍是示例占位地址：${parsed.hostname}`);
      }
    } catch {
      error("INDUSTRY_WEEKLY_FEED_URLS", `不是合法 URL：${url}`);
    }
  }

  return { issues, feedUrls };
}
