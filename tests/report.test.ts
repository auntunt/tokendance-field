// 报告层的行为测试。
//
// 这一层有三类会让整份报告失去价值的错误，下面逐条盯：
//   1. 该出现的公司不出现。第一版就犯过：新补的 24 家上市公司 facts 全空、
//      分数 0，被 207 家有资料的存量公司全压在后面，一张卡都没露面——
//      而「主要盯上市公司」正是这件事的重点。这类错误不会报错，只会安静地漏。
//   2. 一家公司把待办表占满。9 家挂牌公司各有 20 个可达法定披露的空字段，
//      不设上限就是 180 行填满 60 行的表，其余公司一行排不上。
//   3. 语料里的文本没转义就渲染进 HTML，把页面结构撑坏。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.ts";

const outDir = buildKernel();
const require = createRequire(import.meta.url);
const dims = require(`${outDir}/fde-dimensions.js`);
const profileLib = require(`${outDir}/company-profile.js`);
const importer = require(`${outDir}/corpus-import.js`);
const roster = require(`${outDir}/fde-roster.js`);
const data = require(`${outDir}/report-data.js`);
const html = require(`${outDir}/report-html.js`);

const FETCHED = "2026-08-09";

/** 造一批「有资料的存量公司」，用来复现「主动盯的被压到后面」那个场景。 */
function bulkCorpus(count) {
  return Array.from({ length: count }, (_, index) => importer.importCompany({
    id: `old-${index}`,
    name: `存量公司 ${index}`,
    city: "上海",
    sector: "通用平台",
    founder_raw: "张三：技术出身",
    founder_detail: "张三——某集团技术负责人",
    founder_tags: ["外企/跨国"],
    rounds: 2,
    stage: "A 轮",
    investors: ["某资本"],
    funding_amount_wan: 5000,
    narrative: "行业软件服务商",
    deliverable: "为客户交付实施方案，设区域交付中心",
    billing_raw: "项目制",
    macro_region: "华东",
    sources: ["http://jjckb.xinhuanet.com/20260730/abc/c.html"],
  }, FETCHED));
}

test("主动盯的公司一定进得了卡片区，哪怕一格资料都没有", () => {
  // 这条是对一个真实回归的复现：只按资料完整度排序时，名单里的公司全被挤掉。
  const profiles = [...bulkCorpus(198), ...importer.importRoster(roster.ROSTER, FETCHED)];
  const ranked = data.rankProfiles(profiles);
  const top = ranked.slice(0, roster.ROSTER.length).map(item => item.name);
  for (const entry of roster.ROSTER) {
    assert.ok(top.includes(entry.name), `${entry.name} 被存量公司挤出了卡片区——报告里就看不到它`);
  }
});

test("未上市但重点盯的创业公司也要在前排——那是「覆盖有融资创业公司」那条要求", () => {
  const profiles = [...bulkCorpus(198), ...importer.importRoster(roster.ROSTER, FETCHED)];
  const ranked = data.rankProfiles(profiles);
  const privateWatch = roster.ROSTER.filter(item => item.listing === "private");
  assert.ok(privateWatch.length >= 3, "名单里应有未上市的重点公司，否则这条测不出东西");
  const top = ranked.slice(0, roster.ROSTER.length).map(item => item.name);
  for (const entry of privateWatch) {
    assert.ok(top.includes(entry.name), `${entry.name} 未上市就被降到了后面，但它是我们主动要盯的`);
  }
});

test("待办表里一家公司不许占太多行，否则其余公司一行都排不上", () => {
  const profiles = [...bulkCorpus(20), ...importer.importRoster(roster.ROSTER, FETCHED)];
  const gaps = data.findGaps(profiles, 60);
  assert.equal(gaps.length, 60);
  const counts: Record<string, number> = {};
  for (const gap of gaps) counts[gap.name] = (counts[gap.name] || 0) + 1;
  const worst = Math.max(...Object.values(counts));
  assert.ok(worst <= 4, `单家公司占了 ${worst} 行，会把待办表挤满`);
  assert.ok(Object.keys(counts).length >= 15, `待办表只覆盖 ${Object.keys(counts).length} 家，广度不够`);
});

