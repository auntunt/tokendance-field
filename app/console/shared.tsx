"use client";

export function ViewHeader({ kicker, title, copy, action, onAction }: { kicker: string; title: string; copy: string; action?: string; onAction?: () => void }) {
  return <header className="view-header core-header"><div><small>{kicker}</small><h1>{title}</h1><p>{copy}</p></div>{action && <button onClick={onAction}>{action} ↗</button>}</header>;
}

export function Step({ number, label, value }: { number: string; label: string; value: string }) {
  return <article><small>{number}</small><b>{label}</b><span>{value}</span></article>;
}

export function EmptyField({ ready, onOpen }: { ready: boolean; onOpen: () => void }) {
  return <section className="empty-field">
    <small>{ready ? "EMPTY RELATION MODEL" : "CONNECTING RELATION MODEL"}</small>
    <div className="empty-orbit"><i /><i /><i /><b>＋</b></div>
    <h1>{ready ? "从一条可核查的企业关系开始。" : "正在连接团队账本。"}</h1>
    <p>{ready ? "系统不预置案例，也不替你生成结论。先录入观察到的关系事实，再补齐主体范围、口径、证伪条件与反例。" : "正在读取团队共享的情报、判断与校准记录。"}</p>
    {ready && <button className="primary-action" onClick={onOpen}>录入首条关系情报</button>}
  </section>;
}
