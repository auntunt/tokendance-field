"use client";

import { useMemo, useState } from "react";
import { Signal, gateState } from "../../lib/field-core";
import { PERSON_FIELDS, PersonRole, emptyPersonRole } from "../../lib/ontology";
import { PersonNode, entryPointsFor, orgsOfPerson } from "../../lib/people";
import { ViewHeader } from "./shared";

/**
 * 人物测绘视图。回答销售的一个具体问题：这家客户我该找谁、从哪条线切入。
 *
 * 三件事这个视图刻意不做：
 * 一、不给人物打可信度分。排序分只回答「先看谁」，任何数字都不是许可。
 * 二、不承载私生活。字段来自 PERSON_FIELDS 白名单，见 lib/ontology.ts 的 PII 边界。
 * 三、不替判断过闸。切入建议要成立，得有一条走完六道门的判断支撑它。
 */
export function PeopleView({ people, signals, onAdd, onRemove, onOpenSignal }: {
  people: PersonNode[];
  signals: Signal[];
  onAdd: (role: PersonRole) => void;
  onRemove: (id: string) => void;
  onOpenSignal: (signal: Signal) => void;
}) {
  const [employer, setEmployer] = useState("");
  const [draft, setDraft] = useState<PersonRole>(emptyPersonRole());
  const [expanded, setExpanded] = useState("");

  const employers = useMemo(() => [...new Set(people.map(person => person.employer.trim()).filter(Boolean))].sort(), [people]);
  const ranked = useMemo(() => entryPointsFor(employer, people, signals), [employer, people, signals]);

  function submit() {
    if (!draft.name.trim() || !draft.employer.trim()) return;
    onAdd({ ...draft, name: draft.name.trim(), employer: draft.employer.trim() });
    setDraft(emptyPersonRole());
  }

  return <>
    <ViewHeader kicker="PEOPLE MAPPING" title="找对人，比找对话术更早一步" copy="人物档案是事实清单，不过闸；关于「谁能拍板、从哪条线更短」的判断仍然要走完六道门。这里只记公开职业事实与我方正当通路。" />

    <section className="people-intake">
      <header><small>ROSTER / 公开职业事实</small><h3>补一个人</h3></header>
      <div className="people-fields">{PERSON_FIELDS.map(field => <label key={field.key}>{field.label}
        <input value={draft[field.key]} onChange={event => setDraft({ ...draft, [field.key]: event.target.value })} placeholder={field.placeholder} />
      </label>)}</div>
      <div className="people-actions">
        <p>只填职务与场合类信息。私生活、住址、私人联系方式不属于这里——决定能不能进门的是职权与汇报线。</p>
        <button className="primary-action" disabled={!draft.name.trim() || !draft.employer.trim()} onClick={submit}>加入名册</button>
      </div>
    </section>

    {people.length > 0 && <section className="people-filter">
      <label>目标主体<select value={employer} onChange={event => setEmployer(event.target.value)}>
        <option value="">全部主体</option>
        {employers.map(name => <option key={name} value={name}>{name}</option>)}
      </select></label>
      <span>{ranked.length} 人在册 · 排序只回答先看谁</span>
    </section>}

    {!people.length && <section className="people-empty">
      <h3>名册是空的。</h3>
      <p>从一个你已经知道姓名与职务的人开始。他连着哪些主体、能不能拍板，由后面的判断来回答——不是由名册来回答。</p>
    </section>}

    <div className="people-list">{ranked.map(entry => {
      const related = signals.filter(signal => `${signal.title}\n${signal.evidence}`.includes(entry.person.name.replace(/[（(][^）)]*[）)]/g, "").trim()));
      const orgs = orgsOfPerson(entry.person, signals);
      const open = expanded === entry.person.id;
      return <article className={entry.signedJudgments ? "person-card grounded" : "person-card"} key={entry.person.id}>
        <header>
          <div>
            <b>{entry.person.name}</b>
            <small>{[entry.person.department, entry.person.title].filter(Boolean).join(" · ") || "职务未标"} @ {entry.person.employer}</small>
          </div>
          <div className="person-badges">
            <i className={entry.signedJudgments ? "good" : "watching"}>{entry.signedJudgments} 条已过闸判断</i>
            {entry.openJudgments > 0 && <i>{entry.openJudgments} 条待补齐</i>}
          </div>
        </header>

        <div className="person-path">
          <small>我方通路</small>
          <span>{entry.person.ourPath.trim() || "还没查——空白不等于没有通路"}</span>
        </div>

        {!entry.signedJudgments && <p className="person-warn">还没有任何一条关于他的判断走完六道门。现在从他切入，凭的是印象不是判断。</p>}

        <button className="person-toggle" onClick={() => setExpanded(open ? "" : entry.person.id)}>
          {open ? "收起" : `展开 ${orgs.length} 个关联主体 / ${related.length} 条相关情报`}
        </button>

        {open && <div className="person-detail">
          <div className="person-orgs">{orgs.map(item => <span key={item.org}>{item.org}<i>{item.bestGate}/6</i></span>)}
            {!orgs.length && <em>还没有情报把他连到任何主体</em>}
          </div>
          <div className="person-signals">{related.map(signal => {
            const gate = gateState(signal);
            return <button key={signal.id} onClick={() => onOpenSignal(signal)}>
              <i className={gate.executable ? "good" : "watching"}>{gate.passed}/6</i>{signal.title}
            </button>;
          })}
            {!related.length && <em>还没有相关情报。先录一条你观察到的事实。</em>}
          </div>
          <button className="person-remove" onClick={() => onRemove(entry.person.id)}>从名册移除</button>
        </div>}
      </article>;
    })}</div>
  </>;
}
