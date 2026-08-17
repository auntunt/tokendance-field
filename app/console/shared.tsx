"use client";

export function ViewHeader({ kicker, title, copy, action, onAction }: { kicker: string; title: string; copy: string; action?: string; onAction?: () => void }) {
  return <header className="view-header core-header"><div><small>{kicker}</small><h1>{title}</h1><p>{copy}</p></div>{action && <button onClick={onAction}>{action} ↗</button>}</header>;
}

export function Step({ number, label, value }: { number: string; label: string; value: string }) {
  return <article><small>{number}</small><b>{label}</b><span>{value}</span></article>;
}

export function EmptyField({ ready, onOpen }: { ready: boolean; onOpen: () => void }) {
  return <section className="empty-field">
    <div className="empty-orbit"><i /><i /><i /><b>＋</b></div>
    <h1>{ready ? "还没有材料可判断。" : "正在连接…"}</h1>
    <p>{ready ? "先去「收集」贴一段原文或给一个链接。这里不预置案例，也不替你生成结论。" : "正在读取已有的情报和记录。"}</p>
    {ready && <button className="primary-action" onClick={onOpen}>去收集材料</button>}
  </section>;
}
