# FIELD 联网研究与证据记忆

## 边界

模型负责提出搜索结果和来源 URL；应用负责权限、抓取、存储、去重、分级、抽取、验证和写入。网页正文、搜索摘要和模型输出都属于不可信数据，不能改变应用策略，也不能直接成为“已核实事实”。

第一版是只读研究代理：允许检索公开网页、读取公开链接和生成候选；候选写入判断账本后仍需经过既有六道门。系统不会因为模型给出引用就自动签署判断。

## Provider 适配

- `xai`：`POST /v1/responses` + `tools: [{ type: "web_search" }]`，读取 citations、annotations 与来源列表。
- `openai`：`POST /v1/responses` + `web_search`，请求包含 `web_search_call.action.sources`。
- `anthropic`：`POST /v1/messages` + `web_search_20250305`；需显式选择，避免复用已有密钥产生意外费用。
- `bing`：没有托管搜索密钥时的 HTML 回退；请求之间保留限流间隔。

Provider 输出统一为 `{ url, title, snippet, provider }`。后续流程不读取厂商专有响应。

## 数据模型

- `research_runs`：一次用户查询的状态、实体、维度、provider 和统计。
- `research_sources`：规范化 URL、域名、来源等级、正文、内容指纹、首次/最近出现时间。
- `research_run_sources`：某次查询为什么、以哪个搜索词找到某个来源。
- `research_claims`：抽取后的事实主张或关系边，使用稳定指纹跨查询复用。
- `research_claim_sources`：主张与原始来源的多对多关系。
- `research_query_links`：查询之间的实体、维度、来源和主张重叠。

## 交叉验证

“多源印证”必须同时满足：

1. 至少两个法定或独立来源；
2. 来源来自不同域名；
3. 原文内容指纹不同。

多个域名发布同一份正文时标记为“同稿转载”。这能保留传播轨迹，但不会提高事实可信度。

## 安全与可观测性

- 仅允许 HTTP/HTTPS；拒绝带凭据 URL、localhost、回环、链路本地和私网地址。
- DNS 解析和每一次重定向都重新检查目标地址。
- HTML 默认 500KB，PDF 默认 8MB；正文最多保存 120,000 字符。
- 每个搜索来源、抽取主张、查询关系均有稳定 ID，可从 SQLite 回放。
- API 密钥只从服务端环境读取，不写入研究记录，不返回给浏览器。

## 下一阶段

在真实查询样本积累后，再增加矛盾检测（相同主张、相反值）、来源时效评分、provider 成本与延迟记录，以及基于历史证据的增量查询计划。多代理拆分应等单一研究循环的评测证明有必要后再做。
