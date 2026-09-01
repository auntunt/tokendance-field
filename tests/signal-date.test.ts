import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.ts";

const outDir = buildKernel();
const require = createRequire(import.meta.url);
const dates = require(`${outDir}/signal-date.js`);
const NOW = new Date("2026-08-18T12:00:00.000Z");

test("事件日期从材料中提取，不拿统一入库时间冒充发生时间", () => {
  const signal = {
    title: "Snowflake 最新年报",
    evidence: "截至 2026-01-31 财年的 10-K 披露竞争关系。",
    createdAt: "2026-08-18T13:00:00.000Z",
  };
  assert.equal(dates.signalEventDateLabel(signal, NOW), "2026-01-31");
});

test("同一天入库时，7 月事件必须排在 1 月事件前", () => {
  const january = { id: "jan", evidence: "财年截止 2026-01-31。", createdAt: "2026-08-18T13:00:00.000Z" };
  const july = { id: "jul", evidence: "公司于 2026-07-30 宣布新任 CEO。", createdAt: "2026-08-18T13:00:00.000Z" };
  const ranked = [january, july].sort((a, b) => dates.compareSignalEventDate(a, b, NOW));
  assert.deepEqual(ranked.map(item => item.id), ["jul", "jan"]);
});

test("有明确事件日期的材料排在日期待核材料前", () => {
  const undated = { id: "unknown", evidence: "公司宣布了一项新的战略合作。", createdAt: "2026-08-18T14:00:00.000Z" };
  const dated = { id: "dated", evidence: "公司于 2026-06-17 宣布战略合作。", createdAt: "2026-08-18T12:00:00.000Z" };
  const ranked = [undated, dated].sort((a, b) => dates.compareSignalEventDate(a, b, NOW));
  assert.deepEqual(ranked.map(item => item.id), ["dated", "unknown"]);
});

test("未来合作期限不被误认成最新事件日期", () => {
  const signal = { evidence: "双方于 2026-07-23 宣布将合作延长至 2030-12-31。" };
  assert.equal(dates.signalEventDateLabel(signal, NOW), "2026-07-23");
});
