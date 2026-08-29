// 从最新报告台账生成一批首页情报信号，并通过 /api/workspace 合并写入。
//
// 数据来源：reports/history/<date>.json 里的 Sourced 事实。
// 只提取有明确关系的字段：funding.investors / shareholders.majorHolders /
// business.customers / fde.onsiteModel。没有出处的字段一律不用。
//
// 用法：
//   node scripts/seed-fde-signals.mjs \
//     --history reports/history/2026-08-16.json \
//     --base https://www.field.tokendance.cool \
//     --user admin --password demo1234 --enrich 6
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const today = new Date().toISOString().slice(0, 10);
const historyPath = resolve(process.cwd(), args.get("--history") || `reports/history/${today}.json`);
const curatedPath = resolve(process.cwd(), args.get("--curated") || "scripts/curated-signals.json");
const base = args.get("--base") || "http://127.0.0.1:3000";
const user = args.get("--user") || "admin";
const password = args.get("--password") || "";
const enrichLimit = Number(args.get("--enrich") || 0);
const mode = args.get("--mode") || "merge";
const dryRun = args.get("--dry-run") === "true";

const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const profiles = JSON.parse(readFileSync(historyPath, "utf8"));

function factValue(profile, dim, key) {
  const entry = profile?.facts?.[dim]?.[key];
  if (!entry || typeof entry.value !== "string") return null;
  return entry;
}

function normName(text) {
  return String(text || "").replace(/^[\s（(]+|[\s）)]+$/g, "").trim().slice(0, 80);
}

function splitNames(value) {
  return String(value || "")
    .split(/[、，,；;]/)
    .map(normName)
    .filter(n => n.length >= 2 && !/^(未披露|未公开|未核实|无|暂无|多家|若干)$/.test(n));
}