test("待办表不列查不到的字段——列了只是噪音", () => {
  const profiles = importer.importRoster(roster.ROSTER, FETCHED);
  const gaps = data.findGaps(profiles, 500);
  for (const gap of gaps) {
    assert.notEqual(gap.reachable, "unverified", `${gap.name} 的「${gap.field}」查不到，不该进待办`);
    assert.ok(gap.where && gap.where.trim(), `${gap.name} 的「${gap.field}」没写去哪儿抓`);
  }
});

test("已经有值的字段不会再出现在待办里", () => {
  const [profile] = bulkCorpus(1);
  const gaps = data.findGaps([profile], 500);
  const filledKeys = [];
  for (const [dimension, bucket] of Object.entries(profile.facts)) {
    for (const key of Object.keys(bucket)) filledKeys.push(`${dimension}.${key}`);
  }
  assert.ok(filledKeys.length > 0, "这条 fixture 应该有值，否则下面断言是空的");
  for (const gap of gaps) {
    assert.ok(!filledKeys.includes(`${gap.dimension}.${gap.key}`), `${gap.field} 已经有值了还在待办里`);
  }
});

test("变更页认得出六种变化", () => {
  const before = [
    importer.importCompany({ id: 1, name: "甲", founder_raw: "张三：技术出身", narrative: "旧描述", sources: ["https://pitchhub.36kr.com/project/1"] }, "2026-08-01"),
    importer.importCompany({ id: 2, name: "乙", founder_raw: "李四" }, "2026-08-01"),
  ];
  const after = [
    // 甲：业务描述改了（fact-changed）、创始人来源升级（grade-changed）、补上投资方（fact-added）
    importer.importCompany({ id: 1, name: "甲", founder_raw: "张三：技术出身", narrative: "新描述", investors: ["某资本"], sources: ["http://jjckb.xinhuanet.com/x/c.html"] }, FETCHED),
    // 丙：新公司
    importer.importCompany({ id: 3, name: "丙", founder_raw: "王五" }, FETCHED),
  ];
  const changes = data.diffProfiles(before, after);
  const kinds = new Set(changes.map(item => item.kind));
  assert.ok(kinds.has("company-added"), "没认出新增公司");
  assert.ok(kinds.has("company-dropped"), "没认出移出名单的公司");
  assert.ok(kinds.has("fact-added"), "没认出补上的字段");
  assert.ok(kinds.has("fact-changed"), "没认出变了值的字段");
  assert.ok(kinds.has("grade-changed"), "没认出来源升降级——那是最有价值的一类进展");
});

test("值没变、只有出处换了，要报成来源升降级而不是值变化", () => {
  const before = [importer.importCompany({ id: 1, name: "甲", founder_raw: "张三：技术出身", sources: ["https://pitchhub.36kr.com/project/1"] }, "2026-08-01")];
  const after = [importer.importCompany({ id: 1, name: "甲", founder_raw: "张三：技术出身", sources: ["http://jjckb.xinhuanet.com/x/c.html"] }, FETCHED)];
  const changes = data.diffProfiles(before, after);
  const founderChanges = changes.filter(item => item.field === "创始人姓名与背景");
  assert.equal(founderChanges.length, 1);
  assert.equal(founderChanges[0].kind, "grade-changed");
  assert.equal(founderChanges[0].from, "self");
  assert.equal(founderChanges[0].to, "independent");
});

test("同样输入出同样报告——定期重跑不该产生假变更", () => {
  const profiles = [...bulkCorpus(4), ...importer.importRoster(roster.ROSTER.slice(0, 4), FETCHED)];
  const first = html.renderReport({ profiles, generatedAt: FETCHED, cardLimit: 8 });
  const second = html.renderReport({ profiles, generatedAt: FETCHED, cardLimit: 8 });
  assert.equal(first, second);
  assert.deepEqual(data.diffProfiles(profiles, profiles), []);
});

