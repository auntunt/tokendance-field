// 法定披露的取件层：只负责「把原文拿到手」，不负责理解它。
//
// 为什么单独一层：抽取规则会一直改（版面千变万化），但「去哪儿取、怎么取到」
// 是稳定的。混在一起的话，每次调正则都要重新跑网络请求，几分钟一轮。
// 分开之后原文落盘缓存，抽取可以离线反复迭代——实际调试时这个差别是几十倍。
//
// ============ 三个源，各自的可达性 ============
// 巨潮（A股年报）、SEC EDGAR（美股 10-K / DEF 14A）、港交所披露易 hkexnews（港股年报），
// 三条都实测过「普通 fetch 就能拿到全文」。
//
// 上交所仍然走不通：阿里云盾对 PDF 直链做二次验证（页面内 fetch / 带 cookie /
// 先导航挑战三种办法都失败过）。好在 A 股年报在巨潮上是全的，不缺这一条。
//
// 港股这条曾经被我判成「要过 JS 挑战」，那个判断是错的，这里记下正确的路，
// 免得下次又绕回去：
//   1. 别用 titleSearchServlet.do —— 它只支持 GET（POST 返回 405），而且它是
//      「加载更多」接口，忽略 from/to 和分类参数，永远返回最近 3 条。
//   2. 入口是 titlesearch.xhtml（HTML 页面本身），它认全部筛选参数。
//   3. 分类码不要猜。站点自己在 /ncms/eds/titlesearch/config.js 里公布了
//      TierOneUrl / TierTwoUrl，顺着取 /ncms/script/eds/tiertwo_e.json，
//      里面写着年报的权威取值：t1code=40000, t2code=40100, t2Gcode=-1。
//      早期一直 recordCnt=0 就是因为 t2Gcode 填了 -2。
//   4. 日期格式是紧凑的 YYYYMMDD（见站点 titlesearch.js 的 preprocessMainForm，
//      它把用户输入里的斜杠全 replace 掉）。
//   5. 代码 → stockId 要先过 prefix.do，跟巨潮要先查 orgId 是一样的道理。
//
// 边界：这一层不碰任何「判断」。它返回文本和 URL，级别（statutory）由抽取层给，
// 因为级别的依据是「这份文件是什么」，而不是「我从哪儿下载的」。

import { pdfToText } from "./pdf-text";

const CNINFO_QUERY = "https://www.cninfo.com.cn/new/hisAnnouncement/query";
const CNINFO_SEARCH = "https://www.cninfo.com.cn/new/information/topSearch/query";
const CNINFO_STATIC = "https://static.cninfo.com.cn/";

/** SEC 要求 User-Agent 里带可联系到人的标识，否则会 403。
 *  这是它明文写在 developer 页上的规则，不是反爬绕过。 */
const SEC_UA = "intel-engine-field/1.0 (FDE market research; contact via repo owner)";

export type Filing = {
  /** 文件标题，如「2025年年度报告」。会成为报告里的 source 字段。 */
  title: string;
  /** 披露日期 YYYY-MM-DD。 */
  date: string;
  /** 可点开核对的原始 URL。报告里每条事实都要能点回这里。 */
  url: string;
  /** 纯文本正文。 */
  text: string;
};

async function postForm(url: string, body: Record<string, string>, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.cninfo.com.cn/new/index",
      },
      body: new URLSearchParams(body).toString(),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 股票代码 → 巨潮内部 orgId。
 *
 *  为什么必须先查：hisAnnouncement 的 stock 参数要求 `代码,orgId` 两段，
 *  只给代码会静默返回 0 条（实测踩过——看起来像「这家公司没有年报」，
 *  其实是参数不全）。orgId 深市是纯数字、沪市是 gssh 前缀，没法拼，只能查。 */
