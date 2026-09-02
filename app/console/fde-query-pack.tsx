"use client";

import { useEffect, useState } from "react";

/**
 * 行业样本池。231 家公司是最初导入的 FDE 行业样本，不再绑定到一次性报告。
 * 点一个样本会建立新的公司调查；主体、范围和来源仍在调查中单独确认。
 */

type Preset = {
  id: string;
  name: string;
  legalName?: string | null;
  ticker?: string | null;
  listing: string;
  city: string;
  sector: string;
  relevance: string;
  watchlist: boolean;
  hasFdeFacts: boolean;
  query: string;
  dimensions: string[];
  updatedAt: string;
  lastSearchedAt?: string | null;
  candidatesCount?: number;
  latestCandidates?: Array<{ title: string; source: string; url?: string }>;
  status?: string;
};

type PresetsResponse = { generatedAt: string; source?: string; scope: string; total: number; returned: number; presets: Preset[] };
type SchedulerStatus = { running: boolean; lastRunAt: string | null; nextRunAt: string | null; lastSummary: string | null; completedBatches: number };

const SCOPES = [
  { id: "focus", label: "重点优先" },
  { id: "watchlist", label: "种子名单" },
  { id: "fde", label: "已有 FDE 记录" },
  { id: "all", label: "全部 231 家" },
] as const;

const LISTING_LABEL: Record<string, string> = {
  us: "美股", "cn-a": "A股", hk: "港股", otc: "新三板", private: "未上市",
};

export function FdeQueryPack({ onPick }: { onPick: (query: string, name: string) => void }) {
  const [scope, setScope] = useState<string>("focus");
  const [data, setData] = useState<PresetsResponse | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  useEffect(() => {
    void fetch(`/api/query/presets?scope=${encodeURIComponent(scope)}&limit=80`).then(async response => {
      const payload = await response.json() as PresetsResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || "查询包读取失败");
      setData(payload);
      setError("");
    }).catch(err => setError(err instanceof Error ? err.message : "查询包读取失败"));
  }, [scope]);

  useEffect(() => {
    void fetch("/api/scheduler/status").then(async response => {
      if (response.ok) setScheduler(await response.json() as SchedulerStatus);
    }).catch(() => setScheduler(null));
  }, []);

  const visible = (data?.presets || []).filter(item => {
    if (!filter.trim()) return true;
    const key = `${item.name} ${item.legalName || ""} ${item.city} ${item.sector}`.toLowerCase();
    return key.includes(filter.trim().toLowerCase());
  });

  return <div className="query-pack">
    <header className="query-pack-head">
      <div>
        <small className="aside-kicker">INDUSTRY SEED POOL · FDE 行业样本</small>
        <h3>从首批样本出发，持续扩展行业情报</h3>
        <p>
          这批数据在 {data?.generatedAt || "2026-08-13"} 进入情报库；它们是行业观察的起点，不是结论。
          选择一家公司后，系统会为它建立独立档案，并将后续来源、主张和关系持续写回看台。
          {scheduler?.running ? " · 调度器正在跑" : scheduler?.lastSummary ? ` · ${scheduler.lastSummary}` : ""}
        </p>
      </div>
      <div className="query-pack-filter">
        <span>⌕</span>
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="筛公司 / 城市 / 行业" aria-label="筛选查询包" />
      </div>
    </header>

    <div className="query-pack-scopes">
      {SCOPES.map(item => <button key={item.id} className={scope === item.id ? "active" : ""} onClick={() => setScope(item.id)}>
        {item.label}
      </button>)}
    </div>

    {error && <div className="query-error">⚠ {error}</div>}
    {!data && !error && <p className="history-empty">正在读取查询包…</p>}
    {data && <>
      <div className="query-pack-meta">
        共 {data.total} 个公司样本 · 显示 {data.returned} 个
        {scope === "fde" ? " · 已有与 FDE / 交付模式相关的初步材料" : ""}
        {scope === "watchlist" ? " · 优先补全核心样本的最新来源" : ""}
      </div>
      <div className="query-pack-grid">
        {visible.map(item => <article key={item.id} className={item.watchlist ? "pack-card watch" : "pack-card"}>
          <header>
            <div>
              <b>{item.name}</b>
              <small>{item.city} · {item.sector} · {LISTING_LABEL[item.listing] || item.listing}</small>
            </div>
            {item.watchlist && <em>重点</em>}
          </header>
          {item.legalName && item.legalName !== item.name && <p className="pack-legal">{item.legalName}</p>}
          <p className="pack-query">“{item.query}”</p>
          <div className="pack-card-foot">
            <span>
              {item.dimensions.join(" / ")}
              {item.hasFdeFacts ? " · 已有 FDE 记录" : ""}
              {item.lastSearchedAt ? ` · 最近查于 ${item.lastSearchedAt.slice(0, 10)}` : " · 尚未自动查询"}
              {typeof item.candidatesCount === "number" ? ` · 累计 ${item.candidatesCount} 条候选` : ""}
            </span>
            <button className="primary-action" onClick={() => onPick(item.query, item.name)}>建公司档案</button>
          </div>
        </article>)}
      </div>
      {!visible.length && <p className="history-empty">没有匹配的公司，换个筛选词试试。</p>}
    </>}
  </div>;
}
