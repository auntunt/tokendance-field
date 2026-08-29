"use client";

import { useEffect, useState } from "react";

type Provider = {
  id: "xai" | "openai" | "anthropic" | "bing";
  label: string;
  configured: boolean;
  active: boolean;
  model?: string;
  mode: "hosted-search" | "html-fallback";
};

type Overview = {
  providers: Provider[];
  stats: { runs: number; sources: number; claims: number; corroborated: number; linkedQueries: number };
  recentSources: Array<{ id: string; url: string; domain: string; title: string; grade: string; last_seen_at: string; seen_count: number }>;
  links: Array<{
    id: string; from_fragment: string; to_fragment: string; strength: number;
    shared_sources: number; shared_claims: number; shared_dimensions_json: string;
  }>;
};

const EMPTY: Overview = {
  providers: [],
  stats: { runs: 0, sources: 0, claims: 0, corroborated: 0, linkedQueries: 0 },
  recentSources: [],
  links: [],
};

function providerDetail(provider?: Provider) {
  if (!provider) return "正在检查检索通道";
  if (provider.id === "bing") return "网页检索回退 · 应用自行抓取原文";
  return `${provider.model || provider.label} · 托管联网搜索`;
}

export function ResearchOverview({ signalCount, edgeCount }: { signalCount: number; edgeCount: number }) {
  const [data, setData] = useState<Overview>(EMPTY);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = () => { void fetch("/api/research", { signal: controller.signal }).then(async response => {
        const result = await response.json() as Overview;
        if (response.ok) setData(result);
      }).catch(error => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setReady(true);
      }).finally(() => { if (!controller.signal.aborted) setReady(true); }); };
    load();
    window.addEventListener("field:research-updated", load);
    return () => { controller.abort(); window.removeEventListener("field:research-updated", load); };
  }, [signalCount]);

  const active = data.providers.find(provider => provider.active);
  const latestLink = data.links[0];
  const latestSource = data.recentSources[0];

  return <section className="research-overview" aria-labelledby="research-title">
    <div className="research-hero-copy">
      <div className="research-eyebrow">
        <span className={ready ? "live" : ""}><i />{ready ? "RESEARCH MEMORY ONLINE" : "CONNECTING"}</span>
        <em>来源可追溯 · 结论可证伪</em>
      </div>
      <h1 id="research-title">把一句线索，<br /><span>变成证据网络。</span></h1>
      <p>联网搜索只负责找到入口。原文抓取、来源分级、同稿去重、跨来源印证与历史查询关联，都由本地证据层完成。</p>
      <div className="provider-lockup">
        <span className={`provider-mark ${active?.id || "pending"}`}>{active?.id === "xai" ? "xAI" : active?.id === "openai" ? "OA" : active?.id === "anthropic" ? "AN" : "WEB"}</span>
        <div><small>当前检索通道</small><b>{active?.label || "检测中"}</b><em>{providerDetail(active)}</em></div>
      </div>
    </div>

    <div className="research-hero-data">
      <div className="research-stat-grid">
        <article className="primary"><small>已存来源</small><strong>{data.stats.sources}</strong><span>链接正文与内容指纹</span></article>
        <article><small>多源印证</small><strong>{data.stats.corroborated}</strong><span>不同域名 + 不同原文</span></article>
        <article><small>查询关系</small><strong>{data.stats.linkedQueries}</strong><span>实体 / 维度 / 来源复用</span></article>
        <article><small>事实网络</small><strong>{edgeCount}</strong><span>{signalCount} 条候选情报</span></article>
      </div>
      <div className="evidence-route" aria-label="证据处理流程">
        <span><i>01</i><b>检索</b><em>模型或网页</em></span>
        <span><i>02</i><b>抓原文</b><em>安全读取链接</em></span>
        <span><i>03</i><b>交叉验证</b><em>同稿不算第二源</em></span>
        <span><i>04</i><b>建立联系</b><em>复用历史查询</em></span>
      </div>
      <div className="research-live-note">
        <small>{latestLink ? "最近建立的查询联系" : latestSource ? "最近写入的来源" : "研究记忆"}</small>
        {latestLink ? <>
          <b>{latestLink.from_fragment} ↔ {latestLink.to_fragment}</b>
          <span>关联强度 {latestLink.strength}% · 共用 {latestLink.shared_sources} 个来源 / {latestLink.shared_claims} 个主张</span>
        </> : latestSource ? <>
          <b>{latestSource.title || latestSource.domain}</b>
          <span>{latestSource.domain} · 已遇见 {latestSource.seen_count} 次</span>
        </> : <>
          <b>第一次查询后开始积累</b>
          <span>相同主体、维度、来源或事实主张会自动连起来。</span>
        </>}
      </div>
    </div>
  </section>;
}
