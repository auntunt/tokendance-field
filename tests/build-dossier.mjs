import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, ".test-build");

export function buildDossier() {
  execFileSync(resolve(root, "node_modules/.bin/tsc"), [
    "lib/dossier/types.ts",
    "lib/dossier/id.ts",
    "lib/dossier/coverage.ts",
    "lib/dossier/repository.ts",
    "lib/collectors/source-text.ts",
    "lib/collectors/job-posting.ts",
    "lib/collectors/procurement.ts",
    "lib/extract/paged-text.ts",
    "lib/extract/annual-report.ts",
    "lib/collectors/annual-report.ts",
    "--outDir", ".test-build",
    "--module", "commonjs",
    "--moduleResolution", "node10",
    "--target", "es2022",
    "--strict",
    "--esModuleInterop",
    "--skipLibCheck",
  ], { cwd: root, stdio: "pipe" });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "package.json"), '{"type":"commonjs"}');
  return outDir;
}
