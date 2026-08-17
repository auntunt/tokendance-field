export const dynamic = "force-dynamic";

type Provider = "openai" | "anthropic" | "deepseek" | "compatible";
type RequestBody = { provider: Provider; model: string; endpoint?: string; apiKey?: string; title: string; evidence: string; source: string };
type RuntimeEnv = {
  OPENAI_API_KEY?: string; ANTHROPIC_API_KEY?: string; DEEPSEEK_API_KEY?: string;
  ANALYZE_ENDPOINT?: string; ANALYZE_MODEL?: string;
};

const outputShape = `只输出严格 JSON，不要 Markdown：
{"summary":"一句话局部解释", "dimensions":[{"dimension":"资本关联|供应依赖|竞争替代|人事技术交叉","score":0-100,"reason":"基于原始依据的解释","evidence":["原文短语"]}], "candidate_topics":[{"label":"关系判断方向，不要给结论性定性","rationale":"为什么聚合","evidence":["原文短语"]}], "local_context":{"entityScope":"涉及哪些主体及其层级或未知","marketRegion":"市场与地域范围或未知","dataBasis":"数据口径与统计边界或未知","timeWindow":"该关系成立的时间窗口或未知","ourAccess":"我方能拿到什么可核查渠道或未知"}, "epistemic_state":"observation|interpretation|hypothesis|action", "falsifiers":["什么可观察事实会推翻该关系判断"], "counterevidence":["当前最强反例或需要主动寻找的反例"], "confidence":5-95, "questions":["需要由专家或工商、公告等一手材料验证的问题"]}`;
const systemPrompt = `你是这套情报引擎的“企业关系批评器”。语料是情报，不是答案；任何关系解释都只在具体主体范围、市场地域、数据口径、时间窗口和我方可核查渠道内成立。你的工作不是替人下结论，更不能编造股权、交易或人事事实。只根据给出的原始情报：一、严格区分观察、解释、假设和行动主张；二、指出局部适用边界，未知就明确写未知；三、给出可证伪条件和最强反例；四、以校准概率表达信心。模型只能提交可供专家审阅的草稿，不能签署判断。四个方向维度分别是：资本关联（持股、投资、并购等所有权链条）、供应依赖（采购、供货、产能与订单依赖）、竞争替代（同一需求上的替代与争夺）、人事技术交叉（高管兼任、团队流动、专利与技术授权）。${outputShape}`;

function keyFor(provider: Provider) {
  const runtime = process.env as RuntimeEnv;
  return provider === "openai" ? runtime.OPENAI_API_KEY : provider === "anthropic" ? runtime.ANTHROPIC_API_KEY : provider === "deepseek" ? runtime.DEEPSEEK_API_KEY : undefined;
}

/** 地址的兜底顺序：请求体 → ANALYZE_ENDPOINT → 该服务商的官方地址。
 *
 *  中间这一层是必须的。密钥和地址是一对：自建网关的密钥拿去打
 *  api.anthropic.com 就是 403，官方密钥打网关也一样不通。
 *  但原来只有 *_API_KEY 能配，地址只能在界面里手填——
 *  于是「配好了」的服务器上，谁忘了填地址就会拿网关密钥去打官方，
 *  得到一个看起来像「密钥失效」的 403，而密钥其实是好的。
 *  这一格让「密钥属于哪个地址」能写进配置，不靠人每次记得。
 *
 *  仍然允许请求体覆盖：界面上换个地址临时试一下，比改配置重启容器快得多。 */
