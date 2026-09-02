import { getDb, ensureWorkspaceSchema } from "../../../db";
import { parseQuery } from "../../../lib/query-intake";
import { ROSTER } from "../../../lib/fde-roster";
import { latestInvestigations, readInvestigation } from "../../../lib/investigation/repository";
import { startInvestigation } from "../../../lib/investigation/runner";
import type { InvestigationSubjectType } from "../../../lib/investigation/types";

export const dynamic = "force-dynamic";

type CreateBody = { question?: string; entityName?: string; subjectType?: InvestigationSubjectType };
const SUBJECT_TYPES = new Set<InvestigationSubjectType>(["industry", "company", "person"]);

export async function GET(request: Request) {
  ensureWorkspaceSchema();
  const db = getDb();
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) {
    const investigations = latestInvestigations(db);
    const dossiers = investigations.map(item => readInvestigation(db, item.id)).filter(Boolean);
    const stats = dossiers.reduce((total, dossier) => {
      if (!dossier) return total;
      total.claims += dossier.claims.length;
      total.sources += dossier.sources.length;
      total.verifiedSources += dossier.sources.filter(source => source.checkStatus === "verified").length;
      total.relations += dossier.claims.reduce((count, claim) => count + claim.relations.length, 0);
      total.bySubject[dossier.subjectType]++;
      return total;
    }, {
      claims: 0, sources: 0, verifiedSources: 0, relations: 0,
      bySubject: { industry: 0, company: 0, person: 0 },
    });
    return Response.json({ investigations, stats });
  }
  const investigation = readInvestigation(db, id);
  if (!investigation) return Response.json({ error: "调查档案不存在或已被清理" }, { status: 404 });
  return Response.json({ investigation });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as CreateBody;
    const question = String(body.question || "").replace(/\s+/g, " ").trim();
    if (question.length < 2) return Response.json({ error: "请至少写下两个字的线索或问题" }, { status: 400 });
    if (question.length > 800) return Response.json({ error: "问题太长，请先收成一个要核实的线索" }, { status: 400 });
    const parsed = parseQuery(question, ROSTER);
    const entityName = String(body.entityName || parsed.entityName || parsed.extractedName).trim().slice(0, 120);
    if (entityName.length < 2) return Response.json({ error: "还没有识别出调查主体，请补充公司、人物或项目名称" }, { status: 400 });
    const subjectType = SUBJECT_TYPES.has(body.subjectType || "company") ? body.subjectType || "company" : "company";
    const id = startInvestigation({ question, entityName, subjectType });
    return Response.json({ id, entityName, subjectType }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "无法创建调查档案" }, { status: 500 });
  }
}
