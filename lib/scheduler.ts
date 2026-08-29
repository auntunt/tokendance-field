// FDE 查询包定时调度器。运行在 Next.js Node 进程内，不依赖外部 cron。
//
// 每轮做的事：
//   1. 从 SQLite 的 fde_presets 挑「最久没查」的 N 家（重点公司优先）；
//   2. 通过内部 /api/query 启动后台查询任务并轮询；
//   3. 在写入前执行来源、时效、关系去重和图谱容量预演；
//   4. 只把少量高质量新关系并入工作区，历史与过期数据均保留；
//   5. 对第一条新候选调用 /api/enrich 自动起草；
//   6. 把本轮结果写回 fde_presets——查询包因此自动更新。
//
// 查询速度仍受 Bing 20 秒间隔约束，所以每轮默认 3 家，避免一次跑太久。

import { ensureWorkspaceSchema, getDb } from "../db";
import { ensureFdePresets, nextPresetBatch, recordPresetSearch } from "./fde-presets";
import {
  DEFAULT_SCHEDULER_POLICY,
  selectSchedulerCandidates,
  type SchedulerCandidate,
  type SchedulerSignalLike,
} from "./scheduler-policy";
import { latestObservedDate } from "./signal-date";

type Candidate = SchedulerCandidate;

type SchedulerState = {
  started: boolean;
  running: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastSummary: string | null;
  lastError: string | null;
  completedBatches: number;
};

declare global {
  var fdeSchedulerState: SchedulerState | undefined;
  var fdeSchedulerTimer: ReturnType<typeof setInterval> | undefined;
}

const state: SchedulerState = globalThis.fdeSchedulerState ?? (globalThis.fdeSchedulerState = {
  started: false,
  running: false,
  lastRunAt: null,
  nextRunAt: null,
  lastSummary: null,
  lastError: null,
  completedBatches: 0,
});

export function schedulerStatus() {
  return { ...state };
}

function baseUrl() {
  const port = process.env.PORT || "8800";
  return `http://127.0.0.1:${port}`;
}

function authHeader() {
  const user = process.env.FIELD_ACCESS_USER;
  const password = process.env.FIELD_ACCESS_PASSWORD;
  if (!user || !password) return undefined;
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function internalApi(path: string, options: RequestInit = {}) {
  const auth = authHeader();
  if (!auth) throw new Error("调度器缺少 FIELD_ACCESS_USER / FIELD_ACCESS_PASSWORD");
  const resp = await fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: auth, ...(options.headers || {}) },
  });
  const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
  if (!resp.ok) throw new Error(`${path} ${resp.status}: ${String(data.error || "请求失败").slice(0, 200)}`);
  return data;
}