test("语料里的 HTML 与引号必须转义，否则页面结构会被撑坏", () => {
  const nasty = importer.importCompany({
    id: "x",
    name: '<script>alert("x")</script>坏名字',
    narrative: 'a & b <img src=x onerror="boom"> "引号" \'单引号\'',
    founder_raw: "</h3><h1>越权标题",
    sources: ["http://jjckb.xinhuanet.com/x/c.html"],
  }, FETCHED);
  const page = html.renderReport({ profiles: [nasty], generatedAt: FETCHED, cardLimit: 5 });
  assert.doesNotMatch(page, /<script>alert/, "脚本标签原样进了页面");
  assert.doesNotMatch(page, /<img src=x onerror/, "事件属性原样进了页面");
  assert.doesNotMatch(page, /<\/h3><h1>/, "闭合标签原样进了页面，结构会错乱");
  assert.match(page, /&lt;script&gt;/, "应该转义成实体");
  assert.equal(html.esc('a&b<c>"d"'), "a&amp;b&lt;c&gt;&quot;d&quot;");
});

test("报告自包含：脚本样式内联，不发任何外部请求", () => {
  const profiles = [...bulkCorpus(3), ...importer.importRoster(roster.ROSTER.slice(0, 3), FETCHED)];
  const page = html.renderReport({ profiles, generatedAt: FETCHED, cardLimit: 6 });
  // 交互脚本必须内联；外部脚本/样式/字体一条都不许有。
  assert.doesNotMatch(page, /<script[^>]+src=/i, "脚本必须内联，不能引用外部文件");
  assert.doesNotMatch(page, /<link[^>]+href=(?!["']data:)/i, "外部资源会破坏单文件分发");
  assert.doesNotMatch(page, /@import/, "不该 @import 外部资源");
  assert.match(page, /<style>/, "样式应该内联");

  // 判据是「渲染这一页不发外部请求」，不是「页面里不许有外链」。
  // 这两件事差在哪儿：正文里的「出处链接」是外链，但它要用户点了才走，
  // 而且那正是报告的价值所在；head 里的资源是打开就自动去取的，
  // 取不到就是白屏、缺字体、掉图标。所以只管 head。
  //
  // 原来这行写的是 doesNotMatch(/<link/)，那是把手段当成了目的：
  // 内联 data: 的图标也是 <link>，它一个请求都不发，却会被那条断言拦下来。
  const head = page.match(/<head>[\s\S]*?<\/head>/)[0];
  const refs = [...head.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1]);
  const external = refs.filter(u => !u.startsWith("data:"));
  assert.deepEqual(external, [],
    `head 里还有外部资源 ${JSON.stringify(external)}——报告当附件发出去以后这些一定取不到`);
});

test("知识图谱：给网络数据就出内联 SVG，且节点与边数量不缩水", () => {
  const profiles = bulkCorpus(2);
  const network = {
    nodes: [
      { id: "c1", type: "company", label: "甲公司", sector: "通用平台" },
      { id: "c2", type: "company", label: "乙公司", sector: "工业制造" },
      { id: "i1", type: "investor", label: "资本A" },
      { id: "t1", type: "background", label: "大厂系" },
    ],
    links: [
      { source: "c1", target: "i1", kind: "investor" },
      { source: "c2", target: "t1", kind: "background" },
    ],
  };
  const page = html.renderReport({ profiles, generatedAt: FETCHED, cardLimit: 3, network });
  assert.match(page, /<section id="graph">/, "报告里没有知识图谱章节");
  assert.equal((page.match(/class="graph-node/g) || []).length, 4, "节点数量不对");
  assert.equal((page.match(/class="graph-link/g) || []).length, 2, "边数量不对");
  assert.match(page, /data-graph-mode="focus"/, "图谱应默认提供关系焦点阅读方式");
  assert.match(page, /data-graph-mode="overview"/, "图谱应保留全局概览");
  assert.match(page, /id="graphSearch"/, "节点多时必须能按名称查找");
  assert.equal((page.match(/data-source=/g) || []).length, 2, "交互重排需要保留每条边的端点");
  assert.match(page, /class="graph-node[^"\n]*is-focus/, "默认应有一个明确的焦点节点");
  assert.doesNotMatch(page, /<script[^>]+src=/i, "知识图谱不得引入外部脚本");
});

test("每条事实在页面里都带级别、出处和抓取时间", () => {
  const [profile] = bulkCorpus(1);
  const page = html.renderReport({ profiles: [profile], generatedAt: FETCHED, cardLimit: 5 });
  const cover = profileLib.coverageOf(profile);
  assert.ok(cover.filled > 0);
  const stamps = (page.match(/抓取 2026-08-09/g) || []).length;
  assert.ok(stamps >= cover.filled, `事实 ${cover.filled} 条，但只有 ${stamps} 处抓取时间`);
  for (const grade of dims.SOURCE_GRADES) {
    if (cover.byGrade[grade] > 0) {
      assert.ok(page.includes(`[${dims.GRADE_META[grade].label}]`), `页面里没出现 ${grade} 的级别标签`);
    }
  }
});

test("报告层不渲染六道门的任何字段或门状态——两套体系并行", () => {
  const profiles = [...bulkCorpus(2), ...importer.importRoster(roster.ROSTER.slice(0, 2), FETCHED)];
  const page = html.renderReport({ profiles, generatedAt: FETCHED, cardLimit: 4 });
  // 查的是门的字段名和门状态，不是「签字」这个词本身：
  // 页脚那句「报告层不替人签字」是在说明边界，正是想要的行为，不是泄漏。
  for (const word of ["signedOff", "falsifier", "counterEvidence", "epistemicState", "ourAccess", "validUntil", "gateState", "missingGates"]) {
    assert.doesNotMatch(page, new RegExp(word), `报告里出现 ${word} 说明两层混在一起了`);
  }
  assert.doesNotMatch(page, /门\s*[1-6]|[0-6]\s*\/\s*6\s*道/, "报告里出现门的计数，说明把资料当判断在卡");
  // 反过来，边界必须写明白：读的人得知道这份东西不替他做决定。
  assert.match(page, /不替人签字|不做判断/, "报告没说明它不替人做判断，读的人会误当结论用");
});

test("首版没有上一版可比时，明说是首版，不假装 0 变化", () => {
  const profiles = bulkCorpus(2);
  const first = html.renderReport({ profiles, generatedAt: FETCHED, cardLimit: 4 });
  assert.match(first, /这是第一版/);
  const same = html.renderReport({ profiles, previous: profiles, generatedAt: FETCHED, cardLimit: 4 });
  assert.match(same, /没有任何变化/);
  assert.match(same, /抓取没跑成|源站没更新/, "0 变化要提示可能是抓取没跑成，那不是好消息");
});

test("整项全空的维度显示成待办，不显示成结论", () => {
  const [watch] = importer.importRoster(roster.ROSTER.slice(0, 1), FETCHED);
  const page = html.renderReport({ profiles: [watch], generatedAt: FETCHED, cardLimit: 3 });
  assert.match(page, /整项未核实/);
  assert.match(page, /这是待办，不是结论/);
  assert.match(page, /重点盯/, "主动盯的公司要标出来，否则空白卡看着像数据坏了");
});

test("概览的覆盖率算的是有出处的格子，和逐档累加对得上", () => {
  const profiles = [...bulkCorpus(5), ...importer.importRoster(roster.ROSTER.slice(0, 5), FETCHED)];
  const overview = data.buildOverview(profiles);
  assert.equal(overview.companies, 10);
  assert.equal(overview.fields, dims.ALL_FIELDS.length);
  assert.equal(overview.cells, 10 * dims.ALL_FIELDS.length);
  const summed = dims.SOURCE_GRADES.reduce((total, grade) => total + overview.byGrade[grade], 0);
  assert.equal(summed, overview.filled, "级别分档加起来必须等于总填充数，否则热图和统计打架");
  const matrixSum = overview.matrix.reduce((total, dim) => total + dim.fields.reduce((sub, f) => sub + f.filled, 0), 0);
  assert.equal(matrixSum, overview.filled, "热图逐格加总必须等于总填充数");
});

// 打印这条路径之前是坏的、而且没人发现：深底配色印在白纸上，
// 公司名是 1.04:1（深字压深卡片背景），热图行名 1.27:1——纸上等于空白。
// 这份报告的用途就是被人存成 PDF 转发，所以打印不是次要路径。
test("打印样式必须整套换掉配色变量，不能只改 body", () => {
  const profiles = [...bulkCorpus(3), ...importer.importRoster(roster.ROSTER.slice(0, 3), FETCHED)];
  const page = html.renderReport({ profiles, generatedAt: FETCHED, cardLimit: 6 });
  const print = page.match(/@media print\{([\s\S]*?)\n\}/);
  assert.ok(print, "必须有 @media print 块");
  const block = print[1];
  for (const name of ["--g-statutory", "--g-independent", "--g-self", "--g-unverified",
                      "--bg", "--panel", "--panel-2", "--text", "--strong", "--muted", "--line"]) {
    assert.ok(block.includes(`${name}:`), `打印时没重定义 ${name}——深底的值会原样印到白纸上`);
  }
});

test("名单默认收起，但打印时必须展开——否则 PDF 里整节名单消失", () => {
  const profiles = [...bulkCorpus(3), ...importer.importRoster(roster.ROSTER.slice(0, 3), FETCHED)];
  const page = html.renderReport({ profiles, generatedAt: FETCHED, cardLimit: 6 });
  assert.match(page, /<details class="roster"[^>]*>/, "名单该是收起的 details");
  assert.doesNotMatch(page, /<details class="roster" open>/, "名单不该默认展开");

  const block = page.match(/@media print\{([\s\S]*?)\n\}/)[1];
  // 必须打在 ::details-content 上。浏览器隐藏未展开内容用的是那个伪元素插槽，
  // 改 details 自身或它的子元素都没效果——子元素会算出 display:block、尺寸却是 0，
  // 看代码以为修好了，导出 PDF 才发现名单不在。
  assert.match(block, /details\.roster::details-content\{[^}]*content-visibility:\s*visible/,
    "打印时没在 ::details-content 上放开 content-visibility，名单不会进 PDF");
});

test("颜色不许写死在标签的 style 里——写死了打印时改不掉", () => {
  const profiles = [...bulkCorpus(3), ...importer.importRoster(roster.ROSTER.slice(0, 3), FETCHED)];
  const page = html.renderReport({ profiles, generatedAt: FETCHED, cardLimit: 6 });
  const body = page.split("</style>")[1] || "";
  const inline = body.match(/style="[^"]*"/g) || [];
  for (const decl of inline) {
    assert.doesNotMatch(decl, /#[0-9a-fA-F]{3,8}\b/,
      `内联样式里有写死的颜色，打印时无法覆盖：${decl}`);
  }
});

// ============ 图表与表格 ============
// 之前这份报告通篇是文字和数字：87 项变更平铺成一列等重的方块，
// 十个股东挤在一段散文里，一张卡要读完才知道这家查到哪一步。
// 下面几条盯的是「加了图表之后不许把数据讲错」，不是盯好不好看。

test("持股名单排成表，口径子句必须跟着进表题——不许在排版时丢掉量纲", () => {
  // 「占总股本比例」和「占流通股比例」差一倍还不止。散文里那句限定
  // 是这些数字唯一的量纲说明，排成表格之后它更要在，因为表格看起来更像结论。
  const [profile] = bulkCorpus(1);
  const basis = "口径：名单为十大流通股东，比例为占总股本比例，不是占流通股比例";
  profile.facts.shareholders = {
    majorHolders: {
      value: `香港中央结算有限公司（其它）1.8507%；UBS AG（QFII）1.5342%。${basis}`,
      grade: "independent", source: "东方财富 F10", fetchedAt: FETCHED,
    },
  };
  const page = html.renderReport({ profiles: [profile], generatedAt: FETCHED, cardLimit: 3 });
  assert.match(page, /<table class="holder">/, "持股名单没排成表");
  assert.match(page, /不是占流通股比例/, "口径子句在排表时丢了——剩下的数字没有量纲");
  assert.match(page, /1\.5342%/, "比例被改写了，必须照抄原文");
  assert.ok(page.includes("<caption>") , "口径要落在表题里，不能只当普通文字");
});

test("认不出格式的持股值退回散文，不许猜着摆进表格", () => {
  // 摆错了的表格比散文危险得多：它看起来像已经核过的结论。
  const [profile] = bulkCorpus(1);
  profile.facts.shareholders = {
    majorHolders: { value: "无控股主体", grade: "statutory", source: "年报", fetchedAt: FETCHED },
  };
  const page = html.renderReport({ profiles: [profile], generatedAt: FETCHED, cardLimit: 3 });
  assert.match(page, /无控股主体/, "值本身必须还在页面上");
  assert.doesNotMatch(page, /<table class="holder">/, "一句短语被排成了表格");
});

test("变更页按公司分组，组标题给出条数——不是 87 个等重的方块", () => {
  const before = bulkCorpus(2);
  const after = bulkCorpus(2).map(profile => ({
    ...profile,
    facts: { ...profile.facts, business: { ...(profile.facts.business || {}),
      pricing: { value: "按人天计费", grade: "self", source: "官网", fetchedAt: FETCHED } } },
  }));
  const page = html.renderReport({ profiles: after, previous: before, generatedAt: FETCHED, cardLimit: 4 });
  assert.match(page, /class="chgroup"/, "变更页没有按公司分组");
  assert.match(page, /<span>\d+ 项<\/span>/, "组标题没给条数，读的人还得自己数");
  assert.match(page, /本次更新<span class="n">\d+ 项 · \d+ 家公司/, "标题没说涉及几家公司");
  // 组标题已经写了公司名，条目里不该再重复一遍——重复会把变了的字段名挤到看不见。
  // 注：标题里现在带一个变更类型图标 <i class="chg-icon">＋/－/↑/⟳/↓/△，
  // 正则要跨过它才能拿到后面的字段名。顺带也就断言了图标确实渲染出来。
  const items = page.match(
    /<li style="border-left-color:[^"]*"><b><i class="chg-icon"[^>]*>[^<]*<\/i>[^<]*<\/b>/g) || [];
  assert.ok(items.length > 0, "没渲染出变更条");
  for (const item of items) {
    assert.doesNotMatch(item, /存量公司 \d/, `条目里重复了公司名：${item}`);
  }
});

test("概览的维度条加起来等于总填充数——图不许和统计打架", () => {
  // 图是新加的，最容易出的错是它自己算一遍、算出另一个数。
  const profiles = [...bulkCorpus(4), ...importer.importRoster(roster.ROSTER.slice(0, 4), FETCHED)];
  const overview = data.buildOverview(profiles);
  const page = html.renderReport({ profiles, generatedAt: FETCHED, cardLimit: 8 });
  assert.match(page, /class="dims"/, "概览里没有逐维度的条形");
  const shown = [...page.matchAll(/<span>([\d.]+)%　(\d+)\/(\d+)<\/span>/g)];
  assert.equal(shown.length, dims.DIMENSIONS.length, "维度条数量和维度数不一致");
  const summed = shown.reduce((total, match) => total + Number(match[2]), 0);
  assert.equal(summed, overview.filled, "维度条加起来不等于覆盖总数");
  const cells = shown.reduce((total, match) => total + Number(match[3]), 0);
  assert.equal(cells, overview.cells, "维度条的分母加起来不等于总格数");
});

test("公司卡上的格子图每格对应一个字段，填了的才上色", () => {
  const [profile] = bulkCorpus(1);
  const cover = profileLib.coverageOf(profile);
  const page = html.renderReport({ profiles: [profile], generatedAt: FETCHED, cardLimit: 3 });
  const grid = page.match(/<div class="fgrid">([\s\S]*?)<span class="lg">/);
  assert.ok(grid, "公司卡上没有格子图");
  const cells = grid[1].match(/<i[^>]*><\/i>/g) || [];
  assert.equal(cells.length, dims.ALL_FIELDS.length, "格子数必须等于字段数，否则图在说谎");
  const filled = cells.filter(cell => cell.includes("background:var(--g-")).length;
  assert.equal(filled, cover.filled, "上色的格子数必须等于有出处的字段数");
  // 只靠颜色不够：每格都要有能读出来的说明。
  for (const cell of cells) assert.match(cell, /title="/, "格子没有 title，只靠颜色传达信息");
});

test("加了图表之后报告依然是确定的——同样的输入渲染两次逐字节一样", () => {
  // 定期重跑要能逐版比对。渲染里只要有一处顺序不定，变更页就会满是假变化。
  const profiles = [...bulkCorpus(4), ...importer.importRoster(roster.ROSTER.slice(0, 4), FETCHED)];
  const once = html.renderReport({ profiles, generatedAt: FETCHED, cardLimit: 8 });
  const twice = html.renderReport({ profiles, generatedAt: FETCHED, cardLimit: 8 });
  assert.equal(once, twice, "两次渲染结果不同，报告不可比");
});

test("交叉表跟着判断走，且每格既有百分比又有家数", () => {
  // 交叉表放在判断那一节里，不放到「结构画像」去：读者刚读到「政务治理 92%」，
  // 要复算就得当场看到那一格，隔一节就没人翻回来了。
  const profiles = [];
  let n = 0;
  for (const [sector, billings] of Object.entries({
    政务治理: { "项目制/私有化": 11, "订阅/SaaS": 1 },
    // 按效果付费只出现在零售消费，另两个赛道那一格就是真的零——
    // 这是交叉表最常见的形状，也是最容易渲染错的一格。
    零售消费: { "项目制/私有化": 2, "订阅/SaaS": 10, "按效果/结果付费": 6 },
    工业制造: { "项目制/私有化": 6, "订阅/SaaS": 6 },
  })) {
    for (const [billing, count] of Object.entries(billings)) {
      for (let i = 0; i < count; i += 1) {
        profiles.push(importer.importCompany({
          id: `xt-${n += 1}`, name: `交叉 ${n}`, sector, billing,
          billing_raw: `${billing}（累计订单 ${100 + i} 万）`,
          city: "上海", macro_region: "华东",
          sources: ["http://jjckb.xinhuanet.com/20260730/abc/c.html"],
        }, FETCHED));
      }
    }
  }
  const page = html.renderReport({ profiles, generatedAt: FETCHED, cardLimit: 6 });
  const judgeSection = page.match(/<section id="judgment">[\s\S]*?<\/section>/)[0];
  assert.match(judgeSection, /赛道 × 计费方式/, "交叉表没跟在判断后面");
  // 只给百分比，5 家里的 80% 会被当成 100 家里的 80% 读；只给家数，行分母不同就没法横向比。
  assert.match(judgeSection, /<span class="pc">92%<\/span><span class="ct">11<\/span>/,
    "格子里缺了百分比或家数中的一个");
  // 零要写「—」。写 0% 会让人以为量过了一个有值的样本，其实是这一格没人落进来。
  assert.match(judgeSection, /<span class="z">—<\/span>/, "零命中的格子该写「—」，不该写 0%");
  assert.doesNotMatch(page, /这份报告不做判断/, "页脚还写着「不做判断」，可判断已经是第一节了");
});

test("报告自带内联图标——不声明的话浏览器会自己去要 /favicon.ico", () => {
  const [profile] = bulkCorpus(1);
  const page = html.renderReport({ profiles: [profile], generatedAt: FETCHED, cardLimit: 3 });
  const head = page.match(/<head>[\s\S]*?<\/head>/)[0];

  // 线上那条 404 不是图标丢了，是压根没声明：head 里没有 rel="icon"，
  // 浏览器就按默认约定去站点根要 /favicon.ico，而这个项目只有 favicon.svg。
  assert.match(head, /<link rel="icon" href="data:image\/svg\+xml;base64,/,
    "报告没声明图标——浏览器会自动去要 /favicon.ico");

  // 内联而非 /favicon.svg：这份 HTML 会被双击本地文件打开、会被拷进邮件附件，
  // 那些场景下没有站点根，任何 / 开头的路径都是死链。
  // （head 里「不许有外部资源」由上面那条自包含测试统一守。）
  assert.doesNotMatch(head, /href="\/favicon/, "图标指了绝对路径，报告发出去以后取不到");
});
