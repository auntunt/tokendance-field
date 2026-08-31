# 行业周报运行说明

行业周报只按行业每周运行一次，不按客户轮询。Vercel 计划任务在每周一 01:00 UTC（北京时间 09:00）调用 `/api/cron/industry-weekly`；同一路径也可以手动调用。

## 环境变量

| 名称 | 用途 |
|---|---|
| `CRON_SECRET` | Vercel 计划任务和手动调用的 Bearer 密钥 |
| `DOSSIER_DB_PATH` | 已生成的档案 SQLite 数据库路径 |
| `INDUSTRY_WEEKLY_INDUSTRY_ID` | 已存在于 `Industry` 表中的行业 ID |
| `INDUSTRY_WEEKLY_FEED_URLS` | 中转体系提供的 JSON 列表地址，多个地址用英文逗号分隔 |

中转接口返回 `items` 数组，每项包含 `date`、`kind`、`companyId`、`title`、`summary`、`url` 和 `sourceType`。`url` 必须指向原始列表页或详情页，而不是搜索结果摘要。

手动触发示例：

```sh
curl -H "Authorization: Bearer $CRON_SECRET" https://你的域名/api/cron/industry-weekly
```

接口返回 `reportUrl` 和四周运行验收进度。打开该地址可以查看一页周报：

- FDE 点击“选为有用信息”时，系统记录实际选择时间并写入对应客户的 `Event`。
- 没有预设目标客户的政策、同行或厂商条目，可先从同行业客户中选择一家公司。
- 页面按北京时间自然周显示最近四周的选择数；每周至少 3 条才算该周达标，连续四周后显示运行验收完成。
- 已经写入但没有选择时间的旧记录不会自动算入验收；FDE 必须重新点击“确认本周有用”，避免伪造历史周次。

下一次生成该客户档案时，第 6 章会自动出现已选择的记录。
