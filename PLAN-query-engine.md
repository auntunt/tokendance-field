# 方案：本体论驱动情报引擎

> 授权：「可以大规模修改。现在的需求才是真的要的东西。」  
> 验收基准：世纪互联 + OPC→OCP case（实体消歧 × 术语纠错 × 分级三点同时踩到）

---

## 核心思路

把现有的 FDE 专项工具泛化成一个**通用情报引擎**：
- FDE 231 家降格为第一个「监控集实例」，不再是产品本身
- 产品是：任意实体 × 任意维度 → 分级 Sourced 事实

两条入口共用同一本体（`lib/ontology.ts` 的关系维度 + `lib/fde-dimensions.ts` 的事实维度）：

```
主动路径   模糊片段 → 术语纠错 → 实体消歧 → 维度路由 → 搜索采集 → 分级输出 → acceptCandidates
自动路径   历史请求 → 派生监控集 → 定期重跑 → 差异呈现
```

---

## 1. 主动路径（Active Query）

### 1a. 新文件：`lib/query-intake.ts`

纯函数层，不联网，不调模型。三件事：

**术语纠错 `correctTerms(fragment)`**

维护一张人工校正表（`TERM_CORRECTIONS`），条目形如：

```ts
{ wrong: /\bopc\b/i, right: "OCP", note: "Open Compute Project（开放计算项目）" },
{ wrong: /\boci\b/i, right: "OCI", note: "Oracle Cloud Infrastructure" },
```

外加编辑距离 ≤ 2 的模糊匹配（针对拼写错误），返回：
```ts
type TermCorrection = { original: string; corrected: string; note: string }
type CorrectionResult = { fragment: string; corrections: TermCorrection[]; changed: boolean }
```
UI 用这个在确认步骤里显示「检测到可能有误：OPC → OCP」。

**实体消歧 `disambiguateEntity(name)`**

先用 `classifyEntity`（已有，`lib/extractor.ts`）做实体类型分类，再查本地模糊索引：
- 从 `lib/fde-roster.ts` 和历史查询缓存（SQLite `query_entities` 表）中找相近的法人名
- 相似度：双字符重叠（bigram Jaccard）≥ 0.4 视为候选
- 返回候选列表让 UI 展示，用户选一个（或手动输入）

```ts
type EntityCandidate = { id: string; name: string; legalName?: string; similarity: number; source: "roster" | "cache" }
type DisambiguationResult = { query: string; kind: EntityKind; candidates: EntityCandidate[] }
```

为什么用 bigram 不用 LLM：
- 「世纪互联」vs「世纪互联数据中心有限公司」vs「北京世纪互联宽带数据中心有限公司」这类问题，字符重叠足够解决
- 纯函数保证确定性，不影响报告 byte-comparable 要求

**维度路由 `routeToDimensions(entity, rawFragment)`**

把输入片段映射到 `lib/fde-dimensions.ts` 的 6 个维度：
- 关键词匹配（「股东」「持股」→ shareholders；「产品」「卖」→ business；「OCP」「数据中心」→ fde/business）
- 默认路由：返回实体类型相关的前 N 个维度（上市公司默认 shareholders + fde；创业公司默认 funding + team）
- 返回 `RoutedDimension[]`，每条带「为什么路由到这里」（给 UI 显示）

### 1b. 新文件：`app/api/query/route.ts`

POST `/api/query`，请求体：
```ts
{ fragment: string; entityId?: string; dimensions?: DimensionId[]; force?: boolean }
```

流程：
1. `correctTerms(fragment)` → 若有纠错且 `entityId` 未提供，先返回 `{ needsConfirmation: true, corrections, candidates }` 让 UI 展示确认步骤
2. `disambiguateEntity(corrected)` → 候选实体列表（若 `entityId` 已提供则跳过）
3. `routeToDimensions(entity, corrected)` → 目标维度
4. 构建搜索词组合（实体名 × 维度关键词 × 最多 3 组），调 Bing search via `fetch` with browser UA（复用已验证的方案）
5. 对每条搜索结果 URL：调 `/api/collect`（内部调用，复用 SSRF 防御 + 去重 + 抽取）
6. 把 `ExtractedCandidate[]` 转成 `Candidate[]`，每条附上 `gradeOfUrl` 分级和来源说明
7. 写入 `query_log` 表（用于后续监控集派生）
8. 返回 `{ entity, corrections, dimensions, candidates, grade_summary }`

注意：维持现有「去重在模型调用之前」的契约（`corpusFingerprint` / `priorSightings`）。

### 1c. UI：`app/console/query-intake.tsx` + 修改 `signal-console.tsx`

Intake 组件增加第四种模式 `"query"`，UI 流程分三步：

