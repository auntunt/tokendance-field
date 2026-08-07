// Phase 5 沙盘推演。给一个假设场景，让模型列出"若该场景成立，应能观察到什么信号"。
//
// 关键纪律：推演产物是假设，不是情报。这里在服务端就把每条候选钉死为
// origin=simulation，并在标题前缀 [推演]。前端写入时仍走 hypothesis + related，
// 所以它和管线候选一样结构性卡在第 5 道门——推演永远无法自己变成可执行的判断。
export const dynamic = "force-dynamic";

import { extractRelations, resolveExtractConfig } from "../../../lib/extractor";

type RequestBody = { scenario: string; model?: string; endpoint?: string; apiKey?: string };

export async function POST(request: Request) {
  try {
    const body = await request.json() as RequestBody;
    const scenario = String(body.scenario ?? "").trim();
    if (scenario.length < 15) return Response.json({ error: "场景描述太短，至少 15 字才推演得动" }, { status: 400 });

    const config = resolveExtractConfig(body);
    if (!config) return Response.json({ error: "推演器未配置（EXTRACT_ENDPOINT / EXTRACT_API_KEY / EXTRACT_MODEL）" }, { status: 400 });

    const raw = await extractRelations(scenario, { ...config, mode: "simulate", source: `沙盘推演：${scenario.slice(0, 60)}` });

    // 服务端强制打标，不信任前端也不信任模型
    const candidates = raw.map(candidate => ({
      ...candidate,
      title: candidate.title.startsWith("[推演]") ? candidate.title : `[推演] ${candidate.title}`,
      origin: "simulation" as const,
    }));

    return Response.json({ candidates, scenario, model: config.model, simulatedAt: new Date().toISOString(), notice: "推演产物是假设，不是情报。写入后仍为 0/6，必须找到真实来源才能过闸。" });
  } catch (error) {
    const detail = (error as { detail?: string }).detail;
    if (detail) return Response.json({ error: error instanceof Error ? error.message : "推演失败", detail }, { status: 502 });
    return Response.json({ error: error instanceof Error ? error.message : "推演失败" }, { status: 500 });
  }
}
