import { headers } from "next/headers";
import { ensureWorkspaceSchema, getDb } from "../../../db";

export const dynamic = "force-dynamic";

const WORKSPACE_ID = "tokendance-core";
const MAX_RECORDS = 500;

type IncomingSignal = {
  id: string; title: string; evidence: string; source: string; sourceUrl?: string; createdAt: string;
  dimensions: unknown; topics: unknown; candidateScore: number; outcome: string; starred?: boolean; aiAnalysis?: unknown;
  edges?: unknown; origin?: string;
  constraints?: {
    scope?: unknown; epistemicState?: string; falsifier?: string; counterEvidence?: string; sourceType?: string;
    validUntil?: string; probability?: number; signedOff?: boolean; humanSource?: string;
  };
};
type IncomingFeedback = { id: string; signalId: string; topicId: string; verdict: string; note: string; createdAt: string; weightChange: string; executionQuality?: number; predictedProbability?: number; brierScore?: number };
type IncomingSnapshot = { id: string; title: string; createdAt: string; signalCount: number; feedbackCount: number; note: string };
/** 人物名册。只收公开职业事实字段——PII 边界见 lib/ontology.ts。 */
type IncomingPerson = { id: string; name: string; employer?: string; department?: string; title?: string; ourPath?: string; createdAt?: string };
type Row = Record<string, string | number | null>;

function safeJson(value: unknown, fallback: unknown) { try { return typeof value === "string" && value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function clamp(value: unknown, min = 0, max = 100) { return Math.max(min, Math.min(max, Math.round(Number(value) || 0))); }
async function actor() { const requestHeaders = await headers(); return requestHeaders.get("x-forwarded-user") || requestHeaders.get("x-real-ip") || "field-user"; }

export async function GET() {
  try {
    ensureWorkspaceSchema();
    const db = getDb();
    const workspace = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(WORKSPACE_ID) as Row | undefined;
    if (!workspace) return Response.json({ initialized: false, weights: [25, 25, 25, 25], signals: [], feedback: [], snapshots: [], people: [] });
    const signalRows = db.prepare("SELECT * FROM evidence_records WHERE workspace_id = ? ORDER BY rowid DESC").all(WORKSPACE_ID) as Row[];
    const feedbackRows = db.prepare("SELECT * FROM feedback_records WHERE workspace_id = ? ORDER BY rowid DESC").all(WORKSPACE_ID) as Row[];
    const constraintRows = db.prepare("SELECT * FROM judgment_constraints WHERE workspace_id = ?").all(WORKSPACE_ID) as Row[];
    const evaluationRows = db.prepare("SELECT * FROM outcome_evaluations WHERE workspace_id = ?").all(WORKSPACE_ID) as Row[];
    const snapshotRows = db.prepare("SELECT * FROM snapshots WHERE workspace_id = ? ORDER BY rowid DESC").all(WORKSPACE_ID) as Row[];
    const personRows = db.prepare("SELECT * FROM person_records WHERE workspace_id = ? ORDER BY rowid DESC").all(WORKSPACE_ID) as Row[];
    const constraints = new Map(constraintRows.map(row => [String(row.signal_id), row]));
    const evaluations = new Map(evaluationRows.map(row => [String(row.feedback_id), row]));
    return Response.json({
      initialized: true,
      weights: safeJson(workspace.weights_json, [25, 25, 25, 25]),
      signals: signalRows.map(row => {
        const constraint = constraints.get(String(row.id));
        return {
          id: row.id, title: row.title, evidence: row.evidence, source: row.source, sourceUrl: row.source_url, createdAt: row.created_at,
          dimensions: safeJson(row.dimensions_json, []), topics: safeJson(row.topics_json, []), candidateScore: row.candidate_score,
          outcome: row.outcome, starred: Boolean(row.starred), aiAnalysis: safeJson(row.ai_analysis_json, null),
          edges: safeJson(row.edges_json, []), origin: row.origin || "manual",
          constraints: constraint ? {
            scope: safeJson(constraint.scope_json, {}), epistemicState: constraint.epistemic_state, falsifier: constraint.falsifier,
            counterEvidence: constraint.counter_evidence, sourceType: constraint.source_type, validUntil: constraint.valid_until || "",
            probability: constraint.probability, signedOff: Boolean(constraint.signed_off), humanSource: constraint.human_source || "",
          } : null,
        };
      }),
      feedback: feedbackRows.map(row => {
        const evaluation = evaluations.get(String(row.id));
        return {
          id: row.id, signalId: row.signal_id, topicId: row.topic_id, verdict: row.verdict, note: row.note,
          createdAt: row.created_at, weightChange: row.weight_change, executionQuality: evaluation?.execution_quality || 0,
          predictedProbability: evaluation?.predicted_probability || 50, brierScore: evaluation?.brier_score || 0,
        };
      }),
      snapshots: snapshotRows.map(row => ({ id: row.id, title: row.title, createdAt: row.created_at, signalCount: row.signal_count, feedbackCount: row.feedback_count, note: row.note })),
      people: personRows.map(row => ({ id: row.id, name: row.name, employer: row.employer, department: row.department, title: row.title, ourPath: row.our_path, createdAt: row.created_at })),
      updatedAt: workspace.updated_at,
    });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "无法读取团队账本" }, { status: 500 }); }
}

