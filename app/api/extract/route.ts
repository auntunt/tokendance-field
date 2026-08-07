// 企业关系抽取端点。走 OpenAI 兼容的 Chat Completions（含公司 newapi 网关），
// 不依赖 Zep Cloud——MiroFish 的实体抽取在 Zep 服务端完成，本地跑不了，所以这里自建。
//
// 抽取逻辑在 lib/extractor.ts（纯函数，collect 和 simulate 直接复用，不经过 HTTP + Auth）。
// 输出边界：只产出"候选关系 + 原文引语"，不填任何约束门字段，
// 前端写入时强制 hypothesis + related，因此候选永远卡在第 5 道门。
export const dynamic = "force-dynamic";

import { extractRelations, resolveExtractConfig } from "../../../lib/extractor";

type RequestBody = { text: string; source: string; sourceUrl?: string; model?: string; endpoint?: string; apiKey?: string };

export async function POST(request: Request) {
  try {
    const body = await request.json() as RequestBody;
    const text = String(body.text ?? "").trim();
    const source = String(body.source ?? "").trim();
    if (text.length < 40) return Response.json({ error: "语料太短，至少 40 字" }, { status: 400 });
    if (!source) return Response.json({ error: "必须提供来源" }, { status: 400 });

    const config = resolveExtractConfig(body);
    if (!config) return Response.json({ error: "抽取器未配置。请设置 EXTRACT_ENDPOINT / EXTRACT_API_KEY / EXTRACT_MODEL 环境变量。" }, { status: 400 });

    const candidates = await extractRelations(text, { ...config, source, sourceUrl: String(body.sourceUrl ?? "").trim() || undefined });
    return Response.json({ candidates, model: config.model, extractedAt: new Date().toISOString() });
  } catch (error) {
    const detail = (error as { detail?: string }).detail;
    if (detail) return Response.json({ error: error instanceof Error ? error.message : "抽取失败", detail }, { status: 502 });
    return Response.json({ error: error instanceof Error ? error.message : "抽取失败" }, { status: 500 });
  }
}
