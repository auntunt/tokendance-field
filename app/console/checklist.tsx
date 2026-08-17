"use client";

import { Signal, missingGates } from "../../lib/field-core";

/**
 * 「还差什么」清单。它是六道门的唯一人话出口：
 * 只读 missingGates()，不做任何自己的判定，也不提供绕过入口。
 * 点一条 → 跳到对应的编辑区（where 指向 constraint-panel 的分组 id）。
 */
export function GateChecklist({ signal, onJump, compact }: {
  signal: Signal; onJump?: (where: string) => void; compact?: boolean;
}) {
  const todos = missingGates(signal);
  if (!todos.length) {
    return <div className="gate-check done">
      <b>✓ 六项齐了</b>
      <span>这条判断可以进入行动，也可以记录真实结果来校准。</span>
    </div>;
  }
  if (compact) {
    return <div className="gate-check compact">
      <b>还差 {todos.length} 项</b>
      <span>{todos.map(item => item.title).join(" · ")}</span>
    </div>;
  }
  return <div className="gate-check">
    <header><b>还差 {todos.length} 项才能下结论</b><span>缺一项就不放行，这是设计而不是提醒</span></header>
    <ol>
      {todos.map(item => <li key={item.index}>
        <button onClick={() => onJump?.(item.where)} disabled={!onJump}>
          <strong>{item.title}</strong>
          <span>{item.ask}</span>
          {onJump && <em>去补 →</em>}
        </button>
      </li>)}
    </ol>
  </div>;
}
