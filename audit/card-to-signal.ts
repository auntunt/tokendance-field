// 把「同行信息查找」的 65 张公司卡片映射成 Signal，交六道门实测过闸率。
//
// 这个文件的唯一职责是**忠实映射**：老数据有什么就填什么，没有的字段留空，
// 不代填、不推断、不给老数据打补丁。门砍掉多少是测量结果，不是可调参数。
//
// 映射对照表（老字段 → Signal 字段），每一条都要能说清依据：
//   narrative + deliverable + founder_detail + funding_detail → evidence
//   channel_label（发现渠道）                                  → source
//   sources[]（URL 列表）                                      → sourceUrl + sourceType 判定依据
//   city / macro_region                                        → scope.marketRegion
//   name                                                       → scope.entityScope（要过 classifyEntity）
//   【推测】/【待核】标记                                       → epistemicState
//   risk / edge_reason                                         → falsifier / counterEvidence
//   —— 无对应字段 ——                                            → scope.dataBasis（老数据没有口径）
//   —— 无对应字段 ——                                            → scope.ourAccess（老数据没有我方杠杆）
//   —— 无对应字段 ——                                            → validUntil（老数据没有有效期）
//   —— 无对应字段 ——                                            → signedOff（老数据无人签署）

import { gradeUrl, gradeSources } from "./source-grade.ts";

/** 判级委托给 source-grade.ts（按发布方类型判，不按知名度判）。 */
export const classifySourceUrl = gradeUrl;
export const aggregateSourceType = gradeSources;

/** 认识状态：从老数据的 【推测】/【待核】 标记读，不猜。 */
export function readEpistemicState(card) {
  const blob = [card.narrative, card.founder_detail, card.funding_detail, card.billing_raw, card.founder_raw].join(" ");
  if (/【待核实?】|待核/.test(blob)) return "hypothesis";
  if (/【推测】/.test(blob)) return "interpretation";
  return "observation";
}

/** 拼 evidence。只拼老数据已有的正文，不补写。 */
export function buildEvidence(card) {
  return [card.narrative, card.deliverable, card.founder_detail, card.funding_detail, card.filing]
    .map(v => String(v ?? "").trim()).filter(Boolean).join("；");
}

/** 单张卡片 → Signal seed。所有留空都是老数据真的没有，不是映射偷懒。 */
export function cardToSignal(card) {
  const agg = gradeSources(card.sources);
  // 证伪条件与反例：老数据里只有 risk / edge_reason 两个字段可能承载。
  // 绝大多数卡片为空——这正是要测量的东西，不代写。
  const falsifier = String(card.risk ?? "").trim();
  const counterEvidence = String(card.edge_reason ?? "").trim();
  return {
    id: `fde-${card.id}`,
    title: `${card.name}｜${card.sector_raw}`,
    evidence: buildEvidence(card),
    // 发现渠道就是老数据自报的来源。有 URL 的另填 sourceUrl。
    source: card.channel_raw || card.channel_label || "",
    sourceUrl: (card.sources ?? [])[0],
    origin: "import",
    constraints: {
      scope: {
        entityScope: card.name_raw || card.name || "",
        marketRegion: [card.city, card.macro_region].filter(Boolean).join(" / "),
        // 老数据无数据口径字段。★ 是印象分，不是口径，不能拿来充当。
        dataBasis: "",
        // 老数据有 survey_date（采集日），但没有"这个判断在哪段时间内有效"。
        timeWindow: "",
        // 老数据无我方行动杠杆字段。
        ourAccess: "",
      },
      epistemicState: readEpistemicState(card),
      falsifier,
      counterEvidence,
      sourceType: agg.type,
      // 老数据无有效期。
      validUntil: "",
      // 老数据的 ★ 星级：★★★★ → 80。这是把印象分照搬成概率，
      // 不是校准过的概率——正因如此它对过闸没有任何影响，只进 Brier。
      probability: card.confidence ? Math.round(card.confidence / 5 * 100) : 50,
      // 老数据无签署人。模型永不代签。
      signedOff: false,
    },
    _audit: { sourceGrades: agg.graded, confidenceStars: card.confidence, group: card.group, channel: card.channel_code },
  };
}
