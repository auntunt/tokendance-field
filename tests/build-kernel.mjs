// 把纪律内核单独编成 CommonJS，供 node:test 直接调用真实函数，
// 而不是靠 grep 源码字符串来"证明"约束还在。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, ".test-build");

export function buildKernel() {
  execFileSync(resolve(root, "node_modules/.bin/tsc"), [
    "lib/field-core.ts", "lib/ontology.ts", "lib/graph.ts", "lib/people.ts",
    "lib/extractor.ts", "lib/pdf-text.ts", "lib/dedup.ts", "lib/session.ts",
    "lib/normalize-text.ts", "lib/market-map.ts", "lib/auto-propose.ts",
    "lib/fde-dimensions.ts", "lib/company-profile.ts", "lib/corpus-import.ts",
    "lib/fde-roster.ts", "lib/report-data.ts", "lib/report-html.ts",
    "lib/report-judgment.ts",
    "lib/holder-table.ts", "lib/query-intake.ts", "lib/company-resolver.ts",
    "--outDir", ".test-build", "--module", "commonjs", "--moduleResolution", "node10",
    "--target", "es2022", "--strict", "--resolveJsonModule", "--esModuleInterop",
  ], { cwd: root, stdio: "pipe" });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "package.json"), '{"type":"commonjs"}');
  return outDir;
}
