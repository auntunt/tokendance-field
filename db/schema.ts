import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  weightsJson: text("weights_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const evidenceRecords = sqliteTable("evidence_records", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  title: text("title").notNull(),
  evidence: text("evidence").notNull(),
  source: text("source").notNull(),
  sourceUrl: text("source_url"),
  createdAt: text("created_at").notNull(),
  dimensionsJson: text("dimensions_json").notNull(),
  topicsJson: text("topics_json").notNull(),
  candidateScore: integer("candidate_score").notNull(),
  outcome: text("outcome").notNull(),
  starred: integer("starred").notNull().default(0),
  aiAnalysisJson: text("ai_analysis_json"),
  createdBy: text("created_by").notNull(),
});

export const feedbackRecords = sqliteTable("feedback_records", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  signalId: text("signal_id").notNull(),
  topicId: text("topic_id").notNull(),
  verdict: text("verdict").notNull(),
  note: text("note").notNull(),
  createdAt: text("created_at").notNull(),
  weightChange: text("weight_change").notNull(),
  createdBy: text("created_by").notNull(),
});

export const judgmentConstraints = sqliteTable("judgment_constraints", {
  signalId: text("signal_id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  scopeJson: text("scope_json").notNull(),
  epistemicState: text("epistemic_state").notNull(),
  falsifier: text("falsifier").notNull(),
  counterEvidence: text("counter_evidence").notNull(),
  sourceType: text("source_type").notNull(),
  validUntil: text("valid_until"),
  probability: integer("probability").notNull(),
  signedOff: integer("signed_off").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
  humanSource: text("human_source"),
});

// 人物测绘：只承载公开职业事实。PII 边界见 lib/ontology.ts。
// 人物本身不是判断，不过闸；关于人物的判断仍然以 evidence_records 的形式走六道门。
export const personRecords = sqliteTable("person_records", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  employer: text("employer").notNull(),
  department: text("department").notNull(),
  title: text("title").notNull(),
  ourPath: text("our_path").notNull(),
  createdAt: text("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});

export const outcomeEvaluations = sqliteTable("outcome_evaluations", {
  feedbackId: text("feedback_id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  executionQuality: integer("execution_quality").notNull(),
  predictedProbability: integer("predicted_probability").notNull(),
  brierScore: integer("brier_score").notNull(),
  createdAt: text("created_at").notNull(),
});

export const snapshots = sqliteTable("snapshots", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  title: text("title").notNull(),
  createdAt: text("created_at").notNull(),
  signalCount: integer("signal_count").notNull(),
  feedbackCount: integer("feedback_count").notNull(),
  note: text("note").notNull(),
  createdBy: text("created_by").notNull(),
});