function iso(date: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function validUntilFor(relation: string, text: string): string {
  const days = { equity: 365, supply: 180, personnel: 180, license: 365, compete: 90 }[relation] || 180;
  const anchor = latestObservedDate(text) || new Date();
  const due = new Date(anchor.getTime() + days * 86400000);
  const floor = new Date(Date.now() + 30 * 86400000);
  return iso(due > floor ? due : floor);
}

function signalFromCandidate(preset: { id: string; name: string }, candidate: Candidate, index: number, today: string) {
  const edges = (candidate.edges || []).map(edge => ({
    from: String(edge.from || "").trim().slice(0, 120),
    to: String(edge.to || "").trim().slice(0, 120),
    relation: String(edge.relation || candidate.suggestedRelation || "equity"),
    direction: String(edge.direction || "forward") === "mutual" ? "mutual" : "forward",
    quote: String(edge.quote || "").slice(0, 600),
  })).filter(edge => edge.from && edge.to);
  const relation = edges[0]?.relation || "equity";
  const sourceGrade = candidate._grade === "statutory" || candidate._grade === "independent" ? "independent" : "related";
  const entityScope = [...new Set(edges.flatMap(edge => [edge.from, edge.to]))].join(" / ");
  return {
    id: `sched-${preset.id}-${Date.now()}-${index}`,
    title: String(candidate.title || `${preset.name} 的新进展`).slice(0, 300),
    evidence: String(candidate.evidence || "").slice(0, 6000),
    source: String(candidate.source || `调度查询 ${preset.name}`).slice(0, 200),
    sourceUrl: candidate.sourceUrl ? String(candidate.sourceUrl).slice(0, 2000) : undefined,
    createdAt: new Date().toISOString(),
    dimensions: [],
    topics: [],
    candidateScore: 0,
    outcome: "watching",
    edges,
    origin: `scheduler-${today}`,
    constraints: {
      scope: { entityScope, marketRegion: "", dataBasis: "以来源原文口径为准", timeWindow: latestObservedDate(String(candidate.evidence || "")) ? `材料时点 ${iso(latestObservedDate(String(candidate.evidence || ""))!)} 起` : "", ourAccess: "" },
      epistemicState: "observation",
      falsifier: "",
      counterEvidence: "",
      sourceType: sourceGrade,
      validUntil: validUntilFor(relation, `${candidate.title} ${candidate.evidence}`),
      probability: 50,
      signedOff: false,
      humanSource: "",
    },
  };
}

export async function runSchedulerBatch(limit = 3): Promise<Record<string, unknown>> {
  if (state.running) return { started: false, reason: "已有批次在跑" };
  state.running = true;
  state.lastError = null;
  const startedAt = new Date();
  const summary = { presets: 0, searched: 0, candidates: 0, qualified: 0, added: 0, addedEdges: 0, rejected: 0, rejectionReasons: {} as Record<string, number>, enriched: 0, failed: 0 };
  const maxAddedSignals = envLimit("FDE_SCHEDULER_MAX_ADDED_SIGNALS", DEFAULT_SCHEDULER_POLICY.maxAddedSignals);
  const maxAddedEdges = envLimit("FDE_SCHEDULER_MAX_ADDED_EDGES", DEFAULT_SCHEDULER_POLICY.maxAddedEdges);
  const maxGraphEdges = envLimit("FDE_SCHEDULER_MAX_GRAPH_EDGES", DEFAULT_SCHEDULER_POLICY.maxGraphEdges);
  try {
    ensureWorkspaceSchema();
    const db = getDb();
    ensureFdePresets(db);
    const presets = nextPresetBatch(db, Math.max(1, Math.min(6, limit)));

    for (const preset of presets) {
      try {
        // 查询词从简单到具体：裸公司名最稳，再补投资和客户/中标两条。
        // 不再用「FDE 前置部署 交付」这种低共现长词——它最容易触发搜索引擎降级。
        const year = new Date().getFullYear();
        const searchQueries = [
          preset.name,
          `${preset.name} ${year} 投资 收购 战略合作`,
          `${preset.name} ${year} 任命 竞争 授权 客户`,
        ];
        const started = await internalApi("/api/query", {
          method: "POST",
          body: JSON.stringify({ fragment: searchQueries[0], confirmed: true, entityName: preset.name, dimensions: ["fde", "business", "funding"], searchQueries }),
        }) as { phase?: string; jobId?: string; error?: string };
        if (started.phase !== "started" || !started.jobId) throw new Error(String(started.error || "查询任务未创建"));

        const jobId = started.jobId;
        let job: Record<string, unknown> = {};
        const deadline = Date.now() + 12 * 60_000;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          job = await internalApi(`/api/query/jobs?id=${encodeURIComponent(jobId)}`) as Record<string, unknown>;
          if (job.status !== "running") break;
        }
        if (job.status === "error") throw new Error(String(job.error || "查询任务失败"));
        const result = (job.result || {}) as { candidates?: Candidate[]; degradedQueries?: string[] };
        const candidates = Array.isArray(result.candidates) ? result.candidates : [];
        summary.searched++;
        summary.candidates += candidates.length;

        // 合并前按来源、日期、关系与容量做完整预演。历史数据保留，只在展示层降序。
        const workspace = await internalApi("/api/workspace") as { weights?: number[]; signals?: unknown[]; feedback?: unknown[]; snapshots?: unknown[]; people?: unknown[] };
        const rawSignals = Array.isArray(workspace.signals) ? workspace.signals as Array<SchedulerSignalLike & { source?: string }> : [];
        const signals = rawSignals;
        const keys = new Set(signals.map(s => `${s.title}||${s.source}`));
        const today = new Date().toISOString().slice(0, 10);
        const selection = selectSchedulerCandidates(candidates, signals, {
          maxAddedSignals: Math.max(0, maxAddedSignals - summary.added),
          maxAddedEdges: Math.max(0, maxAddedEdges - summary.addedEdges),
          maxGraphEdges,
        });
        const rejected = Object.values(selection.rejected).reduce((total, count) => total + count, 0);
        summary.rejected += rejected;
        for (const [reason, count] of Object.entries(selection.rejected)) {
          summary.rejectionReasons[reason] = (summary.rejectionReasons[reason] || 0) + count;
        }
        summary.qualified += selection.accepted.length;
        const fresh = selection.accepted.map((c, index) => signalFromCandidate(preset, c, index, today))
          .filter(s => !keys.has(`${s.title}||${s.source}`));
        const merged = [...signals, ...fresh];
        const payload = {
          weights: Array.isArray(workspace.weights) ? workspace.weights : [25, 25, 25, 25],
          signals: merged,
          feedback: Array.isArray(workspace.feedback) ? workspace.feedback : [],
          snapshots: Array.isArray(workspace.snapshots) ? workspace.snapshots : [],
          people: Array.isArray(workspace.people) ? workspace.people : [],
        };
        if (fresh.length) {
          await internalApi("/api/workspace", { method: "PUT", body: JSON.stringify(payload) });
        }

        if (fresh.length) {
          // 第一条新候选自动起草，其余可在判断页一键补全。
          const enriched = await internalApi("/api/enrich", {
            method: "POST",
            body: JSON.stringify({ signal: fresh[0], mode: "propose" }),
          }) as { constraints?: Record<string, unknown> };
          if (enriched.constraints) {
            const target = fresh[0] as { constraints?: Record<string, unknown> };
            target.constraints = { ...target.constraints, ...enriched.constraints, signedOff: false };
            await internalApi("/api/workspace", { method: "PUT", body: JSON.stringify({ ...payload, signals: [...signals, ...fresh] }) });
            summary.enriched++;
          }
          summary.added += fresh.length;
          summary.addedEdges += fresh.reduce((total, signal) => total + signal.edges.length, 0);
        }

        const latest = candidates.slice(0, 3).map(c => ({ title: String(c.title || "").slice(0, 120), source: String(c.source || "").slice(0, 80), url: c.sourceUrl ? String(c.sourceUrl).slice(0, 300) : undefined }));
        recordPresetSearch(db, preset.id, candidates.length, latest, candidates.length ? "ok" : (result.degradedQueries?.length ? "degraded" : "empty"));
        summary.presets++;
      } catch (error) {
        summary.failed++;
        console.error("[scheduler] 公司查询失败：", preset.name, error instanceof Error ? error.message : error);
      }
    }

    state.lastSummary = `本批 ${summary.presets} 家：候选 ${summary.candidates} 条，质量门通过 ${summary.qualified} 条，新入库 ${summary.added} 条/${summary.addedEdges} 关系，过滤 ${summary.rejected} 条，失败 ${summary.failed} 家`;
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : "调度器失败";
    console.error("[scheduler]", error);
  } finally {
    state.running = false;
    state.lastRunAt = startedAt.toISOString();
    state.completedBatches++;
  }
  return { started: true, ...summary, elapsedSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000), summary: state.lastSummary };
}

function envLimit(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function startScheduler(intervalHours = 6, initialDelayMs = 90_000) {
  if (state.started) return;
  if (process.env.FDE_SCHEDULER_ENABLED === "false") return;
  if (!process.env.FIELD_ACCESS_USER || !process.env.FIELD_ACCESS_PASSWORD) return;
  state.started = true;
  state.nextRunAt = new Date(Date.now() + initialDelayMs).toISOString();
  const run = async () => {
    if (state.running) return;
    try { await runSchedulerBatch(3); } catch (error) { console.error("[scheduler]", error); }
    state.nextRunAt = new Date(Date.now() + intervalHours * 3600_000).toISOString();
  };
  setTimeout(run, initialDelayMs);
  globalThis.fdeSchedulerTimer = setInterval(() => {
    state.nextRunAt = new Date(Date.now() + intervalHours * 3600_000).toISOString();
    void run();
  }, intervalHours * 3600_000);
}