export async function PUT(request: Request) {
  try {
    const payload = await request.json() as { weights?: number[]; signals?: IncomingSignal[]; feedback?: IncomingFeedback[]; snapshots?: IncomingSnapshot[]; people?: IncomingPerson[] };
    if (!Array.isArray(payload.weights) || payload.weights.length !== 4 || !Array.isArray(payload.signals) || !Array.isArray(payload.feedback) || !Array.isArray(payload.snapshots)) return Response.json({ error: "工作区数据格式不正确" }, { status: 400 });
    if (payload.signals.length > MAX_RECORDS || payload.feedback.length > MAX_RECORDS || payload.snapshots.length > MAX_RECORDS) return Response.json({ error: "一次保存的记录数量超过上限" }, { status: 400 });
    ensureWorkspaceSchema();
    const db = getDb(); const now = new Date().toISOString(); const createdBy = await actor();
    const save = db.transaction(() => {
      db.prepare("INSERT INTO workspaces (id,name,weights_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET weights_json=excluded.weights_json, updated_at=excluded.updated_at").run(WORKSPACE_ID, "TokenDance Field", JSON.stringify(payload.weights), now);
      for (const table of ["evidence_records", "feedback_records", "judgment_constraints", "outcome_evaluations", "snapshots"]) db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(WORKSPACE_ID);
      // 人物名册是事实清单，不过闸，所以和情报分开存。整体覆盖写与其他表一致。
      db.prepare("DELETE FROM person_records WHERE workspace_id = ?").run(WORKSPACE_ID);
      const personRow = db.prepare("INSERT INTO person_records (id,workspace_id,name,employer,department,title,our_path,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)");
      for (const item of payload.people || []) {
        if (!item?.id || !String(item.name || "").trim()) continue;
        personRow.run(String(item.id).slice(0, 80), WORKSPACE_ID, String(item.name).slice(0, 120), String(item.employer || "").slice(0, 200), String(item.department || "").slice(0, 200), String(item.title || "").slice(0, 200), String(item.ourPath || "").slice(0, 1000), item.createdAt || now, createdBy);
      }
      const evidence = db.prepare("INSERT INTO evidence_records (id,workspace_id,title,evidence,source,source_url,created_at,dimensions_json,topics_json,candidate_score,outcome,starred,ai_analysis_json,created_by,edges_json,origin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      const constraint = db.prepare("INSERT INTO judgment_constraints (signal_id,workspace_id,scope_json,epistemic_state,falsifier,counter_evidence,source_type,valid_until,probability,signed_off,updated_at,updated_by,human_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
      for (const item of payload.signals || []) {
        evidence.run(item.id, WORKSPACE_ID, item.title.slice(0, 300), item.evidence.slice(0, 6000), item.source.slice(0, 200), item.sourceUrl?.slice(0, 2000) || null, item.createdAt, JSON.stringify(item.dimensions), JSON.stringify(item.topics), clamp(item.candidateScore), item.outcome, item.starred ? 1 : 0, item.aiAnalysis ? JSON.stringify(item.aiAnalysis) : null, createdBy, JSON.stringify(Array.isArray(item.edges) ? item.edges : []), String(item.origin || "manual").slice(0, 40));
        constraint.run(item.id, WORKSPACE_ID, JSON.stringify(item.constraints?.scope || {}), String(item.constraints?.epistemicState || "observation").slice(0, 40), String(item.constraints?.falsifier || "").slice(0, 2000), String(item.constraints?.counterEvidence || "").slice(0, 2000), String(item.constraints?.sourceType || "unknown").slice(0, 40), item.constraints?.validUntil?.slice(0, 40) || null, clamp(item.constraints?.probability || 50), item.constraints?.signedOff ? 1 : 0, now, createdBy, String(item.constraints?.humanSource || "").slice(0, 500) || null);
      }
      const feedback = db.prepare("INSERT INTO feedback_records (id,workspace_id,signal_id,topic_id,verdict,note,created_at,weight_change,created_by) VALUES (?,?,?,?,?,?,?,?,?)");
      const evaluation = db.prepare("INSERT INTO outcome_evaluations (feedback_id,workspace_id,execution_quality,predicted_probability,brier_score,created_at) VALUES (?,?,?,?,?,?)");
      for (const item of payload.feedback || []) {
        feedback.run(item.id, WORKSPACE_ID, item.signalId, item.topicId, item.verdict, item.note.slice(0, 3000), item.createdAt, item.weightChange.slice(0, 300), createdBy);
        evaluation.run(item.id, WORKSPACE_ID, clamp(item.executionQuality), clamp(item.predictedProbability || 50), clamp(item.brierScore, 0, 10000), item.createdAt);
      }
      const snapshot = db.prepare("INSERT INTO snapshots (id,workspace_id,title,created_at,signal_count,feedback_count,note,created_by) VALUES (?,?,?,?,?,?,?,?)");
      for (const item of payload.snapshots || []) snapshot.run(item.id, WORKSPACE_ID, item.title.slice(0, 300), item.createdAt, Math.max(0, Math.round(item.signalCount)), Math.max(0, Math.round(item.feedbackCount)), item.note.slice(0, 1000), createdBy);
    });
    save();
    return Response.json({ ok: true, updatedAt: now });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "无法保存团队账本" }, { status: 500 }); }
}
