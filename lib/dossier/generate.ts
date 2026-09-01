import type { SnapshotChange } from "./snapshot";
import { createDossierRun } from "./snapshot";
import { renderDossierHtml } from "./html";
import type { DossierDatabase } from "./repository";
import { generateEntryPrep } from "../generate/entry-prep";
import { generateOpportunities, persistOpportunities } from "../generate/opportunities";
import { requireCompleteSourceCoverage } from "./source-coverage";

export interface GeneratedDossier {
  html: string;
  runId: string;
  changes: SnapshotChange[];
}

export function generateDossier(
  db: DossierDatabase,
  companyId: string,
  ranAt = new Date().toISOString(),
): GeneratedDossier {
  const opportunities = generateOpportunities(db, companyId);
  persistOpportunities(db, opportunities, companyId);
  requireCompleteSourceCoverage(db, companyId);
  const prep = generateEntryPrep(db, companyId, opportunities);
  const run = createDossierRun(db, companyId, ranAt);
  return {
    html: renderDossierHtml(db, companyId, opportunities, prep, run.changes),
    runId: run.runId,
    changes: run.changes,
  };
}
