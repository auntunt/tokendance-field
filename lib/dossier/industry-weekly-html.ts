import type { DossierDatabase } from "./repository";
import { getIndustryWeeklyAcceptance } from "./m6-repository";

function escape(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderIndustryWeeklyHtml(
  db: DossierDatabase,
  industryId: string,
  from: string,
  to: string,
  now = new Date(),
): string {
  const industry = db.prepare("SELECT name FROM industry WHERE id=?").get(industryId) as {name:string} | undefined;
  if (!industry) throw new Error(`找不到行业：${industryId}`);
  const companies = db.prepare("SELECT id, name FROM company WHERE industry_id=? ORDER BY name")
    .all(industryId) as Array<{ id: string; name: string }>;
  const rows = db.prepare(`
    SELECT u.*, s.url FROM industry_update u
    JOIN fact f ON f."table"='industry_update' AND f.row_id=u.id AND f.field='summary'
    JOIN source s ON s.id=f.source_id
    WHERE u.industry_id=? AND u.found_at BETWEEN ? AND ?
    GROUP BY u.id ORDER BY u.found_at DESC, u.kind, u.id
  `).all(industryId, from, to) as Array<Record<string, unknown>>;
  const selectedCount = rows.filter(row => row.promoted_at).length;
  const acceptance = getIndustryWeeklyAcceptance(db, industryId, now);
  const returnTo = `/industry-weekly/${encodeURIComponent(industryId)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const body = rows.map(row => {
    const companySelect = row.company_id || row.promoted_to_event_id ? "" : `<label><span class="sr-only">选择客户</span><select name="companyId" required><option value="">选择客户</option>${companies.map(company => `<option value="${escape(company.id)}">${escape(company.name)}</option>`).join("")}</select></label>`;
    const action = row.promoted_at
      ? `已选为有用<br><small>${escape(String(row.promoted_at).slice(0, 10))}</small>`
      : `<form action="/api/industry-weekly/promote" method="post"><input type="hidden" name="updateId" value="${escape(row.id)}"><input type="hidden" name="returnTo" value="${escape(returnTo)}">${companySelect}<button type="submit">${row.promoted_to_event_id ? "确认本周有用" : "选为有用信息"}</button></form>`;
    return `<tr><td>${escape(row.found_at)}</td><td><code>${escape(row.kind)}</code></td><td>${escape(row.summary)}</td><td>${action}</td><td><a href="${escape(row.url)}" target="_blank" rel="noreferrer">来源</a></td></tr>`;
  }).join("");
  const acceptanceRows = acceptance.recentWeeks.map(week => `<tr><td>${escape(week.from)} — ${escape(week.to)}${week.current ? "（本周）" : ""}</td><td>${week.selected} / ${acceptance.requiredSelectionsPerWeek}</td><td>${week.passed ? "达标" : "待完成"}</td></tr>`).join("");
  const acceptanceSummary = acceptance.accepted
    ? `四周运行验收已完成（截至 ${escape(acceptance.acceptedAtWeek)} 当周）`
    : `四周运行验收：最长连续 ${acceptance.maxConsecutiveWeeks} / ${acceptance.requiredWeeks} 周达标`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(industry.name)}行业周报</title><style>:root{color-scheme:dark}body{max-width:1180px;margin:48px auto;padding:0 24px;background:#0b0e12;color:#eef2f7;font:14px/1.6 system-ui}h1{font-size:40px}h2{margin-top:32px}p{color:#95a1b2}.progress{display:inline-block;margin-left:10px;padding:2px 8px;border:1px solid #ffb224;color:#ffb224}.acceptance{margin:24px 0;padding:18px;border:1px solid #28313d;background:#11161d}.acceptance table{margin-top:12px}table{width:100%;border-collapse:collapse;background:#11161d}th,td{padding:14px;border:1px solid #28313d;text-align:left;vertical-align:top}th{color:#ffb224}a{color:#65c7ff}form{display:flex;flex-direction:column;gap:8px}button,select{border:1px solid #ffb224;background:#11161d;color:#ffb224;padding:7px 10px;cursor:pointer}small{color:#95a1b2}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}code{color:#72d3ff}</style></head><body><h1>${escape(industry.name)}行业周报</h1><p>${escape(from)} — ${escape(to)} · ${rows.length} 条 <span class="progress">本页已选择 ${selectedCount} / 至少 3 条</span></p><section class="acceptance"><strong>${acceptanceSummary}</strong><table><thead><tr><th>自然周</th><th>已选择</th><th>结果</th></tr></thead><tbody>${acceptanceRows}</tbody></table></section><table><thead><tr><th>日期</th><th>类型</th><th>条目</th><th>是否有用</th><th>来源</th></tr></thead><tbody>${body}</tbody></table></body></html>`;
}
