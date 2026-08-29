// 配置自检。挨个真的去用一遍，不是只看键在不在。
//
// 为什么不能只查键存在：线上那次故障就是「键全都在」——.env 里
// FIELD_ACCESS_USER / FIELD_ACCESS_PASSWORD 齐全，值却是密码轮换前的旧的。
// 任何只做 `if (!process.env.X) 报错` 的检查都会说「配置完整」。
// 所以这里的规矩是：能探活的就探活，探不了的至少说清它形状对不对。
//
// 用法：
//   node scripts/check-env.mjs            查本机 .env.local
//   node scripts/check-env.mjs --file .env  查别的文件
//   node scripts/check-env.mjs --skip-net   只做静态检查，不发请求
//
// 退出码：0 全过；1 有 FAIL。WARN 不影响退出码——可选项没配不算错。

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const fileArg = args.indexOf("--file");
const envFile = fileArg >= 0 ? args[fileArg + 1] : ".env.local";
const skipNet = args.includes("--skip-net");

/** 只解析 KEY=VALUE，不做 shell 展开——线上 .env 是 docker compose env_file 读的，
 *  它也不做 shell 展开。解析器跟消费者不一致，就会出现「本地能跑线上不行」。 */
function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const results = [];
const ok = (key, note) => results.push({ level: "OK", key, note });
const warn = (key, note) => results.push({ level: "WARN", key, note });
const fail = (key, note) => results.push({ level: "FAIL", key, note });

const path = resolve(process.cwd(), envFile);
const env = parseEnvFile(path);
if (!env) {
  console.error(`找不到 ${envFile}。先 cp .env.example ${envFile} 再填值。`);
  process.exit(1);
}
console.log(`检查 ${envFile}\n`);

// ── 访问控制 ───────────────────────────────────────────────────────
const user = env.FIELD_ACCESS_USER;
const password = env.FIELD_ACCESS_PASSWORD;
if (!user) fail("FIELD_ACCESS_USER", "没有值——登录接口会 500，整站进不去");
else ok("FIELD_ACCESS_USER", `${user.length} 字符`);

if (!password) fail("FIELD_ACCESS_PASSWORD", "没有值——登录接口会 500，整站进不去");
else if (password.length < 12) {
  // 唯一的防护是错密码时那 400ms 延迟，没有限流也没有锁定。
  // 短密码在这种条件下是可以被爆破的，所以要说出来，但这是用户自己的取舍。
  warn("FIELD_ACCESS_PASSWORD", `只有 ${password.length} 字符；没有限流也没有锁定，唯一防护是错密码 400ms 延迟`);
} else ok("FIELD_ACCESS_PASSWORD", `${password.length} 字符`);

// ── 落盘路径 ───────────────────────────────────────────────────────
// 相对路径本身不算错（本机开发就是相对的），但容器里是错的，所以只提示形状。
if (!env.DATABASE_PATH) warn("DATABASE_PATH", "没给，用默认 ./data/tokendance-field.sqlite（相对当前目录）");
else if (!env.DATABASE_PATH.startsWith("/")) warn("DATABASE_PATH", `相对路径 ${env.DATABASE_PATH}；容器里必须是挂了 volume 的绝对路径，否则重建容器丢账本`);
else ok("DATABASE_PATH", env.DATABASE_PATH);

if (!env.FIELD_REPORTS_DIR) warn("FIELD_REPORTS_DIR", "没给，会从当前目录往上找 reports/；容器里应指到 volume");
else ok("FIELD_REPORTS_DIR", env.FIELD_REPORTS_DIR);

