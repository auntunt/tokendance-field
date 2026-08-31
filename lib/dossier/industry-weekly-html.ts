import type { DossierDatabase } from "./repository";

function escape(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderIndustryWeeklyHtml(db: DossierDatabase, industryId: string, from: string, to: string): string {
  const industry = db.prepare("SELECT name FROM industry WHERE id=?").get(industryId) as {name:string} | undefined;
  if (!industry) throw new Error(`找不到行业：${industryId}`);
  const rows = db.prepare(`
    SELECT u.*, s.url FROM industry_update u
    JOIN fact f ON f."table"='industry_update' AND f.row_id=u.id AND f.field='summary'
    JOIN source s ON s.id=f.source_id
    WHERE u.industry_id=? AND u.found_at BETWEEN ? AND ?
    GROUP BY u.id ORDER BY u.found_at DESC, u.kind, u.id
  `).all(industryId, from, to) as Array<Record<string, unknown>>;
  const returnTo = `/industry-weekly/${encodeURIComponent(industryId)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const body = rows.map(row => {
    const action = row.promoted_to_event_id
      ? "已写入"
      : row.company_id
        ? `<form action="/api/industry-weekly/promote" method="post"><input type="hidden" name="updateId" value="${escape(row.id)}"><input type="hidden" name="returnTo" value="${escape(returnTo)}"><button type="submit">写入 Event</button></form>`
        : "需指定客户";
    return `<tr><td>${escape(row.found_at)}</td><td><code>${escape(row.kind)}</code></td><td>${escape(row.summary)}</td><td>${action}</td><td><a href="${escape(row.url)}" target="_blank" rel="noreferrer">来源</a></td></tr>`;
  }).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(industry.name)}行业周报</title><style>:root{color-scheme:dark}body{max-width:1180px;margin:48px auto;padding:0 24px;background:#0b0e12;color:#eef2f7;font:14px/1.6 system-ui}h1{font-size:40px}p{color:#95a1b2}table{width:100%;border-collapse:collapse;background:#11161d}th,td{padding:14px;border:1px solid #28313d;text-align:left;vertical-align:top}th{color:#ffb224}a{color:#65c7ff}button{border:1px solid #ffb224;background:transparent;color:#ffb224;padding:6px 10px;cursor:pointer}code{color:#72d3ff}</style></head><body><h1>${escape(industry.name)}行业周报</h1><p>${escape(from)} — ${escape(to)} · ${rows.length} 条</p><table><thead><tr><th>日期</th><th>类型</th><th>条目</th><th>状态</th><th>来源</th></tr></thead><tbody>${body}</tbody></table></body></html>`;
}
