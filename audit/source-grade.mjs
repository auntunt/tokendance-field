// URL → 来源类型判级。判据是**发布方与被报道方是否同一**，不是网站有名没名。
//
// independent：发布方与被报道主体不同一，且发布方有独立核实动机或法定义务
//              （政府/交易所/招投标平台/第三方媒体/高校）
// related    ：发布方即被报道方，或内容由被报道方自填
//              （自家官网、企业自填数据库、招聘 JD、云市场店铺、协会会员名录）
// unknown    ：判不出发布方身份（公众号、无法归类的域名、残缺链接）
//
// 规则表按"结构可判"排序：先看 TLD/后缀这类不可伪装的结构证据，再看已知站点类型。
// 判不出的一律落 unknown——宁可说不知道，不许乐观归入 independent。

/** 结构性后缀：不可伪装，优先级最高。 */
const STRUCTURAL = [
  [/\.gov\.cn$|\.gov$/, "independent", "政府域名（行政备案/政府目录）"],
  [/\.edu\.cn$/, "independent", "高校域名（第三方，非企业自述）"],
];

/** 站点类型表。同一类型的判级理由必须一致。 */
const BY_TYPE = [
  // 法定披露与其转载：披露规则强制，最强来源
  ["independent", "法定披露/交易所转载", [
    "pdf.dfcfw.com", "notice.10jqka.com.cn", "xinsanban.eastmoney.com",
    "stock.finance.sina.com.cn", "cninfo.com.cn", "sse.com.cn", "szse.cn",
  ]],
  // 招投标平台：公告由采购人发布，非中标方自述
  ["independent", "招投标公告平台", [
    "ggzy.gov.cn", "zgggzy.com", "ccgp-ningxia.gov.cn", "qianlima.com",
    "bidcenter.com.cn", "jianyu360.cn", "gc-zb.com", "jrzb.cn",
    "xjygcg.com", "hbbidcloud.cn",
  ]],
  // 第三方媒体：发布方与被报道方不同一。通稿风险不在这门处理，在门 4。
  ["independent", "第三方媒体", [
    "36kr.com", "sohu.com", "163.com", "qq.com", "sina.com.cn", "sina.cn",
    "shobserver.com", "jfdaily.com", "thepaper.cn", "cb.com.cn", "xinhuanet.com",
    "news.cn", "stdaily.com", "eastmoney.com", "jrj.com.cn", "pedaily.cn",
    "iyiou.com", "donews.com", "ebrun.com", "oeeee.com", "nfnews.com", "xhby.net",
    "chinadaily.com.cn", "china.com", "chinapp.net.cn", "people.com.cn", "cctv.com",
    "cri.cn", "rednet.cn", "zhiding.cn", "mpaypass.com.cn", "foodmate.com.cn",
    "investorscn.com", "icloudnews.net", "shaqiu.cn", "pop136.com", "chinapost.com.cn",
    "jcaizz.com", "gssk.cn", "microbell.com", "zhiliaobiaoxun.com", "jiemian.com",
    "tidenews.com.cn", "iheima.com", "vcbeat.top", "xueqiu.com", "leiphone.com",
  ]],
  // 工商数据库：登记数据源自公示系统，但简介/融资栏企业可自填。混合来源，保守判 related。
  ["related", "工商数据库（含企业自填栏位）", [
    "qcc.com", "tianyancha.com", "aiqicha.baidu.com", "qixin.com",
    "qizhidao.com", "chacewang.com", "baike.baidu.com", "leshanvc.com",
  ]],
  // 创投数据库项目页：由项目方自行提交维护
  ["related", "创投库自填项目页", ["pitchhub.36kr.com", "data.iyiou.com"]],
  // 招聘站：JD 由企业自行撰写
  ["related", "招聘站 JD（企业自撰）", ["zhipin.com", "liepin.com", "zhaopin.com", "jobui.com"]],
  // 云市场/电商店铺：商品页由厂商自行上架
  ["related", "云市场/店铺自述", [
    "marketplace.huaweicloud.com", "startup.aliyun.com", "cloud.tencent.com",
    "ow.dingtalk.com", "1688.com",
  ]],
  // 行业协会：会员名录信息由会员单位报送
  ["related", "行业协会会员名录（会员报送）", [
    "aii-alliance.org", "zhinengxiehui.com", "czaiia.com", "saiia.org.cn",
    "ahnpo.cn", "szaicx.com", "smartcity.team",
  ]],
];

/** 公众号：发布主体无法从 URL 判定，可能就是该公司自己的号。 */
const OPAQUE = ["mp.weixin.qq.com", "zhuanlan.zhihu.com", "zhihu.com"];

function matchHost(host, list) {
  return list.some(h => host === h || host.endsWith(`.${h}`));
}

/** 子域名比父域名更具体，必须优先。否则 pitchhub.36kr.com（项目方自填）
 *  会先命中 36kr.com（第三方媒体）而被误判为 independent。 */
function bestMatch(host) {
  let best = null;
  for (const [type, reason, hosts] of BY_TYPE) {
    for (const h of hosts) {
      if (host !== h && !host.endsWith(`.${h}`)) continue;
      if (!best || h.length > best.h.length) best = { type, reason, h };
    }
  }
  return best;
}

export function gradeUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!/^https?:\/\/[^\s（）"']+$/.test(text)) return { type: "unknown", reason: "非可访问 URL（检索指引或残缺链接）" };
  let url;
  try { url = new URL(text); } catch { return { type: "unknown", reason: "URL 无法解析" }; }
  const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
  for (const [pattern, type, reason] of STRUCTURAL) if (pattern.test(url.hostname)) return { type, reason };
  if (matchHost(host, OPAQUE)) return { type: "unknown", reason: "自媒体平台，无法判定发布方是否为被报道方本身" };
  const hit = bestMatch(host);
  if (hit) return { type: hit.type, reason: hit.reason };
  // 剩下的：陌生域名。根路径几乎必是企业官网；深路径判不出。
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "" || path === "/index.html") return { type: "related", reason: "陌生域名根路径，判为企业自有官网" };
  return { type: "unknown", reason: "陌生域名，无法判定发布方与被报道方是否同一" };
}

/** 一张卡片的整体来源级别：取最强一条。全弱则整体弱。 */
export function gradeSources(sources) {
  const graded = (sources ?? []).map(gradeUrl);
  const type = graded.some(g => g.type === "independent") ? "independent"
    : graded.some(g => g.type === "related") ? "related" : "unknown";
  return { type, graded };
}
