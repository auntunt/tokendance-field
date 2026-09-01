# FDE 客户档案生产上线清单

这份清单用于把已经验证的镜像部署到现有 Docker + Nginx 环境，并正式开始 M6 四周运行验收。任何一步失败都不要开始计时。

## 1. 服务器环境

服务器 `.env` 至少需要：

| 配置 | 要求 |
|---|---|
| `FIELD_ACCESS_USER` / `FIELD_ACCESS_PASSWORD` | 现有站点登录凭据 |
| `DOSSIER_DB_PATH` | `/data/fde-dossier.sqlite` |
| `CRON_SECRET` | 单独生成的长随机值，不与登录密码复用 |
| `INDUSTRY_WEEKLY_INDUSTRY_ID` | `construction-digitalization` |
| `INDUSTRY_WEEKLY_FEED_URLS` | 你的中转体系提供的一个或多个 HTTPS JSON 列表地址 |

中转 JSON 必须符合 [`industry-weekly.md`](industry-weekly.md) 的字段要求，并且每个 `url` 指向原始列表页或详情页。不要把搜索结果摘要当来源。

中转层的官方来源范围见 [`relay-source-allowlist.md`](relay-source-allowlist.md)。配置生产环境前先校验真实 URL：

```sh
npm run production:check -- --file .env
```

该命令会拒绝示例占位值、非持久化路径、复用登录密码的 Cron 密钥、错误行业、非 HTTPS 中转地址，以及合计不足 3 条有效记录的真实 Feed。只检查配置形状、不请求 Feed 时可追加 `--skip-feed`。

## 2. 构建和部署

Pull Request 的 `Verify / code` 与 `Verify / production-image` 两项检查必须先通过；它们分别覆盖 TypeScript、测试、依赖审计、生产配置入口和 Linux/amd64 镜像。若仓库尚未启用分支保护，合并前也要在 PR 页面人工确认这两项为绿色。

在可信构建机上运行：

```bash
npm ci
npm run typecheck
npm run lint
npm test
DOCKER_BUILDKIT=1 docker buildx build --platform linux/amd64 -f Dockerfile.prod -t tokendance-field:latest --load .
docker save tokendance-field:latest | gzip > /tmp/tokendance-field.tar.gz
```

把镜像包、`docker-compose.prod.yml` 和服务器 `.env` 放到部署目录，然后执行：

```bash
docker load -i /tmp/tokendance-field.tar.gz
docker compose -f docker-compose.prod.yml up -d field
curl -fsS http://127.0.0.1:8021/api/health
```

首次启动只在数据库不存在时复制验收种子；如果 volume 已有数据库，镜像不会覆盖它。

## 3. 线上只读检查

登录后确认以下地址可打开：

- `/dossier/002410.SZ`：显示 1–10 章和来源链接。
- `/industry-weekly/construction-digitalization`：显示最近四个自然周的验收表。
- `/api/health`：返回 200。

## 4. GitHub Actions

先把 `acceptance-hardening` 合并到默认分支 `main`。GitHub 的定时任务只从默认分支读取工作流；分支未合并时，计划任务不会开始运行。

在仓库 Actions secrets 添加：

| Secret | 值 |
|---|---|
| `FIELD_BASE_URL` | `https://www.field.tokendance.cool` |
| `FIELD_CRON_SECRET` | 与服务器 `CRON_SECRET` 完全一致 |

进入 `Actions → FDE industry weekly → Run workflow` 手动运行一次。日志必须显示接口 HTTP 200、`ok: true` 和 `reportUrl`。之后每周一北京时间 09:00 自动运行。

## 5. 四周验收

每个自然周由 FDE 打开周报，阅读原始来源并选择至少 3 条真正有用的信息。按钮点击会保存实际选择时间并写入对应客户 `Event`；没有预设客户的条目必须先从同行业客户中选择。

每周完成后检查：

- 当周显示“3 / 3”或更多，状态为“达标”。
- 再次打开客户档案，第 6 章出现刚选择的记录。
- 连续四周后页面显示“四周运行验收已完成”。

在此之前，M6 只能标记为“代码通过，真实运行待验收”。
