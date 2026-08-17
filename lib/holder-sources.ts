// 股东数据取件层：只负责把东方财富 F10「十大流通股东」接口的原始 JSON 拿回来，不做任何判断。
//
// 为什么单独开一个文件，而不塞进 filing-sources.ts：
// filing-sources.ts 取的是「法定披露原文」（巨潮年报 PDF、SEC 10-K），拿回来的是 text；
// 这里取的是第三方聚合站的结构化 JSON，性质完全不同。混在一个文件里，
// 早晚会有人顺手把这里的东西也按 statutory 定级——那是本项目最怕的错。
// 分开放，文件名本身就是提醒：这不是原文，是二手结构化数据。
//
// 踩过的坑（都写进代码约束里了）：
// 1. 不带 END_DATE 过滤时，接口一次返回 100 行 = 10 个报告期 × 10 名股东，
//    每期都有 HOLDER_RANK=1。直接遍历会看到十个「第一大股东」，像是重复数据。
//    所以取件层原样返回全部行，由抽取层按 END_DATE 分组取最新期——
//    取件层不筛，是为了让缓存里留着完整原文，事后能复核我们挑的是哪一期。
// 2. 不带 User-Agent 会被挡。
// 3. 这个接口没有官方文档，字段随时可能变。所以取件层不碰字段语义，
//    只检查「result.data 是不是数组」，其余交给抽取层去容错。

export type HolderRow = Record<string, unknown>;

export type HolderFetch = {
  /** 交易所后缀格式，例如 301236.SZ；原样来自调用方，用于拼 filter */
  secucode: string;
  /** 可核对的接口 URL（含 filter），报告里作为出处链接 */
  url: string;
  /** 接口返回的全部行，未按报告期筛选 */
  rows: HolderRow[];
};

const API_BASE = "https://datacenter-web.eastmoney.com/api/data/v1/get";

/**
 * 拼出接口 URL。单独抽出来是因为三个地方都要用同一个串：
 * 真正发请求、写进 Sourced.sourceUrl、以及 --cache-only 时复原出处。
 * 三处各拼一遍必然会漂——报告里的链接点开跟我们真抓的不是同一个查询，最难查。
 */
export function holderApiUrl(secucode: string): string {
  const params = new URLSearchParams({
    reportName: "RPT_F10_EH_FREEHOLDERS",
    columns: "ALL",
    filter: `(SECUCODE="${secucode}")`,
    pageSize: "100",
    sortColumns: "END_DATE",
    sortTypes: "-1",
    source: "WEB",
    client: "WEB",
  });
  return `${API_BASE}?${params.toString()}`;
}

/**
 * A 股 ticker（002230.SZ 这种）已经是接口要的格式，这里只做规范化：
 * 去空格、后缀大写。roster 里手写的 ticker 大小写不统一过。
 */
export function toSecucode(ticker: string): string | null {
  const trimmed = ticker.trim().toUpperCase();
  return /^\d{6}\.(SZ|SH|BJ)$/.test(trimmed) ? trimmed : null;
}

/**
 * 把接口响应体（已 JSON.parse）里的行数组取出来。
 * 单独暴露是为了让测试和 --cache-only 走同一条解析路径：
 * 缓存里存的是原始响应体，离线重跑必须跟在线抓走完全相同的解析逻辑，
 * 否则「离线能过、在线炸」这种问题根本测不出来。
 */
export function rowsOfResponse(body: unknown): HolderRow[] {
  if (!body || typeof body !== "object") return [];
  const result = (body as { result?: unknown }).result;
  if (!result || typeof result !== "object") return [];
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.filter((row): row is HolderRow => !!row && typeof row === "object");
}

export async function fetchHolders(secucode: string, timeoutMs = 20000): Promise<HolderFetch | null> {
  const url = holderApiUrl(secucode);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        // 缺 UA 直接被挡，不是 403 而是空 body，排查过一次
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json, text/plain, */*",
        Referer: "https://data.eastmoney.com/",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = JSON.parse(await res.text()) as unknown;
    const rows = rowsOfResponse(body);
    if (rows.length === 0) return null;
    return { secucode, url, rows };
  } catch {
    // 取件层不吞掉错误细节以外的东西：抓不到就返回 null，
    // 由上层记进 failures。绝不返回空壳让抽取层去「猜」。
    return null;
  } finally {
    clearTimeout(timer);
  }
}