**第一步：输入**
```
[ 搜索情报... ] [查]
```
输入框支持模糊，placeholder 示例：「世纪互联最近在搞什么」「广联达控股 上市 最新动态」

**第二步：确认（有纠错/消歧时出现）**
```
术语纠错：OPC → OCP（开放计算项目）[接受 / 忽略]
识别实体：世纪互联数据中心有限公司 · 北京世纪互联宽带数据中心有限公司 [选择]
维度路由：fde（数据中心 + OCP 关键词）/ business（产品线）[可调整]
[开始查询]
```

**第三步：结果**
候选卡，和现有 paste/url 模式出来的卡一致——都走 `acceptCandidates`，不绕过六道门，不建第二套流程。

---

## 2. 自动化路径（Monitor Set）

### 2a. 新文件：`lib/monitor-set.ts`

```ts
type MonitorEntry = {
  id: string;
  entityId: string;          // 指向 CompanyProfile.id 或 roster entry
  entityName: string;
  dimensions: DimensionId[]; // 要盯哪几个维度
  keywords: string[];        // 额外关键词（用户指定或从历史查询抽取）
  lastRunAt?: string;
  addedFrom: "manual" | "query-history" | "keyword";
  createdAt: string;
};

type MonitorSet = { entries: MonitorEntry[]; generatedAt: string };
```

核心函数：
- `deriveFromQueryLog(db) → MonitorEntry[]`：从 `query_log` 里把同一个实体查过 ≥ 2 次的自动加入监控集
- `addManual(entry)` / `removeEntry(id)` / `listActive()`
- `buildSearchPlan(entry) → SearchTask[]`：生成搜索词组合，供定期重跑用

存储：SQLite `monitor_entries` 表（和 `workspace` 同库），不写 `evidence_records`（遵守报告层不过门的隔离）。

### 2b. 新文件：`app/api/monitor/route.ts`

GET `/api/monitor` — 列出当前监控集 + 上次运行摘要  
POST `/api/monitor` — 触发一次重跑（或接收外部 cron 调用）  
PUT `/api/monitor/:id` — 修改监控条目（加关键词、暂停）  
DELETE `/api/monitor/:id` — 移除条目

重跑逻辑：
1. 取 `listActive()` 所有条目
2. 对每条：和 `/api/query` 主动路径复用同一个搜索+抽取链
3. 新抓到的候选 → 走 `diffProfiles` 产出 `Change[]`
4. 写入 `monitor_runs` 日志（runAt / entityId / changesCount / topChanges）
5. 返回摘要；重大变更（新增法定披露事实 / grade 上升）标记为优先

### 2c. UI：在 signal-console.tsx 的「收集」段增加「监控集」子视图

```
[粘贴语料] [抓链接] [查情报★] [私有] | [监控集]
```

「监控集」标签页：
- 列出所有监控条目，显示「上次更新 / 发现 N 条新情报」
- 「+ 从本次查询加入」按钮（在主动查询结果页也有）
- 「立即重跑」按钮
- 条目来源标签：手动 / 从查询历史派生 / 关键词触发

---

## 3. 口径修复（随大改一起做，顺序从最小到最大）

这四项并不是新功能，是数据质量债。主动路径的搜索引擎采集会把 relay 比例进一步拉高，所以 #2 最紧迫。

**修复 #1：`publishedAt`（独立，5 行改动）**  
`lib/fde-dimensions.ts` 的 `Sourced<T>` 加可选字段 `publishedAt?: string`，`report-html.ts` 渲染时优先显示 `publishedAt`，无则显示 `fetchedAt`。ICD 206 要求。

**修复 #2：relay 字段（最紧迫，影响前页「够硬」%）**  
`lib/fde-dimensions.ts` 的 `Sourced<T>` 加 `relay?: { originalSource: string; originalUrl?: string; marker: string }`。  
`lib/corpus-import.ts` 的 `gradeOfUrl` 之后加一道 `detectRelay(text, host)` 检测：
- 通稿标记：「企业供稿」「来源：XX公司」「供图」「编辑：」无「记者：」、「据XX介绍」
- Shingle 相似度：调已有 `lib/normalize-text.ts` + `lib/dedup.ts`，60% 以上重叠视为转载
- 命中则降一级并填 `relay`，保留原 `grade` 在 `relay.originalSource` 里

前页「够硬（法定+三方）」重新计算后会下降，这是正确的，要在 UI 里加一行注释说明口径。

