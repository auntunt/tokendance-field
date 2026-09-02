import { getDb, ensureWorkspaceSchema } from "../../db";
import { fetchPublicDocument } from "../research/fetch-document";
import { activeResearchProvider, researchWithLLM, searchWeb } from "../research/provider";
import {
  lensesForSubject, type InvestigationDossier, type InvestigationSubjectType,
} from "./types";
import {
  createInvestigation, nextUnverifiedSources, readInvestigation, savePassMemo,
  setInvestigationStatus, setPassStatus, setSourceCheck,
} from "./repository";

const VERIFY_TIMEOUT_MS = 18_000;
// The relay used by a number of compatible providers can queue web-search
// calls behind one another. One active pass gives a slower but materially more
// complete dossier, and every finished pass is still visible immediately.
const MAX_PARALLEL_RESEARCH = 1;

export function startInvestigation(input: { question: string; entityName: string; subjectType?: InvestigationSubjectType }) {
  ensureWorkspaceSchema();
  const db = getDb();
  const id = createInvestigation(db, {
    question: input.question,
    entityName: input.entityName,
    subjectType: input.subjectType || "company",
    provider: activeResearchProvider(),
    lenses: lensesForSubject(input.subjectType || "company"),
  });
  // The job state lives in SQLite before work starts. A browser refresh can
  // therefore resume viewing the dossier instead of losing a one-off result.
  void executeInvestigation(id).catch(error => {
    console.error("[investigation] runner crashed", error);
    try { setInvestigationStatus(getDb(), id, "failed"); } catch { /* Database may be unavailable during shutdown. */ }
  });
  return id;
}

async function runPass(investigation: InvestigationDossier, passId: string) {
  const pass = investigation.passes.find(item => item.id === passId);
  const lens = pass ? lensesForSubject(investigation.subjectType).find(item => item.id === pass.lens) : undefined;
  if (!pass || !lens) return false;
  const db = getDb();
  setPassStatus(db, pass.id, "researching");
  try {
    const memo = await researchWithLLM({
      question: investigation.question,
      entityName: investigation.entityName,
      dimensions: [lens.id],
      lens,
    });
    const fallbackHits = !memo ? await searchWeb(`${investigation.entityName} ${lens.title}`, 4) : [];
    const recoveredMemo = memo || (fallbackHits.length ? {
      summary: `本轮没有生成完整的联网初稿，已先保留 ${fallbackHits.length} 个模型检索到的来源，等待下一轮定向研究补足。`,
      findings: fallbackHits.map(hit => ({
        title: hit.title || `${lens.title} 相关来源`,
        evidence: hit.snippet || "模型检索返回了该来源；原文复核后再提取具体主张。",
        sourceUrl: hit.url,
        sourceTitle: hit.title || new URL(hit.url).hostname,
        dimension: lens.id,
        edges: [],
      })),
      openQuestions: [`${lens.title}尚未形成完整初稿，需要针对具体主体或时间重新追问。`],
      sourceUrls: fallbackHits.map(hit => hit.url),
      provider: activeResearchProvider(),
    } : null);
    if (!recoveredMemo || (!recoveredMemo.summary && !recoveredMemo.findings.length)) {
      setPassStatus(db, pass.id, "failed", "本轮没有返回可引用的研究初稿");
      return false;
    }
    savePassMemo(db, {
      investigationId: investigation.id,
      passId: pass.id,
      summary: recoveredMemo.summary,
      openQuestions: recoveredMemo.openQuestions,
      findings: recoveredMemo.findings,
    });
    // A web-research response is shown immediately as a named preliminary
    // draft. Fetching the original cited pages happens separately, and cannot
    // silently upgrade the draft to verified evidence.
    void verifyCitedSources(investigation.id);
    return true;
  } catch (error) {
    setPassStatus(db, pass.id, "failed", error instanceof Error ? error.message : "本轮研究失败");
    return false;
  }
}

export async function executeInvestigation(id: string) {
  const db = getDb();
  const dossier = readInvestigation(db, id);
  if (!dossier) return;
  const passIds = dossier.passes.filter(pass => pass.status === "queued").map(pass => pass.id);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_PARALLEL_RESEARCH, passIds.length) }, async () => {
    while (cursor < passIds.length) {
      const passId = passIds[cursor++];
      await runPass(dossier, passId);
    }
  });
  await Promise.all(workers);
  const completed = readInvestigation(db, id);
  if (!completed) return;
  const successful = completed.passes.filter(pass => pass.status === "ready").length;
  setInvestigationStatus(db, id, successful === completed.passes.length ? "ready" : successful ? "partial" : "failed");
  void verifyCitedSources(id);
}

/**
 * Citation verification is intentionally best-effort and non-blocking. It
 * verifies the cited page text, while preserving fetch failures as visible
 * evidence gaps rather than deleting the model's preliminary draft.
 */
export async function verifyCitedSources(investigationId: string) {
  const db = getDb();
  const sources = nextUnverifiedSources(db, investigationId, 8);
  await Promise.all(sources.map(async source => {
    setSourceCheck(db, source.id, { status: "fetching" });
    try {
      const document = await fetchPublicDocument(source.url, { timeoutMs: VERIFY_TIMEOUT_MS, maxHtmlBytes: 700_000 });
      setSourceCheck(db, source.id, { status: "verified", contentText: document.text, contentHash: document.contentHash });
    } catch (error) {
      setSourceCheck(db, source.id, { status: "failed", error: error instanceof Error ? error.message : "原文抓取失败" });
    }
  }));
}
