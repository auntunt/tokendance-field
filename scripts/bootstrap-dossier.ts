import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAnnualReport } from "../lib/collectors/annual-report";
import { collectCorporateRegistry } from "../lib/collectors/corporate-registry";
import { collectInvestorInteraction } from "../lib/collectors/investor-interaction";
import { collectOfficialWebsite } from "../lib/collectors/official-website";
import { collectPeerCase } from "../lib/collectors/peer-case";
import { generateDossier } from "../lib/dossier/generate";
import { mergeCompanyPeopleEvents } from "../lib/dossier/m3";
import { ingestCompanyPeopleEvents } from "../lib/dossier/m3-repository";
import { ingestRelationshipCollection } from "../lib/dossier/m5-repository";
import { ingestAnnualReportCollection, initializeDossierSchema } from "../lib/dossier/repository";
import { findMissingSourceFields } from "../lib/dossier/source-coverage";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const companyId = "002410.SZ";
const companyName = "广联达科技股份有限公司";
const industryId = "construction-digitalization";

function fixture(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function outputPath(): { path: string; force: boolean } {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const requested = args.find(arg => arg !== "--force") ?? "data/fde-dossier.sqlite";
  const path = resolve(requested);
  if (![".sqlite", ".sqlite3", ".db"].includes(extname(path))) {
    throw new Error("初始化文件必须使用 .sqlite、.sqlite3 或 .db 扩展名");
  }
  if (existsSync(path) && !force) {
    throw new Error(`目标已存在，不会覆盖：${path}；确认重建时显式传 --force`);
  }
  return { path, force };
}

function seed(db: Database.Database): void {
  initializeDossierSchema(db);
  ingestAnnualReportCollection(db, collectAnnualReport({
    companyId,
    companyName,
    industryId,
    industryName: "建筑产业数字化",
    url: "http://static.cninfo.com.cn/finalpage/2026-03-24/1225024978.PDF",
    content: fixture("tests/fixtures/annual-report/glodon-2025-pages.txt"),
    reportYear: 2025,
    publishedAt: "2026-03-24",
  }));

  ingestCompanyPeopleEvents(db, mergeCompanyPeopleEvents([
    collectCorporateRegistry({
      companyId,
      companyName,
      url: "http://static.cninfo.com.cn/finalpage/2026-03-24/1225024978.PDF#page=6",
      content: fixture("tests/fixtures/corporate-registry/glodon.csv"),
      publishedAt: "2026-03-24",
    }),
    collectOfficialWebsite({
      companyId,
      companyName,
      url: "https://www.glodon.com/news/1511.html",
      content: fixture("tests/fixtures/official-website/glodon-2025-ciftis.txt"),
      listing: "深交所 002410",
    }),
    collectInvestorInteraction({
      companyId,
      companyName,
      url: "https://static.cninfo.com.cn/finalpage/2025-08-26/1224565561.PDF#page=168",
      content: fixture("tests/fixtures/investor-interaction/glodon-2025-h1.txt"),
      publishedAt: "2025-08-26",
    }),
  ]));

  for (const [peerName, url, path] of [
    ["Autodesk", "https://construction.autodesk.com/workflows/artificial-intelligence-construction/", "tests/fixtures/peer-case/autodesk-forma-ai.txt"],
    ["Procore", "https://support.procore.com/products/online/user-guide/project-level/assist", "tests/fixtures/peer-case/procore-assist.txt"],
  ] as const) {
    const peer = collectPeerCase({
      companyId,
      companyName,
      peerName,
      url,
      content: fixture(path),
      publishedAt: "2026-09-01",
    });
    ingestRelationshipCollection(db, peer.relationship);
  }

  generateDossier(db, companyId, "2026-09-01T01:00:00.000Z");
  const missing = findMissingSourceFields(db, companyId);
  if (missing.length > 0) throw new Error(`验收种子存在 ${missing.length} 个无来源字段`);
}

function main(): void {
  const output = outputPath();
  mkdirSync(dirname(output.path), { recursive: true });
  const temporary = `${output.path}.tmp-${process.pid}`;
  if (existsSync(temporary)) unlinkSync(temporary);
  const db = new Database(temporary);
  try {
    seed(db);
    const summary = {
      company: db.prepare("SELECT count(*) AS count FROM company").get() as { count: number },
      industry: db.prepare("SELECT count(*) AS count FROM industry").get() as { count: number },
      sources: db.prepare("SELECT count(*) AS count FROM source").get() as { count: number },
      opportunities: db.prepare("SELECT count(*) AS count FROM opportunity").get() as { count: number },
      dossierRuns: db.prepare("SELECT count(*) AS count FROM dossier_run").get() as { count: number },
    };
    db.close();
    if (output.force && existsSync(output.path)) unlinkSync(output.path);
    renameSync(temporary, output.path);
    const fingerprint = createHash("sha256").update(readFileSync(output.path)).digest("hex");
    console.log(JSON.stringify({
      ok: true,
      path: output.path,
      sha256: fingerprint,
      rows: Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, value.count])),
    }));
  } catch (error) {
    if (db.open) db.close();
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

main();
