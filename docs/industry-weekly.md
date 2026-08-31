# 行业周报运行说明

行业周报只按行业每周运行一次，不按客户轮询。GitHub Actions 计划任务在每周一 01:00 UTC（北京时间 09:00）调用 Docker 生产服务的 `/api/cron/industry-weekly`；同一工作流支持手动立即运行。

当前生产结构是 Docker + SQLite volume，因此计划任务不能依赖 Vercel 的临时文件系统。仓库中的 `.github/workflows/industry-weekly.yml` 只负责调用接口，数据始终写入生产服务器的 `/data/fde-dossier.sqlite`。

生产镜像首次启动时会在该文件不存在的情况下写入广联达真实来源验收种子；已有文件永远保留。种子只提供客户、行业与档案基线，不包含历史周报，四周计时必须从真实 feed 和人工选择开始。

## 环境变量

| 名称 | 用途 |
|---|---|
| `CRON_SECRET` | 服务器验证计划任务请求所用的 Bearer 密钥 |
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

## GitHub Actions 配置

在 GitHub 仓库的 `Settings → Secrets and variables → Actions` 中添加：

| Secret | 内容 |
|---|---|
| `FIELD_BASE_URL` | 生产站点 HTTPS origin，例如 `https://www.field.tokendance.cool` |
| `FIELD_CRON_SECRET` | 与生产服务器 `.env` 中 `CRON_SECRET` 相同的随机密钥 |

部署新版本后，先在 `Actions → FDE industry weekly → Run workflow` 手动运行一次。运行结果必须返回 `ok: true` 和 `reportUrl`；之后才从首个真实周次开始累计四周验收。