// ── 抽取器 ─────────────────────────────────────────────────────────
// 三个键要么齐全要么全空。齐全就真发一次请求：密钥过期、模型名写错、
// 网关换了地址，这三种都只有发出去才知道，而它们恰好是最常见的三种。
const ex = { endpoint: env.EXTRACT_ENDPOINT, apiKey: env.EXTRACT_API_KEY, model: env.EXTRACT_MODEL };
const exGiven = Object.entries(ex).filter(([, v]) => v).map(([k]) => k);
if (exGiven.length === 0) {
  warn("EXTRACT_*", "三个都没配——/api/extract 会报「未配置」，供给管线不能用");
} else if (exGiven.length < 3) {
  const missing = ["endpoint", "apiKey", "model"].filter(k => !ex[k]).map(k => `EXTRACT_${k.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`);
  fail("EXTRACT_*", `只配了 ${exGiven.length}/3；缺 ${missing.join(" ")}——缺一个就等于全没配，接口一样报「未配置」`);
} else if (skipNet) {
  ok("EXTRACT_*", "三个键齐全（--skip-net，没探活）");
} else {
  await probe("EXTRACT_*", ex.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ex.apiKey}` },
    body: JSON.stringify({ model: ex.model, messages: [{ role: "user", content: "只回复 OK" }], temperature: 0 }),
  }, payload => {
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("返回里没有 choices[0].message.content——这个网关可能不是 chat/completions 协议");
    return `${new URL(ex.endpoint).host} · ${ex.model} · 回复 ${JSON.stringify(text.slice(0, 12))}`;
  });
}

// ── 模型批评器 ─────────────────────────────────────────────────────
// 全空是合法状态：/api/analyze 允许前端每次会话现填密钥，环境变量只是兜底。
// 配了就要探活，而且必须按各家自己的协议探——这里最容易踩的坑是
// 以为「都是 OpenAI 兼容」，结果 anthropic 要 x-api-key、openai 要 /v1/responses。
const PROVIDERS = [
  { key: "ANTHROPIC_API_KEY", url: "https://api.anthropic.com/v1/messages", fallbackModel: "claude-sonnet-4-5",
    headers: k => ({ "content-type": "application/json", "x-api-key": k, "anthropic-version": "2023-06-01" }),
    body: m => JSON.stringify({ model: m, max_tokens: 16, messages: [{ role: "user", content: "只回复 OK" }] }),
    read: p => p?.content?.map(c => c.text || "").join("") },
  { key: "OPENAI_API_KEY", url: "https://api.openai.com/v1/responses", fallbackModel: "gpt-5",
    headers: k => ({ "content-type": "application/json", authorization: `Bearer ${k}` }),
    body: m => JSON.stringify({ model: m, input: "只回复 OK" }),
    read: p => p?.output_text ?? p?.output?.flatMap(i => i.content || []).map(i => i.text || "").join("") },
  { key: "DEEPSEEK_API_KEY", url: "https://api.deepseek.com/chat/completions", fallbackModel: "deepseek-chat",
    headers: k => ({ "content-type": "application/json", authorization: `Bearer ${k}` }),
    body: m => JSON.stringify({ model: m, messages: [{ role: "user", content: "只回复 OK" }] }),
    read: p => p?.choices?.[0]?.message?.content },
];
// 探活必须打「这个密钥实际会被送去的那个地址」，不是官方地址。
// 否则自建网关的密钥会在 api.anthropic.com 上得到 403，报成「密钥失效」——
// 而密钥是好的，只是配了 ANALYZE_ENDPOINT 让它去别处。假 FAIL 比不检查更坏。
const override = env.ANALYZE_ENDPOINT;
if (override) {
  try { new URL(override); ok("ANALYZE_ENDPOINT", `${new URL(override).host}（覆盖三家的官方地址）`); }
  catch { fail("ANALYZE_ENDPOINT", `不是合法地址：${JSON.stringify(override)}`); }
}

const configured = PROVIDERS.filter(p => env[p.key]);
if (configured.length === 0) {
  warn("*_API_KEY", "三家都没配——/api/analyze 只能靠前端每次会话现填密钥（这是允许的用法）");
}
// 一个地址配多家密钥必然有一家是错的：ANALYZE_ENDPOINT 是单值，
// 而 anthropic 要 /v1/messages、openai 要 /v1/responses、deepseek 要 chat/completions。
// 同一个地址不可能同时是这三个。
if (override && configured.length > 1) {
  warn("ANALYZE_ENDPOINT", `是单值，但配了 ${configured.length} 家密钥（${configured.map(p => p.key.replace("_API_KEY", "")).join("/")}）；三家协议路径不同，同一个地址只可能对一家`);
}
for (const p of configured) {
  if (skipNet) { ok(p.key, `${env[p.key].length} 字符（--skip-net，没探活）`); continue; }
  const url = override || p.url;
  // 探活要用「界面上真会被送出去的那个模型名」。自建网关的模型清单跟官方不一样：
  // 这台网关有 claude-sonnet-5，没有裸的 claude-sonnet-4-5，
  // 拿官方默认名去探会得到 503 model_not_found，看着像网关挂了，其实是名字不对。
  const model = env.ANALYZE_MODEL || p.fallbackModel;
  // 协议是跟着服务商走的，不跟着地址走：选了 anthropic 就发 /v1/messages 那套
  // 请求头和请求体，哪怕地址被换成了网关。网关不实现这套协议就该在这里暴露。
  await probe(p.key, url, { method: "POST", headers: p.headers(env[p.key]), body: p.body(model) }, payload => {
    const text = p.read(payload);
    if (typeof text !== "string" || !text.trim()) throw new Error("返回正文是空的——这个地址可能不接受该服务商的协议");
    return `${new URL(url).host} · ${model} · 回复 ${JSON.stringify(text.slice(0, 12))}`;
  });
}

// ── 联网研究通道 ───────────────────────────────────────────────────
const researchProvider = (env.RESEARCH_SEARCH_PROVIDER || "auto").toLowerCase();
if (!["auto", "xai", "openai", "anthropic", "bing"].includes(researchProvider)) {
  fail("RESEARCH_SEARCH_PROVIDER", `不支持「${researchProvider}」；只能是 auto/xai/openai/anthropic/bing`);
} else {
  const resolved = researchProvider === "auto"
    ? (env.XAI_API_KEY ? "xai" : env.OPENAI_API_KEY ? "openai" : "bing")
    : researchProvider;
  const missing = resolved === "xai" && !env.XAI_API_KEY
    ? "XAI_API_KEY" : resolved === "openai" && !env.OPENAI_API_KEY
      ? "OPENAI_API_KEY" : resolved === "anthropic" && !env.ANTHROPIC_API_KEY
        ? "ANTHROPIC_API_KEY" : "";
  if (missing) warn("RESEARCH_SEARCH_PROVIDER", `${resolved} 没有 ${missing}，运行时会回退 Bing`);
  else ok("RESEARCH_SEARCH_PROVIDER", `${researchProvider} → ${resolved}`);
}
for (const [key, fallback] of [
  ["XAI_BASE_URL", "https://api.x.ai/v1"],
  ["OPENAI_BASE_URL", "https://api.openai.com/v1"],
  ["ANTHROPIC_BASE_URL", "https://api.anthropic.com/v1"],
]) {
  try { new URL(env[key] || fallback); }
  catch { fail(key, `不是合法地址：${JSON.stringify(env[key])}`); }
}

const timeout = env.ANALYZE_TIMEOUT_MS;
if (!timeout) warn("ANALYZE_TIMEOUT_MS", "没给，用默认 120000ms");
else if (!/^\d+$/.test(timeout) || Number(timeout) === 0) {
  // Number("两分钟") 是 NaN，`Number(x) || 120_000` 会静默吃掉它退回默认值。
  // 不报出来的话，你以为改了超时，其实没改。
  fail("ANALYZE_TIMEOUT_MS", `「${timeout}」不是正整数，代码会静默退回 120000ms`);
} else if (Number(timeout) < 30_000) {
  warn("ANALYZE_TIMEOUT_MS", `${timeout}ms 偏短；推理类模型冷启动常超过 30 秒，会被判成超时`);
} else ok("ANALYZE_TIMEOUT_MS", `${timeout}ms`);

/** 真发一次请求。函数声明而非 const，因为上面的顶层 await 在它之前就调用了
 *  —— 函数声明会提升，const 不会。 */
async function probe(key, url, init, read) {
  let host;
  try { host = new URL(url).host; }
  catch { fail(key, `地址不合法：${JSON.stringify(url)}`); return; }
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
    const raw = await response.text();
    if (!response.ok) {
      // 状态码本身就是诊断：401/403 是密钥问题，404 是地址或模型名，5xx 是上游。
      // 503 要单独说「重试」。自建网关过载（system cpu overloaded）和
      // 模型名不存在（model_not_found）都是 503，前者重试就好、后者要改配置——
      // 笼统写「上游故障」会让人把一次瞬时过载当成配置错，回头去翻密钥。
      const hint = response.status === 401 || response.status === 403 ? "密钥无效或已过期"
        : response.status === 404 ? "地址或模型名不对"
        : response.status === 429 ? "被限流，密钥本身可能是好的"
        : response.status === 503 ? (/model_not_found|无可用渠道/.test(raw) ? "模型名在这个网关上不存在" : "上游忙，重试一次再判断")
        : "上游故障";
      fail(key, `${host} 返回 ${response.status}（${hint}）：${raw.slice(0, 160)}`);
      return;
    }
    let payload;
    try { payload = JSON.parse(raw); }
    catch { fail(key, `${host} 返回的不是 JSON：${raw.slice(0, 160)}`); return; }
    ok(key, read(payload));
  } catch (error) {
    const name = error?.name === "TimeoutError" ? "45 秒没响应" : (error?.message || String(error));
    fail(key, `${host} 连不上：${name}`);
  }
}

// ── 汇总 ───────────────────────────────────────────────────────────
const PAD = Math.max(...results.map(r => r.key.length));
for (const r of results) {
  const mark = r.level === "OK" ? "✔" : r.level === "WARN" ? "!" : "✖";
  console.log(`${mark} ${r.key.padEnd(PAD)}  ${r.note}`);
}
const failed = results.filter(r => r.level === "FAIL").length;
const warned = results.filter(r => r.level === "WARN").length;
console.log(`\n${results.length - failed - warned} 项可用，${warned} 项提示，${failed} 项不可用`);
if (failed) console.log("不可用的项会让对应功能直接报错，不是降级。");
process.exit(failed ? 1 : 0);
