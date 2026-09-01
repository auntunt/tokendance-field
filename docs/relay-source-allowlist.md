# 中转层官方来源白名单

`INDUSTRY_WEEKLY_FEED_URLS` 接收的是中转体系输出的 HTTPS JSON，不是官网 HTML。本页列出中转搜索、抓取和交叉验证时应优先使用的官方入口；JSON 每条记录的 `url` 仍应指向实际详情页，而不是搜索结果页。

## 广联达

| 用途 | 官方入口 | 中转建议 |
|---|---|---|
| 公司公告与定期报告 | [投资者关系](https://www.glodon.com/investor.html) | 优先作为 `filing`；保留公告或报告详情页 URL |
| 产品、客户与产业动作 | [公司新闻](https://www.glodon.com/news.html) | 作为 `official`；只采集有明确发布日期和详情页的条目 |

当前生产验收行业 `construction-digitalization` 只应接收广联达、建筑数字化同行、相关政策和厂商动作。广联达目标条目使用 `companyId: "002410.SZ"`；行业政策或同行条目可以留空，由 FDE 选择同行业客户。

## 世纪互联 / VNET

| 用途 | 官方入口 | 中转建议 |
|---|---|---|
| 财报、重大合作与公司动作 | [VNET Press Releases](https://ir.vnet.com/news-events/press-releases/) | 作为 `official` 或 `filing`；优先保留 IR 详情页 |
| 官方订阅入口 | [VNET RSS News Feeds](https://ir.vnet.com/rss-news-feeds) | 中转层可订阅 RSS；最终仍输出统一 JSON |
| 法定披露 | [VNET SEC Filings](https://ir.vnet.com/financial-information/sec-filings) | 作为 `filing`；保留具体 6-K、20-F 等详情页 |

VNET 属于数据中心 / 云基础设施，不应混入 `construction-digitalization`。启用周报前应先建立独立 Industry、Company 和行业级定时任务。

## 北京人力 FESCO

| 用途 | 官方入口 | 中转建议 |
|---|---|---|
| 公司与产品动态 | [FESCO 公司新闻](https://www.fesco.com.cn/zxzx_gsxw.html) | 作为 `official`；保留 `newsDetails.html?id=...` 详情页 |

FESCO 属于人力资源服务，不应混入 `construction-digitalization`。政策信息还应从人社部门、国务院或地方政府原始页面交叉验证；转载稿不能替代政策原文。

## 中转输出约束

- 搜索模型只负责发现候选；中转层必须打开原文并输出实际详情页 URL。
- 同一事实若只有一份来源，可以入库但不能描述为“已交叉验证”。
- 公司自述与法定披露冲突时，以交易所、监管机构或正式公告为高优先级证据，并保留冲突记录。
- 每条必须包含 `date`、`kind`、`title`、`summary`、`url`、`sourceType`；有明确目标客户时再写 `companyId`。
- `kind` 只能是 `peer_case`、`procurement`、`policy`、`vendor_move`、`target_action`。
- `sourceType` 只能是 `filing`、`official`、`third_party`。

拿到中转 URL 后先在本地验收：

```sh
npm run industry:validate-feed -- construction-digitalization https://relay.example.com/glodon-weekly.json
```

返回 `ok: true`、至少 3 条有效记录、HTTPS 原始来源，并且行业归属正确后，才可以写入生产环境变量。