function endpointFor(body: RequestBody, fallback: string) {
  return body.endpoint?.trim() || (process.env as RuntimeEnv).ANALYZE_ENDPOINT?.trim() || fallback;
}
function jsonFrom(text: string) { const start = text.indexOf("{"); const end = text.lastIndexOf("}"); if (start < 0 || end < start) throw new Error("模型未返回可读取的 JSON"); return JSON.parse(text.slice(start, end + 1)); }
function responseText(payload: unknown) {
  const value = payload as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }>; choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>; content?: Array<{ text?: string }> };
  // 推理类模型经常把正文放在 reasoning_content，content 留空。兜住这种形状，否则解析出空串。
  return value.output_text || value.choices?.[0]?.message?.content || value.choices?.[0]?.message?.reasoning_content || value.content?.map(item => item.text || "").join("") || value.output?.flatMap(item => item.content || []).map(item => item.text || "").join("") || "";
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as RequestBody;
    // 模型名跟地址一样可以由服务端兜底。自建网关的模型清单和官方不同
    // （这台网关有 claude-sonnet-5，没有裸的 claude-sonnet-4-5），
    // 界面上的默认名对官方对、对网关就是 503 model_not_found。
    // 配了 ANALYZE_MODEL，界面留空也能用对的那个名字。
    const model = body.model?.trim() || (process.env as RuntimeEnv).ANALYZE_MODEL?.trim() || "";
    if (!body.provider || !model || !body.title || !body.evidence) return Response.json({ error: "模型、标题与原始依据均为必填项" }, { status: 400 });
    const apiKey = body.apiKey?.trim() || keyFor(body.provider);
    if (!apiKey) return Response.json({ error: "未发现该服务的会话密钥。请在模型连接器中粘贴本次会话使用的密钥。" }, { status: 400 });
    const userInput = `情报标题：${body.title}\n来源：${body.source}\n原始依据：${body.evidence}`;
    // 推理类模型冷启动可能要几十秒。不设显式超时的话，连接被中途掐断只会得到一个没有信息的 500。
    const timeoutMs = Number(process.env.ANALYZE_TIMEOUT_MS) || 120_000;
    const abort = AbortSignal.timeout(timeoutMs);
    let upstream: Response;
    if (body.provider === "anthropic") {
      upstream = await fetch(endpointFor(body, "https://api.anthropic.com/v1/messages"), { method: "POST", signal: abort, headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 1200, system: systemPrompt, messages: [{ role: "user", content: userInput }] }) });
    } else if (body.provider === "openai") {
      upstream = await fetch(endpointFor(body, "https://api.openai.com/v1/responses"), { method: "POST", signal: abort, headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, instructions: systemPrompt, input: userInput, text: { format: { type: "json_object" } }, store: false }) });
    } else {
      const endpoint = endpointFor(body, body.provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : "");
      if (!endpoint) return Response.json({ error: "兼容服务需要填写完整的 Chat Completions 地址" }, { status: 400 });
      upstream = await fetch(endpoint, { method: "POST", signal: abort, headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userInput }], response_format: { type: "json_object" }, temperature: 0.2 }) });
    }
    const raw = await upstream.text();
    if (!upstream.ok) return Response.json({ error: `模型服务返回 ${upstream.status}`, detail: raw.slice(0, 500) }, { status: 502 });
    // 解析失败要说清坏在哪一层，并带上上游原文片段。笼统的 500 会让人误以为是网关或密钥问题。
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { return Response.json({ error: "模型服务返回的不是 JSON", detail: raw.slice(0, 500) }, { status: 502 }); }
    const text = responseText(parsed);
    if (!text.trim()) return Response.json({ error: "模型返回了空正文", detail: raw.slice(0, 500) }, { status: 502 });
    let analysis: unknown;
    try { analysis = jsonFrom(text); }
    catch { return Response.json({ error: "模型正文里没有可读取的 JSON", detail: text.slice(0, 500) }, { status: 502 }); }
    return Response.json({ analysis, provider: body.provider, model, generatedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "模型分析失败";
    const aborted = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    console.error("[analyze] 失败：", error instanceof Error ? `${error.name}: ${message}` : message);
    if (aborted) return Response.json({ error: "模型分析超时。推理类模型首次调用可能要 30 秒以上，请重试；或在模型连接器里换一个更快的模型。" }, { status: 504 });
    return Response.json({ error: message }, { status: 500 });
  }
}
