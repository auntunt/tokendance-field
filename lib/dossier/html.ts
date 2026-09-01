import type { DossierDatabase } from "./repository";
import type { SnapshotChange } from "./snapshot";
import type { EntryPrep } from "../generate/entry-prep";
import type { GeneratedOpportunity } from "../generate/opportunities";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

interface SourceLink {
  url: string;
  type: string;
}

function sourceRows(db: DossierDatabase, table: string, rowId: string, field?: string): SourceLink[] {
  const rows = field
    ? db.prepare(`
      SELECT DISTINCT s.url, s.type FROM fact f JOIN source s ON s.id=f.source_id
      WHERE f."table"=? AND f.row_id=? AND f.field=? ORDER BY s.type, s.url
    `).all(table, rowId, field) as SourceLink[]
    : db.prepare(`
    SELECT DISTINCT s.url, s.type FROM fact f JOIN source s ON s.id=f.source_id
    WHERE f."table"=? AND f.row_id=? ORDER BY s.type, s.url
  `).all(table, rowId) as SourceLink[];
  return rows;
}

function sourceLinks(db: DossierDatabase, table: string, rowId: string): string {
  const rows = sourceRows(db, table, rowId);
  return rows.map((row, index) => `<a href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">${escapeHtml(row.type)} ${index + 1}</a>`).join(" · ") || "—";
}

function sourcedValue(db: DossierDatabase, table: string, rowId: string, field: string, value: unknown): string {
  const escaped = escapeHtml(value ?? "—");
  const exact = sourceRows(db, table, rowId, field);
  const rows = exact.length > 0 ? exact : sourceRows(db, table, rowId);
  if (rows.length === 0) return escaped;
  const [first, ...rest] = rows;
  const additional = rest.map((row, index) => `<a class="source-more" href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer" aria-label="另一个来源">+${index + 1}</a>`).join("");
  return `<a class="sourced" href="${escapeHtml(first.url)}" target="_blank" rel="noreferrer" title="${escapeHtml(first.type)}">${escaped}</a>${additional}`;
}

function basisLinks(db: DossierDatabase, basisIds: string[]): string {
  const links = new Map<string, string>();
  for (const basisId of basisIds) {
    const rows = db.prepare(`
      SELECT DISTINCT s.url, s.type FROM fact f JOIN source s ON s.id=f.source_id
      WHERE f.row_id=? ORDER BY s.type, s.url
    `).all(basisId) as SourceLink[];
    for (const row of rows) links.set(row.url, row.type);
  }
  const sources = [...links].map(([url, type], index) => `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(type)} ${index + 1}</a>`).join(" · ");
  return `<code>${escapeHtml(basisIds.join(" / "))}</code>${sources ? `<br>${sources}` : ""}`;
}

