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

接口返回 `reportUrl`。打开该地址可以查看一页周报，并把带目标客户的条目写入 `Event`；下一次生成该客户档案时，第 6 章会自动出现这条记录。
