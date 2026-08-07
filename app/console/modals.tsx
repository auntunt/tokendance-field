"use client";

import { ModelAnalysis } from "../../lib/field-core";
import { RELATIONS } from "../../lib/ontology";

export type Draft = { title: string; evidence: string; source: string; sourceUrl: string; from: string; to: string; relation: string; direction: "forward" | "mutual" };
export type ModelConfig = { provider: "openai" | "anthropic" | "deepseek" | "compatible"; model: string; endpoint: string; apiKey: string };

export function EvidenceModal({ draft, setDraft, onClose, onSubmit }: { draft: Draft; setDraft: (value: Draft) => void; onClose: () => void; onSubmit: () => void }) {
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="signal-modal" onMouseDown={event => event.stopPropagation()}>
    <div className="modal-kicker">NEW RELATION INTELLIGENCE / RAW FIRST</div>
    <h2>先记录观察到的关系事实</h2>
    <label>情报标题<input autoFocus value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder="写谁和谁发生了什么，不要先写结论" /></label>
    <label>原始依据<textarea value={draft.evidence} onChange={event => setDraft({ ...draft, evidence: event.target.value })} placeholder="哪个主体、什么时间、通过什么方式与谁产生了关联？金额、比例、批次等可复核细节" /></label>
    <div className="modal-two">
      <label>来源<input value={draft.source} onChange={event => setDraft({ ...draft, source: event.target.value })} /></label>
      <label>原始链接（可选）<input value={draft.sourceUrl} onChange={event => setDraft({ ...draft, sourceUrl: event.target.value })} placeholder="https://" /></label>
    </div>
    <div className="modal-two">
      <label>主体 A<input value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} placeholder="关系发起方" /></label>
      <label>主体 B<input value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} placeholder="关系指向方" /></label>
    </div>
    <div className="modal-two">
      <label>关系类型<select value={draft.relation} onChange={event => setDraft({ ...draft, relation: event.target.value })}>{RELATIONS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>方向<select value={draft.direction} onChange={event => setDraft({ ...draft, direction: event.target.value as Draft["direction"] })}><option value="forward">A → B 单向</option><option value="mutual">A ↔ B 双向</option></select></label>
    </div>
    <div className="modal-preview"><span>录入之后</span><b>情报 → 主体边界 → 证伪 → 专家签署</b></div>
    <div className="modal-actions"><button onClick={onClose}>取消</button><button className="primary-action" onClick={onSubmit}>录入情报</button></div>
  </section></div>;
}

export function ModelModal({ model, setModel, onClose }: { model: ModelConfig; setModel: (value: ModelConfig) => void; onClose: () => void }) {
  const isCustom = model.provider === "compatible";
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="signal-modal model-modal" onMouseDown={event => event.stopPropagation()}>
    <div className="modal-kicker">MODEL CONNECTOR / SESSION-ONLY KEY</div>
    <h2>选择负责拷问的模型</h2>
    <label>服务商<select value={model.provider} onChange={event => {
      const provider = event.target.value as ModelConfig["provider"];
      const defaults: Record<ModelConfig["provider"], { model: string; endpoint: string }> = { openai: { model: "gpt-5", endpoint: "" }, anthropic: { model: "claude-sonnet-4-5", endpoint: "" }, deepseek: { model: "deepseek-chat", endpoint: "" }, compatible: { model: "", endpoint: "" } };
      setModel({ ...model, provider, ...defaults[provider] });
    }}><option value="openai">OpenAI · Responses API</option><option value="anthropic">Anthropic · Messages API</option><option value="deepseek">DeepSeek · Chat Completions</option><option value="compatible">自定义 · OpenAI 兼容服务（含 newapi 网关）</option></select></label>
    <div className="modal-two">
      <label>模型名<input value={model.model} onChange={event => setModel({ ...model, model: event.target.value })} placeholder="输入任意已开通模型名" /></label>
      <label>{isCustom ? "完整 Chat Completions 地址" : "自定义地址（可选）"}<input value={model.endpoint} onChange={event => setModel({ ...model, endpoint: event.target.value })} placeholder={isCustom ? "https://.../v1/chat/completions" : "留空使用官方地址"} /></label>
    </div>
    <label>本次会话密钥<input type="password" autoComplete="off" value={model.apiKey} onChange={event => setModel({ ...model, apiKey: event.target.value })} placeholder="不会保存到团队账本或浏览器" /></label>
    <div className="model-security"><b>角色边界</b><span>模型只提出关系解释、适用边界和反证；它无法替专家签署，也无法直接改变判断权重。</span></div>
    <div className="modal-actions"><button onClick={onClose}>完成配置</button></div>
  </section></div>;
}

export function AIReview({ analysis, onAnalyze, analyzing, onAdopt }: { analysis?: ModelAnalysis | null; onAnalyze: () => void; analyzing: boolean; onAdopt: () => void }) {
  if (!analysis) return <section className="ai-review empty">
    <div><small>MODEL AS CRITIC / NEVER THE SIGNER</small><h3>让模型找主体边界、找反例、找证伪条件。</h3><p>模型可以提出草稿，但不能自动通过约束门，也不能替专家签署。</p></div>
    <button className="primary-action" disabled={analyzing} onClick={onAnalyze}>{analyzing ? "正在拷问…" : "运行模型拷问"}</button>
  </section>;
  return <section className="ai-review">
    <header><div><small>MODEL CRITIQUE / {analysis.provider.toUpperCase()} · {analysis.model}</small><h3>{analysis.summary}</h3></div><button onClick={onAnalyze} disabled={analyzing}>{analyzing ? "分析中…" : "重新拷问"}</button></header>
    <div className="ai-columns">
      <div><b>局部解释</b><span>{analysis.epistemic_state || "待判断"}<strong>{analysis.confidence ?? "—"}</strong></span>{Object.entries(analysis.local_context || {}).map(([key, item]) => <span key={key}>{String(item)}</span>)}</div>
      <div><b>证伪建议</b>{(analysis.falsifiers || analysis.questions || []).slice(0, 4).map(item => <span key={item}>{item}</span>)}</div>
      <div><b>反例方向</b>{(analysis.counterevidence || analysis.questions || []).slice(0, 4).map(item => <span key={item}>{item}</span>)}</div>
    </div>
    <footer><span>采纳只会写入可编辑草稿，并自动撤销已有专家签署。</span><button className="primary-action" onClick={onAdopt}>采纳为约束草稿</button></footer>
  </section>;
}
