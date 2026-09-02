import { getDb, ensureWorkspaceSchema } from "../../../../db";
import { latestInvestigations, readInvestigation } from "../../../../lib/investigation/repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  ensureWorkspaceSchema();
  const db = getDb();
  const url = new URL(request.url);
  const recent = latestInvestigations(db, 20);
  const id = url.searchParams.get("id")?.trim() || recent[0]?.id;
  if (!id) return Response.json({ investigations: recent, graph: null });
  const dossier = readInvestigation(db, id);
  if (!dossier) return Response.json({ investigations: recent, graph: null });
  const sourceById = new Map(dossier.sources.map(source => [source.id, source]));
  const relations = dossier.claims.flatMap(claim => claim.relations.map((relation, index) => ({
    id: `${claim.id}-${index}`,
    from: relation.from,
    to: relation.to,
    relation: relation.relation,
    direction: relation.direction,
    quote: relation.quote,
    claimId: claim.id,
    claimTitle: claim.title,
    evidence: claim.evidence,
    sources: claim.sourceIds.map(sourceId => sourceById.get(sourceId)).filter(Boolean),
  })));
  return Response.json({
    investigations: recent,
    graph: {
      id: dossier.id,
      entityName: dossier.entityName,
      question: dossier.question,
      subjectType: dossier.subjectType,
      status: dossier.status,
      relations,
      sourceCount: dossier.sources.length,
      verifiedSourceCount: dossier.sources.filter(source => source.checkStatus === "verified").length,
    },
  });
}
