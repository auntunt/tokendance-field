import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, ".test-build");
const lockDir = resolve(root, ".test-build-lock");
const markerPath = resolve(outDir, ".dossier-build");
const sourceFiles = [
  "lib/dossier/types.ts",
  "lib/dossier/id.ts",
  "lib/dossier/coverage.ts",
  "lib/dossier/repository.ts",
  "lib/dossier/m3.ts",
  "lib/dossier/m3-repository.ts",
  "lib/dossier/snapshot.ts",
  "lib/dossier/html.ts",
  "lib/dossier/generate.ts",
  "lib/dossier/source-coverage.ts",
  "lib/dossier/m5-repository.ts",
  "lib/dossier/m6-repository.ts",
  "lib/dossier/industry-weekly-html.ts",
  "lib/collectors/source-text.ts",
  "lib/collectors/job-posting.ts",
  "lib/collectors/procurement.ts",
  "lib/extract/paged-text.ts",
  "lib/extract/annual-report.ts",
  "lib/collectors/annual-report.ts",
  "lib/collectors/corporate-registry.ts",
  "lib/collectors/official-website.ts",
  "lib/collectors/investor-interaction.ts",
  "lib/collectors/search-results.ts",
  "lib/collectors/vendor-case.ts",
  "lib/collectors/peer-case.ts",
  "lib/collectors/industry-weekly.ts",
  "lib/generate/opportunities.ts",
  "lib/generate/entry-prep.ts",
];

function fingerprint() {
  const hash = createHash("sha256");
  for (const file of sourceFiles) hash.update(file).update(readFileSync(resolve(root, file)));
  return hash.digest("hex");
}

function markerMatches(expected) {
  return existsSync(markerPath) && readFileSync(markerPath, "utf8") === expected;
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function buildDossier() {
  const expected = fingerprint();
  if (markerMatches(expected)) return outDir;
  let ownsLock = false;
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    try {
      mkdirSync(lockDir);
      ownsLock = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (markerMatches(expected)) return outDir;
      wait(50);
    }
  }
  if (!ownsLock) throw new Error("等待 dossier TypeScript 编译超过 60 秒");
  try {
    if (markerMatches(expected)) return outDir;
    execFileSync(resolve(root, "node_modules/.bin/tsc"), [
    ...sourceFiles,
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
    writeFileSync(markerPath, expected);
    return outDir;
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}