export async function resolveOrgId(ticker: string): Promise<{ code: string; orgId: string; name: string } | null> {
  const code = ticker.replace(/\.(SH|SZ|SS)$/i, "");
  const hits = (await postForm(CNINFO_SEARCH, { keyWord: code, maxNum: "10" })) as Array<{
    code: string; orgId: string; zwjc: string; category: string;
  }>;
  const hit = hits?.find(item => item.code === code) ?? hits?.[0];
  return hit ? { code: hit.code, orgId: hit.orgId, name: hit.zwjc } : null;
}

/** 取最近一份年报正文（A股）。
 *
 *  只要「年度报告」，不要「摘要」和「英文简版」：摘要把股东表和员工构成
 *  整段删掉了，正是我们最缺的两个维度；英文版是翻译件，引语回原文核对时对不上。 */
export async function fetchLatestAnnualReport(ticker: string): Promise<Filing | null> {
  const org = await resolveOrgId(ticker);
  if (!org) return null;

  const today = new Date().toISOString().slice(0, 10);
  const from = `${new Date().getFullYear() - 2}-01-01`;
  const result = (await postForm(CNINFO_QUERY, {
    pageNum: "1", pageSize: "30", tabName: "fulltext",
    // column 实测对结果没影响（沪深两个值返回同一份列表），固定给 szse。
    column: "szse",
    stock: `${org.code},${org.orgId}`,
    category: "category_ndbg_szsh",
    seDate: `${from}~${today}`,
    isHLtitle: "true",
  })) as { announcements?: Array<{ announcementTitle: string; announcementTime: number; adjunctUrl: string }> };

  const candidates = (result.announcements ?? []).filter(item => {
    const title = item.announcementTitle.replace(/<[^>]+>/g, "");
    return /年度报告/.test(title) && !/摘要|英文|已取消|取消/.test(title);
  });
  if (!candidates.length) return null;

  // 按披露时间取最新一份。
  candidates.sort((a, b) => b.announcementTime - a.announcementTime);
  const picked = candidates[0];
  const url = CNINFO_STATIC + picked.adjunctUrl;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.cninfo.com.cn/" } });
  if (!response.ok) throw new Error(`下载年报失败 HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // -layout 是必须的：默认流式输出会把股东表的公司名和它那一行的数字拆开
  // （实测「中国移动通信有限公司」和它的持股比例中间隔了 40 行），
  // 抽取时无法对应。pdfToText 内部已经带 -layout。
  const text = await pdfToText(bytes);

  return {
    title: picked.announcementTitle.replace(/<[^>]+>/g, ""),
    date: new Date(picked.announcementTime).toISOString().slice(0, 10),
    url,
    text,
  };
}

/** 取最近一份 10-K 正文（美股）。EDGAR 返回 HTML，就地转文本。 */
export async function fetchLatest10K(cik: string): Promise<Filing | null> {
  const padded = cik.replace(/\D/g, "").padStart(10, "0");
  const listResponse = await fetch(`https://data.sec.gov/submissions/CIK${padded}.json`, {
    headers: { "User-Agent": SEC_UA },
  });
  if (!listResponse.ok) throw new Error(`EDGAR 列表失败 HTTP ${listResponse.status}`);
  const data = (await listResponse.json()) as {
    filings: { recent: { form: string[]; filingDate: string[]; accessionNumber: string[]; primaryDocument: string[] } };
  };
  const recent = data.filings.recent;
  const index = recent.form.findIndex(form => form === "10-K");
  if (index < 0) return null;

  const accession = recent.accessionNumber[index].replace(/-/g, "");
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(padded)}/${accession}/${recent.primaryDocument[index]}`;
  const docResponse = await fetch(url, { headers: { "User-Agent": SEC_UA } });
  if (!docResponse.ok) throw new Error(`10-K 下载失败 HTTP ${docResponse.status}`);
  return {
    title: `10-K (FY ending ${recent.primaryDocument[index].match(/\d{8}/)?.[0] ?? "unknown"})`,
    date: recent.filingDate[index],
    url,
    text: htmlToPlain(await docResponse.text()),
  };
}

/** HTML → 纯文本。只做够用的清理：删脚本样式、去标签、合空白。
 *  不追求还原版面——10-K 的关键句子都在行内散文里，表格数字这一版不抽。 */
export function htmlToPlain(raw: string): string {
  return raw
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============ 港股：披露易 hkexnews ============

const HKEX_CODE_LOOKUP = "https://www1.hkexnews.hk/search/prefix.do";
const HKEX_TITLE_SEARCH = "https://www1.hkexnews.hk/search/titlesearch.xhtml";
const HKEX_HOST = "https://www1.hkexnews.hk";

/** 港股代码 → 披露易内部 stockId。
 *
 *  跟巨潮的 orgId 是同一类问题：titlesearch 认的是 stockId，不是 0354 这种股票代码。
 *  name 参数要 5 位补零（0354 → 00354），实测不补零查不到。
 *  返回的 stockId 没有规律（00020→1000127397 而 00268→9332），只能查不能拼。 */
export async function resolveHkStockId(ticker: string): Promise<{ code: string; stockId: string } | null> {
  const code = ticker.replace(/\.HK$/i, "").replace(/\D/g, "").padStart(5, "0");
  const url = `${HKEX_CODE_LOOKUP}?callback=cb&lang=EN&type=A&name=${code}&market=SEHK`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: `${HKEX_HOST}/search/titlesearch.xhtml` },
  });
  if (!response.ok) return null;
  const raw = await response.text();
  // 响应是 JSONP：cb({...})。剥掉回调壳再解析。
  const inner = raw.replace(/^[^(]*\(/, "").replace(/\);?\s*$/, "");
  let parsed: { stockInfo?: Array<{ stockId?: number | string; code?: string }> };
  try {
    parsed = JSON.parse(inner) as typeof parsed;
  } catch {
    return null;
  }
  const wanted = (parsed.stockInfo ?? []).find(
    item => String(item.code ?? "").padStart(5, "0") === code,
  );
  const hit = wanted ?? parsed.stockInfo?.[0];
  const stockId = hit?.stockId;
  return stockId === undefined || stockId === null ? null : { code, stockId: String(stockId) };
}

/**
 * 从检索结果页里挑出最新一份年报。
 *
 * 单独导出是为了能用离线 fixture 测——这段是纯字符串处理，
 * 不该为了测它去打一次网络请求。
 *
 * 只认 /listedco/listconews/ 下的 .pdf：结果页里还有导航和分享链接，
 * 按 href 形状筛比按位置筛稳。日期从 href 里的 /YYYY/MMDD/ 段取，
 * 因为结果页的日期单元格里混着 &nbsp; 和换行，比 href 难解。
 */
export function pickHkAnnualReport(html: string): { title: string; date: string; href: string } | null {
  const rows: Array<{ title: string; date: string; href: string }> = [];
  const pattern = /<a[^>]+href="([^"]*\/listedco\/listconews\/[^"]*\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const href = match[1].replace(/&amp;/g, "&");
    const title = htmlToPlain(match[2]).replace(/\s+/g, " ").trim();
    // href 形如 /listedco/listconews/sehk/2026/0427/2026042700722.pdf
    const stamp = href.match(/\/(\d{4})\/(\d{2})(\d{2})\//);
    if (!stamp || !title) continue;
    rows.push({ title, date: `${stamp[1]}-${stamp[2]}-${stamp[3]}`, href });
  }
  if (!rows.length) return null;
  // 排除「摘要 / 补充 / 更正」这类附件，理由同 A 股：正文才有完整股东表。
  const full = rows.filter(row => !/summary|supplement|errat|amend|corrigend/i.test(row.title));
  const pool = full.length ? full : rows;
  pool.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return pool[0];
}

/** 取最近一份年报正文（港股）。
 *
 *  参数取值的来源见文件头注释——都是站点自己公布的配置，不是猜的：
 *  t1code=40000（Financial Statements/ESG）、t2code=40100（Annual Report）、t2Gcode=-1。
 *  日期是紧凑 YYYYMMDD。
 *
 *  为什么只要 Annual Report、不要中期报告：主要股东表（SFO 第XV部第2、3分部，
 *  按第336条存置的登记册）在年报《董事会报告》里是完整一张表，中期报告经常只给变动。 */
export async function fetchLatestHkAnnualReport(ticker: string): Promise<Filing | null> {
  const resolved = await resolveHkStockId(ticker);
  if (!resolved) return null;

  const now = new Date();
  const to = now.toISOString().slice(0, 10).replace(/-/g, "");
  const from = `${now.getFullYear() - 2}0101`;
  const params = new URLSearchParams({
    lang: "en",
    category: "0",
    market: "SEHK",
    searchType: "1",
    documentType: "-1",
    t1code: "40000",
    t2Gcode: "-1",
    t2code: "40100",
    stockId: resolved.stockId,
    from,
    to,
    "MB-Daterange": "0",
    title: "",
  });
  const searchUrl = `${HKEX_TITLE_SEARCH}?${params.toString()}`;
  const listResponse = await fetch(searchUrl, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: `${HKEX_HOST}/search/titlesearch.xhtml` },
  });
  if (!listResponse.ok) throw new Error(`披露易检索失败 HTTP ${listResponse.status}`);
  const picked = pickHkAnnualReport(await listResponse.text());
  if (!picked) return null;

  const url = picked.href.startsWith("http") ? picked.href : HKEX_HOST + picked.href;
  const fileResponse = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: searchUrl } });
  if (!fileResponse.ok) throw new Error(`港股年报下载失败 HTTP ${fileResponse.status}`);
  const bytes = new Uint8Array(await fileResponse.arrayBuffer());
  // 跟 A 股同理，-layout 是必须的：主要股东表全靠列对齐才能把名字和比例配上。
  const text = await pdfToText(bytes);

  return { title: picked.title, date: picked.date, url, text };
}

// ============ 美股：DEF 14A（股东表在委托书里，不在 10-K 里） ============

/** 取最近一份 DEF 14A（美股委托书）。
 *
 *  为什么股东数据走 DEF 14A 而不是 13F：
 *  13F 是**持有方**（机构）申报的持仓，要凑齐一家公司的股东得把全市场 13F 反查一遍，
 *  而且只覆盖机构。DEF 14A 的 beneficial ownership 表是**发行人**申报的，
 *  口径方向跟 A 股「十大流通股东」一致（都是发行人视角的一张横截面），
 *  而且 5% 以上股东和董事高管都在同一张表里。
 *
 *  注意这里刻意**不**走 htmlToPlain：那个函数把标签全删掉，表格会塌成一串数字，
 *  名字和比例再也配不上。表格解析在 lib/holder-tables.ts 里另走一条路。 */
export async function fetchLatestProxy(cik: string): Promise<Filing | null> {
  const padded = cik.replace(/\D/g, "").padStart(10, "0");
  const listResponse = await fetch(`https://data.sec.gov/submissions/CIK${padded}.json`, {
    headers: { "User-Agent": SEC_UA },
  });
  if (!listResponse.ok) throw new Error(`EDGAR 列表失败 HTTP ${listResponse.status}`);
  const data = (await listResponse.json()) as {
    filings: { recent: { form: string[]; filingDate: string[]; accessionNumber: string[]; primaryDocument: string[] } };
  };
  const recent = data.filings.recent;
  // DEF 14A 是正式委托书；DEFA14A 是补充材料（没有股东表），必须精确匹配。
  const index = recent.form.findIndex(form => form === "DEF 14A");
  if (index < 0) return null;

  const accession = recent.accessionNumber[index].replace(/-/g, "");
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(padded)}/${accession}/${recent.primaryDocument[index]}`;
  const docResponse = await fetch(url, { headers: { "User-Agent": SEC_UA } });
  if (!docResponse.ok) throw new Error(`DEF 14A 下载失败 HTTP ${docResponse.status}`);
  return {
    title: `DEF 14A (filed ${recent.filingDate[index]})`,
    date: recent.filingDate[index],
    url,
    // 原始 HTML 原样返回，表格结构留给 holder-tables.ts。
    text: await docResponse.text(),
  };
}