**修复 #3A：`coverageOf` 排除 unverified（不改显示，只改计算基准）**  
`lib/company-profile.ts:100` 改为 `if (found && found.grade !== "unverified" && String(found.value).trim())`，同步修复 `fde-dimensions.ts:28` / `report-html.ts:259` / `report-html.ts:495` 三处已矛盾的注释/断言。覆盖率从 23.69% → 9.70%，在报告里加一行「口径：空缺 + 未核实均算缺」。

**修复 #4：`ceilingGrade` 去重后取 max**  
`lib/corpus-import.ts` 的 `ceilingGrade`：按注册域名（eTLD+1）去重 URL 列表，再取 max。防止同一站的多条 URL 重复叠加（AS 1105 .05）。

---

## 4. FDE 重新定位

`lib/fde-roster.ts` 和 `data/filing-facts.json` 不动，行为不变。  
改变的只是框架语义：FDE 231 家 = 第一个 MonitorSet 实例，自动加入 `monitor_entries`（`addedFrom: "keyword"`，keywords 来自 `DISCOVERY_TERMS`）。

`build-report.ts` 加一行注释标注这一点；`app/report/route.ts` 报告页标题旁加「FDE 监控集 · 2026」副标题，说明这是本引擎的一个用例实例，不是产品全貌。

---

## 5. 文件清单

### 新建
| 文件 | 行数预估 | 说明 |
|---|---|---|
| `lib/query-intake.ts` | ~180 | 术语纠错 + 实体消歧 + 维度路由，纯函数 |
| `lib/monitor-set.ts` | ~150 | 监控集 CRUD + 重跑计划生成 |
| `app/api/query/route.ts` | ~180 | 主动查询端点 |
| `app/api/monitor/route.ts` | ~120 | 监控集端点 |
| `app/console/query-intake.tsx` | ~200 | 查询 UI（三步流程） |

### 修改
| 文件 | 修改点 |
|---|---|
| `app/signal-console.tsx` | Intake 加 `"query"` 模式；收集段加「监控集」子视图 |
| `lib/fde-dimensions.ts` | `Sourced<T>` 加 `publishedAt?` + `relay?` |
| `lib/company-profile.ts` | `coverageOf` 排除 unverified |
| `lib/corpus-import.ts` | `detectRelay` + `ceilingGrade` 去重 |
| `report-html.ts` | 口径说明文字；`publishedAt` 优先显示 |
| `tests/build-kernel.ts` | allowlist 加 `lib/query-intake.ts` `lib/monitor-set.ts` |
| `scripts/build-report.ts` | FDE 监控集实例标注 |

### 不动
`lib/field-core.ts`（六道门纪律，不可动）、`lib/ontology.ts`、`lib/fde-roster.ts`、`lib/dedup.ts`、`lib/extractor.ts`（entity typing 直接复用）、`db.ts`、`app/report/route.ts`（report chain 保持隔离）

---

## 6. 验收标准

1. **世纪互联 case**：输入「世纪互联最近启动了opc设计建设」→ 显示纠错提示 OPC→OCP → 消歧候选里出现两个不同法人 → 查出 VNET 自己的 OCP 文章 → grade 标 `self`（可升 `independent` 的路径在 UI 里说明）
2. **监控集**：手动把世纪互联加入监控集 → 点「立即重跑」→ 返回本次新抓到的候选数 + 比上次多了什么
3. **覆盖口径**：报告里覆盖率显示 9.70%，旁边有「口径：不含未核实」注释，和 FDE 那行字不再矛盾
4. **Relay 检测**：品见智能的 `team.founders`（shobserver 来源，原文有「推测」）被标 `relay` 并降级
5. **216 个测试仍然全绿**

---

## 7. 不做的事（明确边界）

- 不做 Admiralty 2D 码（A1/C3）——可读性差，保持 1D 展示
- 不自动写 `lib/fde-roster.ts`——候选 vs 名单的隔离不变
- 不在主动查询路径里调 LLM 做实体消歧——bigram 够用，且保证确定性
- 不做「记住我」登录——`session.ts` 的 12h TTL 不变
- 不独立部署 cron——`/api/monitor` 接受外部调用，用户自己决定怎么触发定期重跑

---

## 8. 施工顺序

1. `lib/query-intake.ts`（纯函数，可以先跑测试）
2. `app/api/query/route.ts`
3. `app/console/query-intake.tsx` + `signal-console.tsx` 改造
4. 口径修复 #3A（最小改动，解除三处矛盾）
5. 口径修复 #2（relay 检测，影响面最大，单独提交）
6. `lib/monitor-set.ts` + `app/api/monitor/route.ts`
7. 监控集 UI
8. 口径修复 #1 + #4（最小，随时穿插）
9. build-kernel.ts allowlist + 全套测试

步骤 1-3 可以独立跑通（世纪互联验收），不依赖 4-8。