function table(headers: string[], rows: string[][]): string {
  return `<div class="table-wrap"><table><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function section(number: number, title: string, content: string): string {
  return `<section id="chapter-${number}"><div class="section-no">${String(number).padStart(2, "0")}</div><div class="section-body"><h2>${escapeHtml(title)}</h2>${content}</div></section>`;
}

export function entryPrepCharacterCount(prep: EntryPrep): number {
  const text = [
    ...prep.stakeholders.flatMap(item => [item.target, item.purpose]),
    ...prep.questions.map(item => item.question),
    ...prep.risks.flatMap(item => [item.risk, item.handling]),
  ].join("");
  return [...text].filter(char => /[\u3400-\u9fff]/.test(char)).length;
}

function sentenceCount(value: unknown): number {
  return String(value ?? "").split(/[。！？!?]+/).filter(part => part.trim()).length;
}

function assertSingleSentence(chapter: number, label: string, value: unknown): void {
  if (sentenceCount(value) > 1) throw new Error(`第 ${chapter} 章 ${label} 超过 1 句`);
}

function chineseCharacterCount(value: unknown): number {
  return [...String(value ?? "")].filter(char => /[\u3400-\u9fff]/.test(char)).length;
}

function truncateChinese(value: unknown, maximum: number): string {
  const input = String(value ?? "");
  let count = 0;
  let output = "";
  for (const char of input) {
    if (/[\u3400-\u9fff]/.test(char)) {
      if (count >= maximum) return `${output}…`;
      count += 1;
    }
    output += char;
  }
  return output;
}

function assertDossierLimits(
  company: Record<string, unknown>,
  coverSummary: string,
  people: Array<Record<string, unknown>>,
  events: Array<Record<string, unknown>>,
  opportunities: GeneratedOpportunity[],
  prep: EntryPrep,
): void {
  const coverText = `${company.name ?? ""}${company.listing ?? ""}${coverSummary}`;
  const coverCharacters = chineseCharacterCount(coverText);
  if (coverCharacters > 50) throw new Error(`第 1 章文字 ${coverCharacters} 字，超过 50 字`);
  for (const row of people) assertSingleSentence(4, String(row.name), row.bio);
  for (const row of events) assertSingleSentence(6, String(row.id), row.summary);
  for (const row of opportunities) {
    assertSingleSentence(9, `${row.id}.painPoint`, row.painPoint);
    assertSingleSentence(9, `${row.id}.aiScenario`, row.aiScenario);
    assertSingleSentence(9, `${row.id}.dataPrerequisite`, row.dataPrerequisite);
  }
  const prepCharacters = entryPrepCharacterCount(prep);
  if (prepCharacters > 400) throw new Error(`第 10 章文字 ${prepCharacters} 字，超过 400 字`);
}

export function renderDossierHtml(
  db: DossierDatabase,
  companyId: string,
  opportunities: GeneratedOpportunity[],
  prep: EntryPrep,
  changes: SnapshotChange[],
): string {
  const company = db.prepare("SELECT * FROM company WHERE id=?").get(companyId) as Record<string, unknown> | undefined;
  if (!company) throw new Error(`找不到客户：${companyId}`);
  const industry = company.industry_id
    ? db.prepare("SELECT * FROM industry WHERE id=?").get(company.industry_id) as Record<string, unknown> | undefined
    : undefined;
  const terms = company.industry_id
    ? db.prepare("SELECT * FROM industry_term WHERE industry_id=? ORDER BY term").all(company.industry_id) as Array<Record<string, unknown>>
    : [];
  const businessLines = db.prepare("SELECT * FROM business_line WHERE company_id=? ORDER BY name").all(companyId) as Array<Record<string, unknown>>;
  const processes = db.prepare(`
    SELECT ps.*, bl.name AS business_line FROM process_step ps JOIN business_line bl ON bl.id=ps.business_line_id
    WHERE bl.company_id=? ORDER BY bl.name, ps.seq
  `).all(companyId) as Array<Record<string, unknown>>;
  const orgUnits = db.prepare("SELECT * FROM org_unit WHERE company_id=? ORDER BY name").all(companyId) as Array<Record<string, unknown>>;
  const people = db.prepare(`
    SELECT p.id, p.name, p.bio, p.stance, po.id AS position_id, po.title FROM position po JOIN person p ON p.id=po.person_id
    WHERE po.company_id=? ORDER BY p.name
  `).all(companyId) as Array<Record<string, unknown>>;
  const systems = db.prepare("SELECT * FROM system_in_use WHERE company_id=? ORDER BY category, product").all(companyId) as Array<Record<string, unknown>>;
  const events = db.prepare("SELECT * FROM event WHERE company_id=? ORDER BY occurred_at DESC").all(companyId) as Array<Record<string, unknown>>;
  const finances = db.prepare("SELECT * FROM financial_snapshot WHERE company_id=? ORDER BY year").all(companyId) as Array<Record<string, unknown>>;
  const relationships = db.prepare("SELECT * FROM relationship WHERE company_id=? ORDER BY kind, counterparty").all(companyId) as Array<Record<string, unknown>>;
  const latestFinancial = finances.at(-1);
  const latestEvent = events[0];
  const coverFixedCharacters = chineseCharacterCount(company.name) + chineseCharacterCount(company.listing);
  const coverSummary = truncateChinese(latestEvent?.summary, Math.max(0, 50 - coverFixedCharacters));
  assertDossierLimits(company, coverSummary, people, events, opportunities, prep);
  const sections: string[] = [];

  if (changes.length > 0) {
    sections.push(section(0, "自上次以来的变化", table(
      ["类型", "表 / 行", "字段", "之前", "现在", "来源"],
      changes.map(change => [
        escapeHtml(change.kind), escapeHtml(`${change.table} / ${change.rowId}`), escapeHtml(change.field),
        escapeHtml(change.before), escapeHtml(change.after),
        change.sourceUrls.map(url => `<a href="${escapeHtml(url)}">来源</a>`).join(" · ") || "—",
      ]),
    )));
  }
  sections.push(section(1, "封面卡", `<div class="cards">
    <div><span>客户</span><strong>${sourcedValue(db, "company", companyId, "name", company.name)}</strong><small>${sourcedValue(db, "company", companyId, "listing", company.listing)}</small></div>
    <div><span>规模</span><strong>${latestFinancial ? sourcedValue(db, "financial_snapshot", String(latestFinancial.id), "revenue", `${(Number(latestFinancial.revenue) / 100_000_000).toFixed(2)} 亿元`) : "—"}</strong><small>最近披露营收</small></div>
    <div><span>最近大事</span><strong>${latestEvent ? sourcedValue(db, "event", String(latestEvent.id), "occurred_at", latestEvent.occurred_at) : "—"}</strong><small>${latestEvent ? sourcedValue(db, "event", String(latestEvent.id), "summary", coverSummary) : "暂无"}</small></div>
  </div>`));
  sections.push(section(2, "行业速通", `${table(
    ["上游", "行业", "下游", "KPI", "监管"],
    industry ? [[
      sourcedValue(db, "industry", String(industry.id), "upstream", industry.upstream),
      sourcedValue(db, "industry", String(industry.id), "name", industry.name),
      sourcedValue(db, "industry", String(industry.id), "downstream", industry.downstream),
      sourcedValue(db, "industry", String(industry.id), "kpis", industry.kpis),
      sourcedValue(db, "industry", String(industry.id), "regulators", industry.regulators),
    ]] : [],
  )}${table(["术语", "普通中文解释", "来源"], terms.map(row => [
    sourcedValue(db, "industry_term", String(row.id), "term", row.term),
    sourcedValue(db, "industry_term", String(row.id), "plain_meaning", row.plain_meaning),
    sourceLinks(db, "industry_term", String(row.id)),
  ]))}`));
  sections.push(section(3, "业务与流程", `${table(["业务线", "收入占比", "来源"], businessLines.map(row => [
    sourcedValue(db, "business_line", String(row.id), "name", row.name),
    row.revenue_share == null ? "—" : sourcedValue(db, "business_line", String(row.id), "revenue_share", `${row.revenue_share}%`),
    sourceLinks(db, "business_line", String(row.id)),
  ]))}${table(["业务线", "顺序", "流程", "归口", "痛点", "来源"], processes.map(row => [
    escapeHtml(row.business_line),
    sourcedValue(db, "process_step", String(row.id), "seq", row.seq),
    sourcedValue(db, "process_step", String(row.id), "name", row.name),
    sourcedValue(db, "process_step", String(row.id), "owner_org_unit", row.owner_org_unit),
    sourcedValue(db, "process_step", String(row.id), "pain_point", row.pain_point),
    sourceLinks(db, "process_step", String(row.id)),
  ]))}`));
  sections.push(section(4, "组织与决策链", `${table(["组织单元", "上级", "负责人", "来源"], orgUnits.map(row => [
    sourcedValue(db, "org_unit", String(row.id), "name", row.name),
    row.parent_id ? sourcedValue(db, "org_unit", String(row.id), "parent_id", row.parent_id) : "—",
    row.head_person_id ? sourcedValue(db, "org_unit", String(row.id), "head_person_id", row.head_person_id) : "—",
    sourceLinks(db, "org_unit", String(row.id)),
  ]))}${table(["人物", "职务", "角色", "一句话", "来源"], people.map(row => [
    sourcedValue(db, "person", String(row.id), "name", row.name),
    sourcedValue(db, "position", String(row.position_id), "title", row.title),
    sourcedValue(db, "person", String(row.id), "stance", row.stance),
    sourcedValue(db, "person", String(row.id), "bio", row.bio),
    `${sourceLinks(db, "person", String(row.id))} · ${sourceLinks(db, "position", String(row.position_id))}`,
  ]))}`));
  sections.push(section(5, "系统与数据现状", table(["类别", "产品", "供应商", "覆盖流程", "启用时间", "来源"], systems.map(row => [
    sourcedValue(db, "system_in_use", String(row.id), "category", row.category),
    sourcedValue(db, "system_in_use", String(row.id), "product", row.product),
    row.vendor ? sourcedValue(db, "system_in_use", String(row.id), "vendor", row.vendor) : "—",
    sourcedValue(db, "system_in_use", String(row.id), "covers_process_step", row.covers_process_step),
    row.since ? sourcedValue(db, "system_in_use", String(row.id), "since", row.since) : "—",
    sourceLinks(db, "system_in_use", String(row.id)),
  ]))));
  sections.push(section(6, "数字化 / AI 动作", table(["时间", "类型", "动作", "来源"], events.map(row => [
    sourcedValue(db, "event", String(row.id), "occurred_at", row.occurred_at),
    sourcedValue(db, "event", String(row.id), "kind", row.kind),
    sourcedValue(db, "event", String(row.id), "summary", row.summary),
    sourceLinks(db, "event", String(row.id)),
  ]))));
  sections.push(section(7, "预算信号", table(["年度", "营收", "净利润", "研发投入", "IT 投入", "来源"], finances.map(row => [
    sourcedValue(db, "financial_snapshot", String(row.id), "year", row.year),
    row.revenue == null ? "—" : sourcedValue(db, "financial_snapshot", String(row.id), "revenue", row.revenue),
    row.net_profit == null ? "—" : sourcedValue(db, "financial_snapshot", String(row.id), "net_profit", row.net_profit),
    row.rnd_expense == null ? "—" : sourcedValue(db, "financial_snapshot", String(row.id), "rnd_expense", row.rnd_expense),
    row.it_capex == null ? "—" : sourcedValue(db, "financial_snapshot", String(row.id), "it_capex", row.it_capex),
    sourceLinks(db, "financial_snapshot", String(row.id)),
  ]))));
  sections.push(section(8, "同业对标", table(["关系", "对方", "金额", "期间", "来源"], relationships.map(row => [
    sourcedValue(db, "relationship", String(row.id), "kind", row.kind),
    sourcedValue(db, "relationship", String(row.id), "counterparty", row.counterparty),
    row.amount ? sourcedValue(db, "relationship", String(row.id), "amount", row.amount) : "—",
    [
      row.period_start ? sourcedValue(db, "relationship", String(row.id), "period_start", row.period_start) : "",
      row.period_end ? sourcedValue(db, "relationship", String(row.id), "period_end", row.period_end) : "",
    ].filter(Boolean).join(" — ") || "—",
    sourceLinks(db, "relationship", String(row.id)),
  ]))));
  sections.push(section(9, "AI 机会地图", table(["业务环节", "痛点", "可落地场景", "数据前提", "归口部门", "流程 / 系统依据", "来源"], opportunities.map(row => [
    sourcedValue(db, "opportunity", row.id, "process_step_id", row.businessStep),
    sourcedValue(db, "opportunity", row.id, "pain_point", row.painPoint),
    sourcedValue(db, "opportunity", row.id, "ai_scenario", row.aiScenario),
    sourcedValue(db, "opportunity", row.id, "data_prerequisite", row.dataPrerequisite),
    sourcedValue(db, "opportunity", row.id, "owner_org_unit", row.ownerOrgUnit),
    `<code>${escapeHtml(row.processStepId)} / ${escapeHtml(row.systemInUseId)}</code>`,
    row.sourceIds.map(sourceId => {
      const source = db.prepare("SELECT url FROM source WHERE id=?").get(sourceId) as {url:string} | undefined;
      return source ? `<a href="${escapeHtml(source.url)}">来源</a>` : "";
    }).filter(Boolean).join(" · "),
  ]))));
  sections.push(section(10, "进场准备", `${table(["顺序", "对象", "目的", "依据"], prep.stakeholders.map(row => [
    escapeHtml(row.order), escapeHtml(row.target), escapeHtml(row.purpose), basisLinks(db, row.basisIds),
  ]))}${table(["问题", "依据"], prep.questions.map(row => [
    escapeHtml(row.question), basisLinks(db, row.basisIds),
  ]))}${table(["雷区", "处理", "依据"], prep.risks.map(row => [
    escapeHtml(row.risk), escapeHtml(row.handling), basisLinks(db, row.basisIds),
  ]))}<div class="limit">第 10 章中文字符：${entryPrepCharacterCount(prep)} / 400</div>`));

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(company.name)} · FDE 档案</title><style>
  :root{color-scheme:dark;--bg:#0b0e12;--panel:#11161d;--line:#28313d;--text:#eef2f7;--muted:#95a1b2;--accent:#ffb224}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif}header{padding:72px max(24px,6vw) 40px;border-bottom:1px solid var(--line);background:radial-gradient(circle at 80% 10%,#203248 0,transparent 38%)}header p{margin:0 0 12px;color:var(--accent);letter-spacing:.18em;text-transform:uppercase}h1{margin:0;font-size:clamp(36px,6vw,76px);letter-spacing:-.05em}main{max-width:1500px;margin:auto;padding:20px max(20px,4vw) 80px}section{display:grid;grid-template-columns:72px minmax(0,1fr);gap:24px;padding:44px 0;border-bottom:1px solid var(--line)}.section-no{color:var(--accent);font:600 12px/1 ui-monospace,monospace;letter-spacing:.12em;padding-top:10px}h2{margin:0 0 24px;font-size:26px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.cards div{min-height:150px;padding:22px;border:1px solid var(--line);background:var(--panel)}.cards span,.cards small{display:block;color:var(--muted)}.cards strong{display:block;font-size:22px;margin:18px 0 8px}.table-wrap{overflow:auto;margin:0 0 16px;border:1px solid var(--line);background:var(--panel)}table{width:100%;border-collapse:collapse;min-width:760px}th,td{padding:13px 14px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase}tr:last-child td{border-bottom:0}a{color:#65c7ff;text-decoration:none}.sourced{color:inherit;text-decoration:underline;text-decoration-color:#365a70;text-underline-offset:3px}.sourced:hover{color:#65c7ff}.source-more{margin-left:4px;font-size:10px}code{color:#c8d2df;font-size:12px}.limit{color:var(--muted);text-align:right}.empty{color:var(--muted)}@media(max-width:760px){section{grid-template-columns:1fr}.section-no{padding:0}.cards{grid-template-columns:1fr}}
  </style></head><body><header><p>Field dossier / sourced</p><h1>${escapeHtml(company.name)}</h1></header><main>${sections.join("")}</main></body></html>`;
}
