# FIELD · FDE 客户档案

面向 FDE 进场前桌面研究的客户档案系统。Next.js 同时提供前端与 API，SQLite 保存带来源的客户、行业、组织、系统、事件和机会数据。

当前主链路是：`选择客户 → 采集法定文件/招聘/招投标/官网 → 固定 schema → 机会地图与进场准备 → HTML 档案 → 再次生成时显示变化`。入口为 `/dossier/<companyId>`；行业周报入口为 `/industry-weekly/<industryId>`。

旧研究与关系图模块为兼容保留，但不再由生产服务自动启动按公司轮询。

## 研究链路

主动查询统一走一条可审计链路：

`模糊问题 → 术语纠错 / 实体消歧 → 联网搜索 → 原链接安全抓取 → 正文与内容指纹落库 → 主张抽取 → 跨来源印证 → 与历史查询建立联系`

- 搜索通道按环境配置选择 Grok、OpenAI、Anthropic 或 Bing 回退；应用内部数据结构不依赖模型厂商。
- 外部网页一律被视为不可信数据。应用会拦截私网地址、逐跳检查重定向，并限制页面体积。
- 同一篇通稿出现在多个域名时标记为“同稿转载”，不算第二个独立来源。
- 查询通过主体、维度、共同来源和共同事实主张自动建立关系，供后续重复或相近查询复用。
- `/api/research` 提供只读的检索通道、来源、主张、交叉验证与查询关系概览。

详细边界与数据结构见 [`docs/research-pipeline.md`](docs/research-pipeline.md)。

## TypeScript 约束

项目的一方运行时代码、测试、审计工具、维护脚本和 ESLint 配置统一使用 TypeScript/TSX，不保留 JavaScript、JSX、MJS 或 CJS 源文件。`tsconfig.json` 对应用与正式运行脚本执行严格检查；`tsconfig.tools.json` 单独覆盖从早期 JavaScript 迁移来的审计、测试与离线工具，避免它们绕过类型检查。

```bash
npm run typecheck
npm run lint
npm test
```

`npm test` 只运行客户档案、周报、生产配置和 TypeScript 约束等关键冒烟检查，适合日常修改与 Pull Request。完整回归保留为 `npm run test:full`，只在合入 `main`、准备发布或从 Actions 手动触发时运行；生产镜像也采用同一发布级门槛。

PostCSS 配置放在 `package.json` 的 `postcss` 字段中，因为 Next.js 16 的配置发现逻辑不读取 `postcss.config.ts`。`package-lock.json` 中出现的 `.mjs` 字符串只是第三方包入口元数据，不是本项目的 JavaScript 源码。

## 生产结构

- 容器内端口：`8800`
- 服务器回环端口：`127.0.0.1:8021`
- 数据库：`/data/tokendance-field.sqlite`
- volume：`tokendance_field_data`
- 访问保护：HTTP Basic Auth，由 `.env` 中的 `FIELD_ACCESS_USER` 与 `FIELD_ACCESS_PASSWORD` 控制
- 健康检查：`/api/health`
- Nginx 模板：`nginx/www.field.tokendance.cool.conf`

## 构建与部署

```bash
DOCKER_BUILDKIT=1 docker buildx build --platform linux/amd64 -f Dockerfile.prod -t tokendance-field:latest --load .
docker save tokendance-field:latest | gzip > /tmp/tokendance-field.tar.gz
```

服务器端将 `docker-compose.prod.yml` 与 `.env` 放入同一目录，加载镜像后执行：

```bash
docker load -i /tmp/tokendance-field.tar.gz
docker compose -f docker-compose.prod.yml up -d field
curl -fsS http://127.0.0.1:8021/api/health
```

镜像在构建时会用真实公开来源样本生成广联达验收档案。首次启动、且 `/data/fde-dossier.sqlite` 不存在时才复制到 volume；后续启动和升级不会覆盖已经产生的档案、周报选择或 `DossierRun`。本机也可用 `npm run dossier:bootstrap -- /tmp/fde-dossier.sqlite` 单独生成并检查种子库，已有目标默认拒绝覆盖。

正式域名 `www.field.tokendance.cool` 由 Nginx 反代至 `http://127.0.0.1:8021`。不要把 8021 直接暴露到公网。

完整上线与首周验收步骤见 [`docs/production-rollout.md`](docs/production-rollout.md)。

验证结论已整理为可供后续开发团队直接执行的 [`FDE 客户档案后续开发 SOP`](docs/dossier-development-sop.md)，包含详细角色分工、单客户任务表、组织树与人物表规则、M0–M6 阶段门槛及 A1–A9 检查表。

## 行业周报

生产服务不启动旧的按公司调度器。M6 由 GitHub Actions 每周一北京时间 09:00 调用 Docker 服务的 `/api/cron/industry-weekly`，按行业列表页增量生成一页周报；也可在 Actions 页面手动立即运行。这样 SQLite 始终写入服务器上的持久化 volume，不依赖 Vercel 临时文件系统。

部署后需要在 GitHub 仓库 Actions secrets 中配置 `FIELD_BASE_URL`（例如 `https://www.field.tokendance.cool`）和 `FIELD_CRON_SECRET`；后者必须与服务器 `.env` 的 `CRON_SECRET` 完全一致。周报会记录 FDE 的真实选择时间，并显示连续四周、每周至少 3 条的运行验收进度；无目标客户的条目可在页面选择客户后写入档案。详细配置见 [`docs/industry-weekly.md`](docs/industry-weekly.md)。

以下是冻结保留的旧调度器规则，仅在显式调用旧手动接口时适用：

自动候选写入关系图前会经过 `lib/scheduler-policy.ts`：

- 优先法定披露和独立来源，拒绝无原文链接、搜索结果页与未核实来源；
- 必须有明确、未过时的事件日期和合法关系边；
- 按标准化后的关系主体去重，竞争关系调换方向仍视为同一条；
- 默认每批最多新增 4 条信号、6 条关系，整张图最多 48 条关系；
- 过期和历史信号全部保留；首页按事件/披露日期倒序展示，不按入库时间冒充“最新”。

开关、执行间隔与容量上限都在 `.env.example` 中。运行状态可通过登录后的 `/api/scheduler/status` 查看，也可以向 `/api/scheduler/run?limit=3` 发送 POST 手动触发一批。
