import assert from "node:assert/strict";
import test from "node:test";
import { checkProductionConfig } from "../lib/production-config";

const valid = {
  FIELD_ACCESS_USER: "tokendance",
  FIELD_ACCESS_PASSWORD: "site-password-long-enough",
  DATABASE_PATH: "/data/tokendance-field.sqlite",
  DOSSIER_DB_PATH: "/data/fde-dossier.sqlite",
  FIELD_REPORTS_DIR: "/reports",
  CRON_SECRET: "cron-secret-that-is-longer-than-thirty-two-characters",
  INDUSTRY_WEEKLY_INDUSTRY_ID: "construction-digitalization",
  INDUSTRY_WEEKLY_FEED_URLS: "https://relay.tokendance.cool/construction-digitalization.json",
};

test("生产检查接受持久化路径、独立密钥和真实 HTTPS Feed", () => {
  const result = checkProductionConfig(valid);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.feedUrls, [valid.INDUSTRY_WEEKLY_FEED_URLS]);
});

test("生产检查拒绝示例值、错误行业、非持久化路径和 HTTP Feed", () => {
  const result = checkProductionConfig({
    ...valid,
    FIELD_ACCESS_PASSWORD: "replace-with-password",
    DOSSIER_DB_PATH: "./data/dossier.db",
    CRON_SECRET: "replace-with-a-separate-random-secret",
    INDUSTRY_WEEKLY_INDUSTRY_ID: "data-center",
    INDUSTRY_WEEKLY_FEED_URLS: "http://example.com/feed.json",
  });
  const keys = result.issues.filter((issue) => issue.level === "error").map((issue) => issue.key);
  assert.ok(keys.includes("FIELD_ACCESS_PASSWORD"));
  assert.ok(keys.includes("DOSSIER_DB_PATH"));
  assert.ok(keys.includes("CRON_SECRET"));
  assert.ok(keys.includes("INDUSTRY_WEEKLY_INDUSTRY_ID"));
  assert.equal(keys.filter((key) => key === "INDUSTRY_WEEKLY_FEED_URLS").length, 2);
});

test("生产检查拒绝 Cron 与登录共用密钥，并提示重复 Feed", () => {
  const sharedSecret = "one-shared-secret-that-is-longer-than-thirty-two-characters";
  const result = checkProductionConfig({
    ...valid,
    FIELD_ACCESS_PASSWORD: sharedSecret,
    CRON_SECRET: sharedSecret,
    INDUSTRY_WEEKLY_FEED_URLS: `${valid.INDUSTRY_WEEKLY_FEED_URLS},${valid.INDUSTRY_WEEKLY_FEED_URLS}`,
  });
  assert.ok(result.issues.some((issue) => issue.key === "CRON_SECRET" && issue.level === "error"));
  assert.ok(result.issues.some((issue) => issue.key === "INDUSTRY_WEEKLY_FEED_URLS" && issue.level === "warning"));
  assert.equal(result.feedUrls.length, 1);
});