function usableSource(entry, grades = ["statutory", "independent"]) {
  if (!entry?.sourceUrl || !grades.includes(entry.grade)) return false;
  try {
    const url = new URL(entry.sourceUrl);
    return ["http:", "https:"].includes(url.protocol)
      && url.hostname.includes(".")
      && !/[\s（）。“”"']/u.test(entry.sourceUrl);
  } catch {
    return false;
  }
}

/** 持股字段是「名字 + 百分比」的长文本，不能用逗号硬拆。
 *  按百分号往前找最近的公司名，避免把「4.4%（3 持有 Appian」当名字。 */
function parseHolderNames(value) {
  const text = String(value || "").replace(/截至[^：:]*[：:]\s*/, "");
  const names = [];
  const pattern = /([A-Za-z][A-Za-z0-9,.&()\- ]{2,60}?|[\u4e00-\u9fa5（）()]{2,20})\s*(\d+(?:\.\d+)?)\s*%/g;
  let m;
  while ((m = pattern.exec(text)) !== null && names.length < 4) {
    const name = normName(m[1]);
    // 这个分支生成的是“5% 以上股东”关系。低于 5% 的披露项即使出现在同一张表里，
    // 也不能被画成 5%+ 持股关系。
    if (Number(m[2]) >= 5 && name && !/^(\d|股份|口径|截至)/.test(name) && name.length >= 2) names.push(name);
  }
  return names;
}

function latestDate(text) {
  const found = [];
  const push = (y, m, d) => {
    if (y >= 2000 && y <= 2030 && m >= 1 && m <= 12 && d >= 1 && d <= 31) found.push(new Date(y, m - 1, d).getTime());
  };
  for (const m of String(text).matchAll(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) push(+m[1], +m[2], +m[3]);
  for (const m of String(text).matchAll(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/g)) push(+m[1], +m[2], +m[3]);
  return found.length ? new Date(Math.max(...found)) : null;
}

function iso(date) {
  const p = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function validUntil(relation, text) {
  const days = { equity: 365, supply: 180, personnel: 180, license: 365, compete: 90 }[relation] || 180;
  const anchor = latestDate(text) || new Date();
  const due = new Date(anchor.getTime() + days * 86400000);
  const floor = new Date(Date.now() + 30 * 86400000);
  return iso(due > floor ? due : floor);
}

function baseConstraints(signal, sourceGrade, text) {
  const edges = signal.edges || [];
  const relation = edges[0]?.relation || "equity";
  const entityScope = [...new Set(edges.flatMap(edge => [edge.from, edge.to]))].join(" / ");
  return {
    scope: { entityScope, marketRegion: "", dataBasis: "以来源原文口径为准", timeWindow: latestDate(text) ? `材料时点 ${iso(latestDate(text))} 起` : "", ourAccess: "" },
    epistemicState: "observation",
    falsifier: "",
    counterEvidence: "",
    sourceType: sourceGrade === "statutory" || sourceGrade === "independent" ? "independent" : "related",
    validUntil: validUntil(relation, text),
    probability: 50,
    signedOff: false,
    humanSource: "",
  };
}

function push(list, signal, max) {
  const key = `${signal.title}||${signal.source}`;
  if (list.some(s => `${s.title}||${s.source}` === key)) return false;
  if (list.length >= max) return false;
  list.push(signal);
  return true;
}

function makeSignals() {
  const out = [];
  let added = { investor: 0, holder: 0, customer: 0, fde: 0 };

  for (const profile of profiles) {
    // 1) 投资方关系：investor -> company
    const inv = factValue(profile, "funding", "investors");
    // 静态语料只有“公司级来源”，没有“融资字段级来源”。即使公司资料页里有链接，
    // 也不能据此证明某一家投资方，所以不再从旧语料生成投资边；最新融资只走人工核验清单。
    if (inv && profile.origin !== "fde_round3 / dist/data.json" && usableSource(inv) && added.investor < 14) {
      for (const investor of splitNames(inv.value).slice(0, Math.min(2, 14 - added.investor))) {
        const signal = {
          id: `seed-inv-${profile.id}-${added.investor}`,
          title: `${profile.name} · 投资方 ${investor}`,
          evidence: `${profile.name}：${inv.value}`,
          source: inv.source,
          sourceUrl: inv.sourceUrl,
          createdAt: inv.fetchedAt || today,
          dimensions: [], topics: [], candidateScore: 0, outcome: "watching",
          edges: [{ from: investor, to: profile.name, relation: "equity", direction: "forward", quote: inv.value }],
          origin: `seed-fde-${today}`,
        };
        signal.constraints = baseConstraints(signal, inv.grade, inv.value);
        if (push(out, signal, 48)) added.investor++;
      }
    }

    // 2) 主要股东关系：holder -> company
    const holders = factValue(profile, "shareholders", "majorHolders");
    if (usableSource(holders) && added.holder < 10) {
      const holderNames = parseHolderNames(holders.value).slice(0, Math.min(2, 10 - added.holder));
      for (const holder of holderNames) {
        const signal = {
          id: `seed-holder-${profile.id}-${added.holder}`,
          title: `${holder} 持有 ${profile.name}`,
          evidence: holders.value,
          source: holders.source,
          sourceUrl: holders.sourceUrl,
          createdAt: holders.fetchedAt || today,
          dimensions: [], topics: [], candidateScore: 0, outcome: "watching",
          edges: [{ from: holder, to: profile.name, relation: "equity", direction: "forward", quote: holders.value }],
          origin: `seed-fde-${today}`,
        };
        signal.constraints = baseConstraints(signal, holders.grade, holders.value);
        if (push(out, signal, 48)) added.holder++;
      }
    }

    // 3) 客户关系：company -> customer。只用 business.customers（明确客户名单），
    //    onsiteModel 是交付项目描述，不是客户名单，不能混进来。
    const customers = factValue(profile, "business", "customers");
    if (usableSource(customers) && added.customer < 12) {
      const names = customers.value.split(/[、，,；;]/)
        .map(normName)
        .map(n => n.split(/\s+/)[0] || n)
        .filter(n => n.length >= 2 && n.length <= 18
          && !/[（(]|[0-9]{3,}|[元万元%]|中标|成交|预算|公示|招标|采购方|金额|计费|平台|方案|项目|交付工业|为央国企|等\s*$|^\d|\*\*|—/.test(n)
          && !/^(AI|计费|公开招标|成交|预算|公示|采购方|中标|累计|来源|无|暂无|政法|教育|养老|医疗|金融|零售|制造|能源|能源企业|泛园区|建筑|物流|农业)$/.test(n)
          && (/(集团|公司|股份|科技|智能|银行|纸业|电气|汽车|证券|基金|研究院|大学|学院|医院|平台|工作室)/.test(n) || (n.length >= 2 && n.length <= 4)))
        .slice(0, Math.min(2, 12 - added.customer));
      for (const customer of names) {
        const signal = {
          id: `seed-cust-${profile.id}-${added.customer}`,
          title: `${profile.name} 为 ${customer} 提供交付`,
          evidence: customers.value,
          source: customers.source,
          sourceUrl: customers.sourceUrl,
          createdAt: customers.fetchedAt || today,
          dimensions: [], topics: [], candidateScore: 0, outcome: "watching",
          edges: [{ from: profile.name, to: customer, relation: "supply", direction: "forward", quote: customers.value }],
          origin: `seed-fde-${today}`,
        };
        signal.constraints = baseConstraints(signal, customers.grade, customers.value);
        if (push(out, signal, 48)) added.customer++;
      }
    }
  }

  // 4) FDE 模式证据（没有关系边，但这是整份报告要回答的核心问题）
  for (const profile of profiles) {
    if (added.fde >= 6) break;
    const fde = factValue(profile, "fde", "fdeNaming") || factValue(profile, "fde", "onsiteModel");
    if (!usableSource(fde) || !profile.watchlist) continue;
    const signal = {
      id: `seed-fde-${profile.id}`,
      title: `${profile.name} · FDE 模式证据`,
      evidence: fde.value,
      source: fde.source,
      sourceUrl: fde.sourceUrl,
      createdAt: fde.fetchedAt || today,
      dimensions: [], topics: [], candidateScore: 0, outcome: "watching",
      edges: [],
      origin: `seed-fde-${today}`,
    };
    signal.constraints = baseConstraints(signal, fde.grade, fde.value);
    if (push(out, signal, 48)) added.fde++;
  }

  console.log("生成信号：", added);
  return out;
}

async function api(path, options = {}) {
  const resp = await fetch(`${base}${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: auth, ...(options.headers || {}) },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`${path} ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

const generated = makeSignals();
const curatedRaw = existsSync(curatedPath) ? JSON.parse(readFileSync(curatedPath, "utf8")) : { signals: [], dropIds: [] };
const curatedSignals = Array.isArray(curatedRaw) ? curatedRaw : Array.isArray(curatedRaw.signals) ? curatedRaw.signals : [];
const dropIds = new Set(Array.isArray(curatedRaw.dropIds) ? curatedRaw.dropIds.map(String) : []);
for (const signal of curatedSignals) {
  if (!signal?.id || !signal?.title || !signal?.sourceUrl || !Array.isArray(signal.edges)) {
    throw new Error(`人工核验信号格式不完整：${JSON.stringify(signal).slice(0, 180)}`);
  }
}
const current = await api("/api/workspace");
const existingSignals = Array.isArray(current.signals) ? current.signals : [];
const managed = signal => /^seed-fde-|^scheduler-|^refresh-/.test(String(signal.origin || "")) || String(signal.id || "").startsWith("curated-");
const preserved = mode === "replace-managed"
  ? existingSignals.filter(signal => !managed(signal) && !dropIds.has(String(signal.id)))
  : existingSignals.filter(signal => !dropIds.has(String(signal.id)));
const incoming = [...generated, ...curatedSignals];
const byId = new Map(preserved.map(signal => [String(signal.id), signal]));
for (const signal of incoming) byId.set(String(signal.id), signal);
const merged = [...byId.values()];
const newSignals = incoming.filter(signal => !existingSignals.some(old => old.id === signal.id));
console.log(`已有 ${existingSignals.length} 条，保留 ${preserved.length} 条，刷新写入 ${incoming.length} 条，合计 ${merged.length} 条`);
if (dryRun) {
  const edgeCount = merged.reduce((sum, signal) => sum + (Array.isArray(signal.edges) ? signal.edges.length : 0), 0);
  console.log(`预演完成：${merged.length} 条信号 / ${edgeCount} 条关系；未写入工作区`);
  if (args.get("--details") === "true") {
    for (const signal of merged) console.log(`- ${signal.title}｜${signal.source}｜${signal.sourceUrl}`);
  }
  process.exit(0);
}
const put = async label => {
  await api("/api/workspace", {
    method: "PUT",
    body: JSON.stringify({
      weights: Array.isArray(current.weights) ? current.weights : [25, 25, 25, 25],
      signals: merged,
      feedback: Array.isArray(current.feedback) ? current.feedback : [],
      snapshots: Array.isArray(current.snapshots) ? current.snapshots : [],
      people: Array.isArray(current.people) ? current.people : [],
    }),
  });
  console.log("已写入：", label);
};
await put(`合并后共 ${merged.length} 条`);

// 给最重要的前 N 条自动起草，其余在判断页点「补全缺失项」即可。
if (enrichLimit > 0) {
  for (const signal of newSignals.slice(0, enrichLimit)) {
    try {
      const enriched = await api("/api/enrich", {
        method: "POST",
        body: JSON.stringify({ signal, mode: "propose" }),
      });
      const target = merged.find(s => s.id === signal.id);
      if (target && enriched.constraints) {
        target.constraints = {
          ...(target.constraints || {}),
          ...enriched.constraints,
          scope: { ...((target.constraints || {}).scope || {}), ...(enriched.constraints.scope || {}) },
          signedOff: false,
        };
      }
      console.log("已自动起草：", signal.title);
    } catch (err) {
      console.log("自动起草失败，保留确定性草稿：", signal.title, String(err).slice(0, 120));
    }
  }
  await put(`自动起草后共 ${merged.length} 条`);
}
