"use client";

import { Constraints, EpistemicState, Signal, SourceType, gateState, isPlaceholder } from "../../lib/field-core";
import { LocalScope, SCOPE_FIELDS } from "../../lib/ontology";
import { SOURCE_HINT_TEXT, sourceHint } from "../../lib/auto-propose";
import { GateChecklist } from "./checklist";

/** 四个分组对应 GATE_TODOS 的 where。范围与性质合在一组：它们都在问"这话说的是什么范围内的什么"。 */
type Group = "范围" | "反面" | "来源" | "签字";
const GROUPS: Array<{ id: Group; title: string; hint: string }> = [
  { id: "范围", title: "这条在什么范围内成立", hint: "五个问题都要有答案，答「没有」也算答案" },
  { id: "反面", title: "什么情况下它不成立", hint: "找得到反面证据，判断才算经得起打" },
  { id: "来源", title: "谁说的，什么时候过期", hint: "来源强弱决定这条能撑多远" },
  { id: "签字", title: "给个概率，然后签字", hint: "前面齐了才能签。改任何一项自动撤签" },
];

const STATES: Array<{ id: EpistemicState; label: string; hint: string }> = [
  { id: "observation", label: "我看到的", hint: "材料里直接写着" },
  { id: "interpretation", label: "我推出来的", hint: "材料没写，但能推" },
  { id: "hypothesis", label: "我猜的", hint: "还需要去核" },
  { id: "action", label: "要采取的行动", hint: "已经是主张了" },
];

/** 展开状态由父层持有（signal-console 的 openGroup）：清单点「去补」要能直接展开对应分组，
 *  自己拿 state 就得靠 effect 同步 prop，那是 React 明确劝退的写法。 */
export function ConstraintPanel({ signal, onChange, open, setOpen }: {
  signal: Signal; onChange: (value: Constraints) => void;
  open: string; setOpen: (value: string) => void;
}) {
  const value = signal.constraints;
  const gate = gateState(signal);

  // 任何一次约束编辑都撤销专家签署。这是代码级硬约束，不是提示语。
  const set = (patch: Partial<Constraints>) => onChange({ ...value, signedOff: false, ...patch });
  const setScope = (key: keyof LocalScope, next: string) =>
    onChange({ ...value, signedOff: false, scope: { ...value.scope, [key]: next } });

  // 这里的判据必须和门 2 用同一个 isPlaceholder：否则填了「未知」时
  // 头部显示 5/5 而门 2 仍然拒绝，人会以为是程序坏了。
  const filled: Record<Group, string> = {
    范围: `${SCOPE_FIELDS.filter(f => !isPlaceholder(value.scope[f.key])).length}/5`,
    反面: gate.states[3] ? "已写" : "未写",
    来源: gate.states[4] ? "已标" : "未标",
    签字: value.signedOff ? "已签" : "未签",
  };

  return <section className="constraint-system">
    <GateChecklist signal={signal} onJump={setOpen} />
    <div className="constraint-fold">
      {GROUPS.map(group => {
        const active = open === group.id;
        return <article key={group.id} className={active ? "open" : ""}>
          <button className="fold-head" onClick={() => setOpen(active ? "" : group.id)}>
            <b>{group.title}</b><span>{group.hint}</span><em>{filled[group.id]}</em><i>{active ? "▾" : "▸"}</i>
          </button>
          {active && <div className="fold-body">
            {group.id === "范围" && <>
              {/* 「未知」这类占位词按没填算（和门 2 同一判据），得当场说清楚，
                  否则人填了字却看到「还差」，会以为是 bug 而不是规则。 */}
              <div className="scope-inputs">{SCOPE_FIELDS.map(field => {
                const raw = value.scope[field.key] || "";
                const placeholderOnly = raw.trim().length > 0 && isPlaceholder(raw);
                return <label key={field.key} className={placeholderOnly ? "scope-void" : ""}>{field.label}
                  <input value={raw} onChange={e => setScope(field.key, e.target.value)} placeholder={field.placeholder} />
                  {placeholderOnly && <small>「{raw.trim()}」等于没填。查不到就写查过哪儿、没有什么；确实没有就写「没有」。</small>}
                </label>;
              })}</div>
              <div className="state-switch">{STATES.map(state => <button key={state.id}
                className={value.epistemicState === state.id ? "active" : ""}
                onClick={() => set({ epistemicState: state.id })}>{state.label}<small>{state.hint}</small></button>)}</div>
            </>}
            {group.id === "反面" && <>
              <label>什么情况下这条不成立
                <textarea value={value.falsifier} onChange={e => set({ falsifier: e.target.value })}
                  placeholder="出现什么公开事实，这条判断必须被推翻？" /></label>
              <label>目前最强的反面证据
                <textarea value={value.counterEvidence} onChange={e => set({ counterEvidence: e.target.value })}
                  placeholder="找不到也要写明为什么找不到——找过哪里、没有什么。" /></label>
            </>}
            {group.id === "来源" && <>
              <label>谁说的
                <select value={value.sourceType} onChange={e => set({ sourceType: e.target.value as SourceType })}>
                  <option value="unknown">还没判断</option>
                  <option value="independent">独立第三方（发布方不是当事人）</option>
                  <option value="related">当事人自己发的 / 转述</option>
                  <option value="internal">我们自己打听到的</option>
                </select></label>
              {/* 只提示，不代填。independent 不止过门 5，市场版图还按它筛可信来源，
                  所以这一项必须由人点——机器看得出域名，看不出这个渠道可不可信。 */}
              {value.sourceType !== "internal" &&
                <p className="source-note">{SOURCE_HINT_TEXT[sourceHint({ title: signal.title, evidence: signal.evidence, source: signal.source, sourceUrl: signal.sourceUrl })]}</p>}
              {value.sourceType === "internal" && <>
                <label>谁在什么场合说的
                  <input value={value.humanSource || ""} onChange={e => set({ humanSource: e.target.value })}
                    placeholder="客户方采购经理在 7/20 复盘会上口头提及" /></label>
                <p className="source-note">只记职务与场合，不记私生活。亲耳听到不给豁免——单一人际来源没有第三方可核查渠道，天然是弱来源，它提示方向而不给结论。</p>
              </>}
              <label>什么时候过期
                <input type="date" value={value.validUntil} onChange={e => set({ validUntil: e.target.value })} /></label>
            </>}
            {group.id === "签字" && <>
              <label className="probability-control"><span>你认为它成立的概率</span><b>{value.probability}%</b>
                <input type="range" min="5" max="95" step="5" value={value.probability}
                  onChange={e => set({ probability: Number(e.target.value) })} /></label>
              <p>「70%」意味着：同样的公司范围、口径和时间窗口下，十次里约七次会被后来的事实支持。</p>
              <button className={value.signedOff ? "signed" : "primary-action"}
                disabled={!gate.states.slice(0, 5).every(Boolean)}
                onClick={() => onChange({ ...value, signedOff: !value.signedOff })}>
                {value.signedOff ? "✓ 已签字，点此撤销" : gate.states.slice(0, 5).every(Boolean) ? "签字确认" : "前五项没齐，还不能签"}
              </button>
            </>}
          </div>}
        </article>;
      })}
    </div>
  </section>;
}
