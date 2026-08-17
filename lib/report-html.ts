// 报告渲染：一个自包含的 HTML 文件，不依赖网络、不依赖服务器。
// 生成出来可以直接发给别人，双击打开就能看。
//
// 为什么手写 HTML 而不是做成 React 页面：这份东西的用途是「发出去」。
// 一个能拷进微信、扔进邮件附件的单文件，比一个需要账号才能打开的页面有用得多。
// 控制台里那套（要登录、有六道门）是另一回事，两者并存。

import { DIMENSIONS, GRADE_META, SOURCE_GRADES, type SourceGrade } from "./fde-dimensions";
import { LISTING_LABEL, RELEVANCE_META, coverageOf, fact, type CompanyProfile } from "./company-profile";
import { buildOverview, diffProfiles as diffFor, findGaps, rankProfiles, type Change } from "./report-data";
import {
  CONFIDENCE, CONFIDENCE_META, buildJudgments, dimensionBars, fieldBars, founderBillingTable,
  listingBars, sectorBillingTable,
  type BarRow, type Confidence, type CrossTable, type ManualJudgment,
} from "./report-judgment";
import { parseHolders } from "./holder-table";

/** HTML 转义。语料里带 & < > 和引号，不转义会把页面结构撑坏。 */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 图标内联成 data URI，不写 `<link href="/favicon.svg">`。
 *
 *  这份 HTML 的用途是「发出去」——双击本地文件打开、拷进邮件附件。
 *  指向绝对路径的图标在那些场景下一定 404：本地文件没有站点根，
 *  发到别人服务器上也不会带着 public/ 一起走。
 *  而完全不声明图标，浏览器会自己去要 /favicon.ico——线上就是这么来的那条 404。
 *  内联的话，报告在哪儿打开都自带图标，一个请求都不发。 */
const FAVICON = "data:image/svg+xml;base64,"
  + "PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9"
  + "Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMjIgMTkuMjcyN0MyMiAyMC43NzkgMjAuNzc5"
  + "IDIyIDE5LjI3MjcgMjJIMTQuNzI3M0MxMy4yMjEgMjIgMTIgMjAuNzc5IDEyIDE5LjI3MjdWMTJIMTkuMjcyN0My"
  + "MC43NzkgMTIgMjIgMTMuMjIxIDIyIDE0LjcyNzNWMTkuMjcyN1oiIGZpbGw9IiM2OEM0RkYiLz48cGF0aCBkPSJN"
  + "MjAgMkMyMS4xMDQ2IDIgMjIgMi44OTU0MyAyMiA0VjdDMjIgOC4xMDQ1NyAyMS4xMDQ2IDkgMjAgOUgxN0MxNS44"
  + "OTU0IDkgMTUgOC4xMDQ1NyAxNSA3VjRDMTUgMi44OTU0MyAxNS44OTU0IDIgMTcgMkgyMFoiIGZpbGw9IiMwQzc5"
  + "RDgiLz48cGF0aCBkPSJNNyAxNUM4LjEwNDU3IDE1IDkgMTUuODk1NCA5IDE3VjIwQzkgMjEuMTA0NiA4LjEwNDU3"
  + "IDIyIDcgMjJINEMyLjg5NTQzIDIyIDIgMjEuMTA0NiAyIDIwVjE3QzIgMTUuODk1NCAyLjg5NTQzIDE1IDQgMTVI"
  + "N1oiIGZpbGw9IiMwQzc5RDgiLz48cGF0aCBkPSJNMTIgMTJINC43MjcyN0MzLjIyMTA0IDEyIDIgMTAuNzc5IDIg"
  + "OS4yNzI3M1Y0LjcyNzI3QzIgMy4yMjEwNCAzLjIyMTA0IDIgNC43MjcyNyAySDkuMjcyNzNDMTAuNzc5IDIgMTIg"
  + "My4yMjEwNCAxMiA0LjcyNzI3VjEyWiIgZmlsbD0iIzJFOUVGRiIvPjwvc3ZnPg==";

/** 级别配色走 CSS 变量，不写死颜色值。
 *  屏幕上是深底浅字（法定 #6ad2a8 / 三方 #6fc2e8 / 自述 #d9a860 / 未核 #94a4b4，
 *  最低的在 #0f151d 上 6.9:1）；打印时整套变量换成白纸上的深色版。
 *  这份东西的用途是「发出去」，有人会直接按 Ctrl+P 存 PDF——
 *  如果颜色写死在标签的 style 里，打印时就没有任何办法改，深底的浅绿印在白纸上等于消失。
 *  形状也做了区分（左边框颜色 + 标签文字），不只靠颜色传达级别。 */
const GRADE_COLOR: Record<SourceGrade, string> = {
  statutory: "var(--g-statutory)",
  independent: "var(--g-independent)",
  self: "var(--g-self)",
  unverified: "var(--g-unverified)",
};

const STYLE = `
:root{
  --g-statutory:#6ad2a8;--g-independent:#6fc2e8;--g-self:#d9a860;--g-unverified:#94a4b4;
  --accent:#ffad21;--accent-soft:#ffc35c;--c-drop:#ff7a63;
  --bg:#0f151d;--panel:#111922;--panel-2:#0d141c;--panel-3:#131b24;--head:#0c131b;
  --text:#dce5ee;--strong:#eef3f7;--muted:#8c9aa8;--muted-2:#8593a1;--label:#93a2b1;
  --line:rgba(132,154,178,.2);--line-soft:rgba(132,154,178,.13);--track:#1b242e;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",Arial,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--g-independent)}
.wrap{max-width:1180px;margin:0 auto;padding:32px 20px 80px}
header.top{border-bottom:1px solid var(--line);padding-bottom:22px;margin-bottom:28px}
header.top .kicker{color:var(--accent);font:700 12px/1 ui-monospace,monospace;letter-spacing:.14em}
header.top h1{margin:12px 0 8px;font-size:27px;line-height:1.25;letter-spacing:-.02em}
header.top p{margin:0;color:var(--muted);font-size:13px}
nav.jump{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
nav.jump a{display:inline-flex;align-items:center;min-height:34px;padding:6px 13px;border:1px solid rgba(132,154,178,.28);color:var(--text);text-decoration:none;font-size:13px}
nav.jump a:hover{border-color:var(--accent);color:var(--accent-soft)}
section{margin:44px 0 0}
h2{margin:0 0 6px;font-size:20px;letter-spacing:-.01em}
h2 .n{color:var(--label);font:600 13px/1 ui-monospace,monospace;margin-left:10px}
h3.subhead{margin:30px 0 6px;font-size:15px;color:var(--strong);letter-spacing:-.01em}
.lede{margin:0 0 20px;color:var(--muted);font-size:13px;max-width:76ch}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin-bottom:24px}
.stats div{background:var(--panel-3);padding:15px 16px}
.stats b{display:block;font:700 21px/1 ui-monospace,monospace;color:var(--strong)}
.stats span{display:block;margin-top:7px;color:var(--muted);font-size:12px}
.grades{display:flex;flex-wrap:wrap;gap:14px;margin:0 0 22px}
.gr{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text)}
.gr i{width:11px;height:11px;flex:0 0 auto}
.gr b{color:var(--strong);font:700 13px/1 ui-monospace,monospace}
.scroll{overflow-x:auto;border:1px solid var(--line);background:var(--panel)}
table{border-collapse:collapse;width:100%;min-width:660px;font-size:13px}
th,td{text-align:left;padding:10px 13px;border-bottom:1px solid var(--line-soft);vertical-align:top}
th{background:var(--head);color:var(--label);font:600 12px/1.4 ui-monospace,monospace;letter-spacing:.06em;position:sticky;top:0}
th.rowhead{background:transparent;position:static;font-weight:400;font-family:inherit;color:var(--text);font-size:13px}
tbody tr:last-child td{border-bottom:0}
td.num{font:600 13px/1 ui-monospace,monospace;white-space:nowrap}
caption{text-align:left;padding:10px 13px;color:var(--label);font-size:12px}
.bar{display:flex;height:10px;min-width:104px;background:var(--track);overflow:hidden}
.bar i{display:block;height:100%}
.dimhead td{background:var(--panel-2);color:var(--accent);font:700 12px/1.4 ui-monospace,monospace;letter-spacing:.08em}
.where{color:var(--muted-2);font-size:12px}
/* 维度条：6 个维度各自的覆盖，按来源级别堆叠。下面那张逐字段的表是查细节用的，
   这一排是先看一眼——哪个维度整体是空的，用表格得一行行数才看得出来。 */
.dims{display:grid;grid-template-columns:repeat(auto-fit,minmax(288px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin:0 0 24px}
.dims .d{background:var(--panel-3);padding:13px 16px}
.dims .d .t{display:flex;align-items:baseline;gap:8px;margin-bottom:9px}
.dims .d .t b{color:var(--strong);font-size:13px}
.dims .d .t em{color:var(--muted-2);font-style:normal;font-size:12px}
.dims .d .t span{margin-left:auto;color:var(--label);font:600 12px/1 ui-monospace,monospace;white-space:nowrap}
.dims .d .bar{height:13px}
/* 事实网格：一家公司 30 个字段的全貌，按维度分成 6 组。填了的格子按来源级别上色，
   空的留底色。这是卡片的缩略图——不读完整张卡也知道这家查到哪一步、硬到什么程度。
   只靠颜色不够，所以每格都有 title，且下面紧跟着逐字段的正文。 */
.fgrid{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:12px 18px;border-bottom:1px solid var(--line-soft)}
.fgrid .g{display:flex;gap:2px}
.fgrid .g i{display:block;width:9px;height:15px;background:var(--track)}
.fgrid .lg{color:var(--muted-2);font-size:12px}
/* 持股表里的比例条。宽度按本表最大值归一，只作组内比较，不是占总股本的绝对刻度。 */
.hbar{display:block;height:7px;min-width:36px;max-width:120px;background:var(--track);margin-top:5px}
.hbar i{display:block;height:100%}
table.holder{min-width:480px}
table.holder td.pct{width:1%;white-space:nowrap}
table.holder .lead{color:var(--text)}
/* 交叉表。每格是「这一行里占多少」，所以要能横着读一行、竖着比一列。
   格子里既放百分比又放绝对数：只给百分比，5 家里的 80% 会被当成 100 家里的 80% 读；
   只给绝对数，行分母不同就没法横向比。底下那条极细的比例条是给扫视用的，
   不是刻度——真正的数在字上。 */
.xth{margin:26px 0 6px;font-size:15px;color:var(--strong)}
table.xt{min-width:760px}
/* 表头不许折行。「软硬一体」被折成「软硬一\n体」还能猜出来，
   「平台+定制」折在加号后面就变成两个词了——列名读错，整列的数就白给。
   列窄了让整表横向滚动，不让字断开。 */
table.xt th{white-space:nowrap}
table.xt td{padding:9px 12px;white-space:nowrap;vertical-align:middle}
table.xt th.rowhead{white-space:nowrap;vertical-align:middle}
table.xt td.c{width:1%}
table.xt .pc{font:700 13px/1 ui-monospace,monospace;color:var(--strong)}
table.xt .ct{color:var(--muted-2);font-size:12px;margin-left:5px}
table.xt .z{color:var(--muted-2);font:400 13px/1 ui-monospace,monospace}
table.xt .xb{display:block;height:4px;width:52px;background:var(--track);margin-top:6px}
table.xt .xb i{display:block;height:100%;background:var(--muted-2)}
table.xt td.hi .pc{color:var(--accent)}
table.xt td.hi .xb i{background:var(--accent)}
table.xt th.hi{color:var(--accent)}
table.xt td.tot{font:600 13px/1 ui-monospace,monospace;color:var(--label)}
.chgroup{margin-bottom:16px}
.chgroup>h3{display:flex;align-items:baseline;gap:9px;margin:0 0 7px;font-size:14px;color:var(--strong)}
.chgroup>h3 span{color:var(--label);font:600 12px/1 ui-monospace,monospace}
.card{border:1px solid var(--line);background:var(--panel);margin-bottom:16px}
.card>header{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;padding:15px 18px;border-bottom:1px solid var(--line);background:var(--panel-2)}
.card h3{margin:0;font-size:16px;color:var(--strong)}
.card .meta{color:var(--muted);font-size:12px}
.tag{display:inline-flex;align-items:center;min-height:22px;padding:2px 8px;border:1px solid rgba(132,154,178,.3);color:var(--text);font:600 12px/1.4 ui-monospace,monospace}
.tag.watch{border-color:var(--accent);color:var(--accent-soft)}
.tag.manual{border-style:dashed;color:var(--label)}

/* ---- 判断页 ---- */
.jds{display:grid;gap:14px}
.jd{border:1px solid var(--line);border-left:3px solid var(--accent);background:var(--panel);padding:16px 18px}
.jh{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;margin-bottom:0}
.jn{color:var(--label);font:700 13px/1 ui-monospace,monospace}
/* 判断本身要能一眼读完：字号大一档、行高松、字重足。
   证据栏（支撑 / 反例）降到判断下面，用分割线隔开——读者先读结论，有疑问才往下看。 */
.jd h3{margin:0;flex:1 1 22ch;min-width:0;font-size:19px;line-height:1.4;color:var(--strong);font-weight:700;letter-spacing:-.02em}
.jd-ev{border-top:1px solid var(--line-soft);margin-top:12px;padding-top:12px}
.jb{display:grid;grid-template-columns:max-content 1fr;gap:8px 14px;margin:0}
.jb dt{color:var(--label);font:600 12px/1.8 ui-monospace,monospace;letter-spacing:.06em;display:flex;align-items:center;gap:4px}
.jb dd{margin:0;color:var(--text);font-size:13px;line-height:1.7}
.ico-ok{color:var(--g-statutory);font-style:normal}
.ico-no{color:var(--c-drop);font-style:normal}
/* 「这份数据的边界」折叠区。默认收起：它是脚注，不是正文。
   但打印时强制展开（见 @media print），因为存成 PDF 转发时不该把边界说明弄丢。 */
details.corpus{margin-top:22px;border:1px solid var(--line-soft);background:var(--panel-2)}
details.corpus>summary{cursor:pointer;padding:13px 16px;color:var(--label);font-size:13px}
details.corpus>summary:hover{color:var(--accent-soft)}
details.corpus[open]>summary{border-bottom:1px solid var(--line-soft);margin-bottom:14px}
details.corpus>.lede,details.corpus>.jds{padding:0 16px}
details.corpus>.jds{padding-bottom:16px}

/* ---- 比例条 ---- */
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;margin-bottom:14px}
.panel{border:1px solid var(--line);background:var(--panel);padding:15px 17px;margin-bottom:14px}
.panel h3{display:flex;flex-wrap:wrap;align-items:baseline;gap:9px;margin:0 0 13px;font-size:14px;color:var(--strong)}
.panel h3 em{color:var(--muted);font:400 12px/1.4 system-ui,sans-serif}
.brows{display:grid;gap:7px}
/* 四列：标签 / 条 / 数字 / 说明。标签定宽让所有条形左端对齐——
   不对齐的话眼睛得先找起点，比例就读不出来了。 */
.brow{display:grid;grid-template-columns:minmax(90px,148px) 1fr max-content;align-items:center;gap:10px}
.bl{color:var(--text);font-size:12px;overflow-wrap:anywhere}
.bt{height:15px;background:var(--panel-3);border:1px solid var(--line-soft);overflow:hidden}
.bt i{display:block;height:100%}
.bn{color:var(--label);font:600 12px/1 ui-monospace,monospace;white-space:nowrap}
.bn b{color:var(--strong)}
.bh{grid-column:2/4;color:var(--muted);font-size:11px;margin-top:-3px}
.note{margin:12px 0 0;color:var(--muted);font-size:12px;line-height:1.6}

/* ---- 名单折叠 ---- */
.roster>summary{cursor:pointer;padding:11px 14px;border:1px solid var(--line);background:var(--panel-2);color:var(--strong);font:600 13px/1 ui-monospace,monospace}
.roster[open]>summary{margin-bottom:16px}
.cov{margin-left:auto;color:var(--label);font:600 12px/1 ui-monospace,monospace}
.why{padding:12px 18px;border-bottom:1px solid var(--line-soft);color:var(--text);font-size:12px;background:rgba(255,173,33,.045)}
/* 公司卡一句话摘要：覆盖率 + 最硬来源 + 最空维度，放在卡头和事实网格之间 */
.card-sum{font-size:12px;color:var(--muted);padding:6px 18px 7px;border-bottom:1px solid var(--line-soft);display:flex;flex-wrap:wrap;gap:6px 14px;background:var(--panel-2)}
.card-sum b{color:var(--strong)}
.card-sum .cs-gap{color:var(--c-drop)}
/* 变更条左侧种类徽标 */
.chg-icon{display:inline-block;width:16px;text-align:center;font-style:normal;margin-right:3px;font-size:12px}
.dim{padding:14px 18px;border-bottom:1px solid var(--line-soft)}
.dim:last-child{border-bottom:0}
.dim>b{display:block;color:var(--label);font:600 12px/1 ui-monospace,monospace;letter-spacing:.08em;margin-bottom:10px}
.f{padding:8px 0 8px 12px;border-left:3px solid var(--g-unverified);margin-bottom:9px}
.f:last-child{margin-bottom:0}
.f .k{color:var(--muted);font-size:12px}
.f .v{margin:3px 0 5px;color:var(--text);font-size:13px;overflow-wrap:anywhere}
.f .s{color:var(--muted-2);font-size:12px;overflow-wrap:anywhere}
.f .s b{font:600 12px/1 ui-monospace,monospace}
.f .scroll{margin:5px 0 7px}
.empty{padding:14px 18px;color:var(--muted);font-size:13px}
.empty.flush{padding:0}
.empty b{color:var(--strong)}
ul.chg{list-style:none;margin:0;padding:0}
ul.chg li{padding:11px 14px;border:1px solid var(--line-soft);border-left-width:3px;background:var(--panel);margin-bottom:8px;font-size:13px}
ul.chg .w{color:var(--muted);font-size:12px;margin-top:4px}
ul.chg b{color:var(--strong)}
footer.foot{margin-top:56px;padding-top:22px;border-top:1px solid var(--line);color:var(--muted-2);font-size:12px}
footer.foot p{margin:0 0 8px;max-width:80ch}
@media(max-width:640px){
  .wrap{padding:22px 14px 60px}
  header.top h1{font-size:22px}
  .card>header{padding:13px 14px}
  .dim,.why,.empty{padding:12px 14px}
  .fgrid{padding:12px 14px}
  .cov{margin-left:0;width:100%}
}
@media print{
  /* 换掉整套变量，而不是逐个选择器改。深底配色印在白纸上会消失，
     这份报告是要被人存成 PDF 转发的，打印不是次要路径。
     四个级别色在白底上都验过 ≥5.3:1。 */
  :root{
    --g-statutory:#0e5e3d;--g-independent:#0d5474;--g-self:#7a4e08;--g-unverified:#485560;
    --accent:#7d4a00;--accent-soft:#7d4a00;--c-drop:#a3231a;
    --bg:#fff;--panel:#fff;--panel-2:#f4f6f8;--panel-3:#f4f6f8;--head:#eef1f4;
    --text:#14181d;--strong:#000;--muted:#3f4a55;--muted-2:#3f4a55;--label:#2b333c;
    --line:#c7cfd8;--line-soft:#dde3e9;--track:#e4e9ee;
  }
  body{background:#fff}
  nav.jump{display:none}
  th{position:static}
  .why{background:#fdf6e8}
  a{color:var(--g-independent)}
  .card,ul.chg li,.jd,.panel,.brow{break-inside:avoid}
  .scroll{overflow-x:visible}
  /* 收起的 details 打印出来只有一行 summary，名单会整节消失。
     存成 PDF 是这份报告的主要分发方式之一，所以打印时强制展开。
     必须打在 ::details-content 上：浏览器不是靠 details 自身或它的子元素来隐藏
     未展开内容的，而是靠那个伪元素插槽。改 details 或子元素的 display /
     content-visibility 都不起作用——子元素会算出 display:block，尺寸仍然是 0。 */
  .roster>summary{display:none}
  details.roster::details-content{content-visibility:visible!important;display:block!important}
  /* 边界说明同理：打印时必须展开。收起来存成 PDF，读者拿到的就是一份
     只有结论没有边界的报告——那正是这一节存在的意义的反面。 */
  details.corpus::details-content{content-visibility:visible!important;display:block!important}
}

/* ---- 报告交互工具条：搜索 / 筛选 / 阅读进度 ----
   脚本全部内联，不发任何外部请求；打印时隐藏。 */
.report-toolbar{position:sticky;top:0;z-index:60;border-bottom:1px solid var(--line);background:rgba(12,19,27,.94);backdrop-filter:blur(12px);color:var(--text)}
.rt-inner{max-width:1180px;margin:0 auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 20px}
.rt-brand{color:var(--accent);font:700 12px/1 ui-monospace,monospace;letter-spacing:.12em;text-decoration:none;white-space:nowrap}
.rt-search{display:flex;align-items:center;gap:7px;flex:1 1 220px;min-width:180px;height:32px;padding:0 10px;border:1px solid var(--line);background:var(--panel-2)}
.rt-search input{width:100%;border:0;outline:0;background:transparent;color:var(--text);font-size:13px}
.rt-search input::placeholder{color:var(--muted-2)}
.rt-select{height:32px;padding:0 8px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);font-size:12px}
.rt-count{color:var(--muted);font:600 12px/1 ui-monospace,monospace;white-space:nowrap}
.rt-link{margin-left:auto;height:32px;display:inline-flex;align-items:center;padding:0 12px;border:1px solid rgba(255,173,33,.4);color:var(--accent-soft);text-decoration:none;font:600 12px/1 ui-monospace,monospace;white-space:nowrap}
.rt-link:hover{background:rgba(255,173,33,.08)}
.rt-progress{height:2px;background:var(--track)}
.rt-progress i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--g-statutory))}
.card.hidden{display:none}
#cards .roster-empty{padding:18px;border:1px dashed var(--line);color:var(--muted);font-size:13px}
/* ---- 知识图谱 ---- */
.graph-controls{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 10px}
.graph-controls .rt-link{margin-left:0;height:30px;padding:0 11px;background:transparent;cursor:pointer;font-size:11px}
.graph-controls .rt-link.active{border-color:var(--accent);background:rgba(255,173,33,.1);color:var(--accent-soft)}
.graph-legend{display:flex;flex-wrap:wrap;gap:14px;margin:0 0 12px;color:var(--muted);font-size:12px}
.graph-legend span{display:inline-flex;align-items:center;gap:7px}
.graph-legend i{display:inline-block;width:12px;height:12px;border-radius:50%}
.graph-layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:12px;align-items:stretch}
.graph-readout{border:1px solid var(--line);background:var(--panel);padding:15px 16px;font-size:12px}
.graph-readout h3{margin:0 0 13px;color:var(--strong);font-size:14px}
.graph-readout h4{margin:16px 0 7px;color:var(--label);font:600 11px/1 ui-monospace,monospace;letter-spacing:.08em}
.graph-readout ol{list-style:none;margin:0;padding:0;display:grid;gap:5px}
.graph-readout li{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--muted)}
.graph-readout li b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font-weight:500}
.graph-readout li span{color:var(--accent);font:700 12px/1 ui-monospace,monospace}
.gr-stat{margin-bottom:13px;padding:11px 12px;border:1px solid var(--line-soft);background:var(--panel-2)}
.gr-stat b{display:block;color:var(--accent);font:700 22px/1 ui-monospace,monospace}
.gr-stat span{display:block;margin-top:7px;color:var(--muted);font-size:11px}
.kgraph{border:1px solid var(--line);background:radial-gradient(circle at 50% 48%,rgba(255,173,33,.035),transparent 55%),var(--panel-2);overflow:hidden}
@media(max-width:760px){.graph-layout{grid-template-columns:1fr}.graph-readout{order:2}}
.kgraph svg{display:block;width:100%;height:auto;min-height:420px}
.graph-node text{fill:var(--text);font-size:10px;font-family:ui-monospace,monospace;paint-order:stroke;stroke:var(--bg);stroke-width:3px}
.graph-link{transition:opacity .2s}
.graph-link.graph-link-hidden{opacity:0}

/* ---- 共现聚簇 ---- */
.cluster-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.cluster-card{border:1px solid var(--line);background:var(--panel);padding:13px 14px}
.cluster-card header{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px}
.cluster-card header b{color:var(--strong);font-size:13px}
.cluster-card header span{color:var(--muted);font:600 11px/1 ui-monospace,monospace}
.cluster-card svg{display:block;width:100%;height:auto;background:radial-gradient(circle,rgba(255,173,33,.04),transparent 70%)}
.cluster-card .hn,.cluster-card .cn{fill:var(--text);font-size:10px;font-family:ui-monospace,monospace;paint-order:stroke;stroke:var(--bg);stroke-width:3px}

/* ---- 行业 × 交付模式 ---- */
.billing-graph{border:1px solid var(--line);background:var(--panel-2);overflow:hidden}
.billing-graph svg{display:block;width:100%;height:auto;min-height:380px}
.billing-link{fill:none;stroke:rgba(255,173,33,.28)}
.billing-link:hover{stroke:rgba(255,173,33,.75)}
.bn-label{fill:var(--text);font-size:11px;font-family:ui-monospace,monospace}
.bn circle{stroke:rgba(255,255,255,.3)}

/* ---- 时间轴 ---- */
.timeline-graph{border:1px solid var(--line);background:var(--panel-2);overflow:auto}
.timeline-graph svg{display:block;min-width:720px;width:100%;height:auto}
.tl-year{stroke:var(--line-soft)}
.tl-year-label,.tl-dim-label{fill:var(--label);font-size:11px;font-family:ui-monospace,monospace}
.tl-dot{fill:var(--accent);opacity:.78}
.tl-dot:hover{opacity:1;stroke:#fff;stroke-width:1}
.timeline-legend{display:flex;align-items:center;gap:8px;margin-top:8px;color:var(--muted);font-size:12px}
.timeline-legend i{width:22px;height:7px;border-radius:99px;background:linear-gradient(90deg,rgba(255,173,33,.25),var(--accent))}
.graph-node[data-jump-card],.co-node[data-jump-card]{cursor:pointer}
.graph-node[data-jump-card]:hover circle,.co-node[data-jump-card]:hover circle{stroke:#fff;stroke-width:2}
.card-flash{animation:cardflash 1.6s ease-out}
@keyframes cardflash{0%{box-shadow:0 0 0 3px var(--accent);background:rgba(255,173,33,.12)}100%{box-shadow:none}}
@media print{.kgraph{background:#fff}.graph-node text{fill:#14181d;stroke:#fff}}
@media(max-width:640px){.kgraph svg{min-height:280px}}
@media print{.report-toolbar{display:none}.card.hidden{display:block!important}}
`;


/** 交互脚本。全部内联，无外部请求；禁用 JS 时报告仍可完整阅读。
 *  只做三件不会改变数据的事：筛选公司卡、展开/收起名单、显示阅读进度。 */
const REPORT_SCRIPT = `
(function(){
  var cards = Array.prototype.slice.call(document.querySelectorAll('#cards .card'));
  var details = document.querySelector('#cards details.roster');
  var search = document.getElementById('reportSearch');
  var rel = document.getElementById('reportRelevance');
  var listing = document.getElementById('reportListing');
  var sector = document.getElementById('reportSector');
  var count = document.getElementById('reportCount');
  var empty = document.getElementById('reportEmpty');
  var progress = document.getElementById('readingProgress');
  var toggle = document.getElementById('reportToggle');
  var defaultLimit = details ? parseInt(details.getAttribute('data-limit') || '0', 10) || cards.length : cards.length;
  var expandedAll = false;
  function textOf(card){
    return (card.getAttribute('data-search') || '') + ' ' + (card.getAttribute('data-sector') || '');
  }
  function apply(){
    if(!cards.length) return;
    var q = search && search.value.trim().toLowerCase() || '';
    var rv = rel && rel.value || '';
    var lv = listing && listing.value || '';
    var sv = sector && sector.value || '';
    var hasFilter = Boolean(q || rv || lv || sv);
    var shown = 0;
    cards.forEach(function(card, index){
      var ok = true;
      if(q && textOf(card).toLowerCase().indexOf(q) < 0) ok = false;
      if(ok && rv && card.getAttribute('data-relevance') !== rv) ok = false;
      if(ok && lv && card.getAttribute('data-listing') !== lv) ok = false;
      if(ok && sv && card.getAttribute('data-sector') !== sv) ok = false;
      var hidden = !ok || (!hasFilter && !expandedAll && index >= defaultLimit);
      card.classList.toggle('hidden', hidden);
      if(!hidden) shown++;
    });
    if(count) count.textContent = shown + ' / ' + cards.length;
    if(empty) empty.hidden = !hasFilter || shown > 0;
    if(details && hasFilter) details.open = true;
    if(toggle) toggle.textContent = (details && details.open) ? '收起公司卡' : '展开全部公司卡';
  }
  function debounce(fn, ms){ var t; return function(){ clearTimeout(t); t = setTimeout(fn, ms); }; }
  var applyLater = debounce(apply, 120);
  if(search) search.addEventListener('input', applyLater);
  if(rel) rel.addEventListener('change', apply);
  if(listing) listing.addEventListener('change', apply);
  if(sector) sector.addEventListener('change', apply);
  if(toggle && details) toggle.addEventListener('click', function(){
    expandedAll = !expandedAll;
    details.open = expandedAll;
    apply();
  });
  var graphButtons = Array.prototype.slice.call(document.querySelectorAll('[data-graph-filter]'));
  var graphLinks = Array.prototype.slice.call(document.querySelectorAll('.graph-link'));
  function applyGraph(){
    var active = 'all';
    graphButtons.forEach(function(button){
      if(button.classList.contains('active')) active = button.getAttribute('data-graph-filter') || 'all';
    });
    graphLinks.forEach(function(line){
      var kind = line.getAttribute('data-kind') || '';
      line.classList.toggle('graph-link-hidden', active !== 'all' && kind !== active);
    });
  }
  graphButtons.forEach(function(button){
    button.addEventListener('click', function(){
      graphButtons.forEach(function(item){ item.classList.remove('active'); });
      button.classList.add('active');
      applyGraph();
    });
  });
  function jumpToCard(id){
    if(!id) return;
    if(search) search.value = '';
    if(rel) rel.value = '';
    if(listing) listing.value = '';
    if(sector) sector.value = '';
    expandedAll = true;
    if(details) details.open = true;
    apply();
    var target = document.getElementById('c-' + id);
    if(target){
      target.classList.remove('card-flash');
      void target.offsetWidth;
      target.classList.add('card-flash');
      target.scrollIntoView({behavior:'smooth',block:'start'});
    }
  }
  document.addEventListener('click', function(event){
    var source = event.target && event.target.closest ? event.target.closest('[data-jump-card]') : null;
    if(source) jumpToCard(source.getAttribute('data-jump-card') || '');
  });
  window.addEventListener('scroll', function(){
    if(!progress) return;
    var h = document.documentElement;
    var max = Math.max(0, h.scrollHeight - h.clientHeight);
    var p = max ? (h.scrollTop || document.body.scrollTop || 0) / max : 1;
    progress.style.width = (p * 100).toFixed(2) + '%';
  }, {passive:true});
  apply();
})();
`;

function bar(counts: Record<SourceGrade, number>, total: number): string {
  if (!total) return `<div class="bar"></div>`;
  const parts = SOURCE_GRADES
    .filter(grade => counts[grade] > 0)

    .map(grade => `<i style="width:${((counts[grade] / total) * 100).toFixed(2)}%;background:${GRADE_COLOR[grade]}" title="${esc(GRADE_META[grade].label)} ${counts[grade]}"></i>`)
    .join("");
  return `<div class="bar" role="img" aria-label="${SOURCE_GRADES.filter(g => counts[g]).map(g => `${GRADE_META[g].label} ${counts[g]}`).join("，") || "无数据"}">${parts}</div>`;
}

/** 持股名单排成表。认不出来的返回 null，调用方按原文渲染。
 *  比例条的宽度按本表最大值归一，只用于组内比较——不同表之间不可比，
 *  因为「占总股本」和「占流通股」两种口径的数量级差得远，
 *  按 100% 归一会把 A 股那几家排成一排看不见的细线。 */
function holderTable(value: string): string | null {
  const parsed = parseHolders(value);
  if (!parsed) return null;
  const max = Math.max(...parsed.rows.map(row => Number(row.pct) || 0));
  const rows = parsed.rows.map((row, index) => {
    const num = Number(row.pct) || 0;
    const width = max > 0 ? (num / max) * 100 : 0;
    return `<tr>
<th scope="row" class="rowhead${index === 0 ? " lead" : ""}">${esc(row.name)}${row.note ? `<div class="where">${esc(row.note)}</div>` : ""}</th>
<td class="num pct">${esc(row.pct)}%
<span class="hbar" role="presentation"><i style="width:${width.toFixed(2)}%;background:${GRADE_COLOR.independent}"></i></span></td>
</tr>`;
  }).join("");
  // 引子、附注、口径全部挪进表题，一个字不动。
  // 口径尤其不能省：数字排整齐之后，只有它能说明这些数字在量什么。
  // 附注（股份类别、集中度、接口取舍）也留着——那几句每一句都限定了表里的数。
  const caption = [parsed.preamble, parsed.notes, parsed.basis].filter(Boolean).map(esc).join("　·　");
  return `<div class="scroll"><table class="holder">
${caption ? `<caption>${caption}</caption>` : ""}
<thead><tr><th scope="col">股东</th><th scope="col">持股比例</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

export type ReportNetworkNode = {
  id: string;
  type: string;
  label: string;
  sector?: string;
  city?: string;
};

export type ReportNetworkLink = {
  source: string;
  target: string;
  kind: string;
};

export type ReportNetwork = {
  nodes: ReportNetworkNode[];
  links: ReportNetworkLink[];
};

export type ReportInput = {
  profiles: CompanyProfile[];
  /** 上一版档案。给了才有变更页——第一版没有上一版，那一节就说明「首次生成」。 */
  previous?: CompanyProfile[];
  generatedAt: string;
  /** 默认展示多少张公司卡。全部公司都会渲染进文件，搜索/筛选能覆盖全库。 */
  cardLimit?: number;
  /** 人写的判断。算不出来的那类（因果解释）只能人写，不给就只出可计算的几条。 */
  manualJudgments?: ManualJudgment[];
  /** 结构化知识图谱：公司 → 投资方 / 背景标签。原语料的 network 字段。 */
  network?: ReportNetwork;
};

/** 一眼能读的比例条。参考那份研报的图用得很克制：三组分布、证据强度、完整度，
 *  都是横条 + 数字 + 占比，没有一张需要图例才能看懂的图。这里照这个来。
 *
 *  归一化按本组最大值，不按 100%：字段完整度最高才 40% 时，
 *  按 100% 归一出来是一排看不见的细线，读者只能去看右边的数字——
 *  那图就白画了。 */
function barRows(rows: BarRow[], accent: string): string {
  if (!rows.length) return `<p class="lede">没有数据。</p>`;
  const max = Math.max(...rows.map(r => r.share), 0.0001);
  return `<div class="brows">${rows.map(row => {
    const width = ((row.share / max) * 100).toFixed(1);
    const label = `${row.label} ${row.count} 家，占 ${(row.share * 100).toFixed(0)}%`;
    return `<div class="brow">
<span class="bl">${esc(row.label)}</span>
<span class="bt" role="img" aria-label="${esc(label)}"><i style="width:${width}%;background:${accent}"></i></span>
<span class="bn"><b>${row.count}</b> ${(row.share * 100).toFixed(0)}%</span>
${row.hint ? `<span class="bh">${esc(row.hint)}</span>` : ""}
</div>`;
  }).join("")}</div>`;
}

const CONFIDENCE_COLOR: Record<Confidence, string> = {
  public: "var(--g-statutory)",
  internal: "var(--g-self)",
  lead: "var(--g-unverified)",
};

/**
 * 判断页。这是整份报告改动最大的一处：原来第一节是「概览 231 家 × 30 个字段」,
 * 读者一进来就是一张热图，得自己从格子里归纳结论。
 *
 * 现在第一节是判断，每条带证据等级、支撑、反例、推论——和参考那份人写的研报
 * 同一个形态。名单和公司卡降到最后。
 *
 * 「反例」那一栏没有内容也必须渲染（写「无」）。省掉它就等于只报了对自己
 * 有利的那一半数据，那是宣传材料的写法，不是情报的写法。
 */
function renderJudgments(profiles: CompanyProfile[], manual: ManualJudgment[]): string {
  const set = buildJudgments(profiles, manual);
  if (!set.all.length) {
    return `<section id="judgment"><h2>这批公司到底怎么回事</h2>
<p class="lede">在册 ${profiles.length} 家，还算不出能站得住的判断——样本太少或者字段几乎全空。
先把资料抓起来，这一节会自己长出来。</p></section>`;
  }

  // 判断是这一节唯一必须被读完的东西，所以它独占一行、字号大一档；
  // 支撑/反例/推论沉到分割线下面，用 ✓ ✗ → 区分方向——
  // 三栏同样字号平铺时，「反例」会被当成支撑的续写读下去。
  const renderOne = (j: typeof set.all[number], index: number) => `<article class="jd">
<div class="jh">
<span class="jn">${String(index + 1).padStart(2, "0")}</span>
<h3>${esc(j.claim)}</h3>
<span class="tag" style="border-color:${CONFIDENCE_COLOR[j.confidence]};color:${CONFIDENCE_COLOR[j.confidence]}">${esc(CONFIDENCE_META[j.confidence].label)}</span>
${j.origin === "manual" ? `<span class="tag manual">人工判断</span>` : ""}
</div>
<div class="jd-ev">
<dl class="jb">
<dt><i class="ico-ok" aria-hidden="true">✓</i>支撑</dt><dd>${esc(j.support)}</dd>
<dt><i class="ico-no" aria-hidden="true">✗</i>反例</dt><dd>${esc(j.counter)}</dd>
${j.implication ? `<dt><i aria-hidden="true">→</i>推论</dt><dd>${esc(j.implication)}</dd>` : ""}
</dl>
</div>
</article>`;

  const items = set.companies.map(renderOne).join("");
  // 「我们抓到哪一步」那几条收进折叠区。
  //
  // 这是这一版最实质的改动，理由不在样式上：原来 11 条判断平铺，其中 5 条讲的是
  // 覆盖率、盲区、还有多少家没判定——而且插在第 5 条位置。读者从上往下读，
  // 刚看完两条关于公司的结论就撞上「67% 还没判定」，接收到的信息立刻变成
  // 「这个系统做完了多少」，而不是「这批公司什么样」。
  //
  // 两类都得留：边界不说清就是只报好消息。但正文只能有一类。
  const corpusBlock = set.corpus.length
    ? `<details class="corpus"><summary>另有 ${set.corpus.length} 条讲的是这份数据本身的边界——覆盖率、盲区、还有多少家没判定</summary>
<p class="lede">这几条不是关于这批公司的，是关于「我们查到哪一步」。它们决定上面那些结论能被信到什么程度，
所以必须留着；但它们不该占正文——读者要先知道这批公司什么样，再知道我们的数据有多全。</p>
<div class="jds">${set.corpus.map(renderOne).join("")}</div></details>`
    : "";

  const counts = `${set.companies.length} 条结论`
    + (set.manual.length ? `（含 ${set.manual.length} 条人写的）` : "");
  // 表跟着判断走，不放到「结构画像」那一节去：读者刚读到「政务治理 92%」，
  // 要复算就得当场看到那一格，隔一节就没人翻回来了。
  const tables = [sectorBillingTable(profiles), founderBillingTable(profiles)]
    .map(crossTable).join("");

  return `<section id="judgment">
<h2>这批公司到底怎么回事<span class="n">${counts}</span></h2>
<p class="lede">每条判断都写清了<b>支撑数据、反例、以及能不能拿出去讲</b>。
三档证据等级由支撑它的事实的来源级别推出来——一条判断的硬度不可能超过它最软的那条支撑：
${CONFIDENCE.map(c => `<b>${esc(CONFIDENCE_META[c].label)}</b>＝${esc(CONFIDENCE_META[c].hint)}`).join("；")}。</p>
<p class="lede">标了「算出来的」那几条能照着复算：每个数字都回溯到在册名单的某一行。
标「人工判断」的是人读完材料下的结论——它们更锋利，但不是确定性产物，重跑不会自己更新。</p>
<div class="jds">${items}</div>
${corpusBlock}
${tables ? `<h3 class="xth">上面几条是从这两张表里挑出来的</h3>
<p class="lede">判断只讲了差最大的那两行。表格全放在这儿，剩下那些行也许和你正在看的公司更相关——
而且能反过来检查我：判断里的百分比就是表里那一格，不一致就是我算错了。</p>
${tables}` : ""}
</section>`;
}

/** 交叉表。判断里那几句话的算术摊在这儿，读者可以自己复算，也可以看出我没说的那几行。
 *
 *  单字段统计说不出情报——「全表 126 家项目制」对任何决定都没用。
 *  换成两个字段交叉，同一批数据才开始说话：政务治理 92% 项目制、零售消费 21%。
 *  所以这两张表不是判断的附录，它们是判断的正文，判断只是把最大那个差挑出来讲了一句。 */
function crossTable(table: CrossTable | null): string {
  if (!table) return "";
  const head = table.cols.map(c =>
    `<th scope="col"${c === table.highlight ? ' class="hi"' : ""}>${esc(c)}</th>`).join("");
  const rows = table.rows.map(r => {
    const cells = r.counts.map((n, i) => {
      const col = table.cols[i];
      const hi = col === table.highlight;
      // 零就写「—」。写「0%」会让人以为量过了一个有值的样本，其实是这一格没人落进来。
      const body = n === 0
        ? `<span class="z">—</span>`
        : `<span class="pc">${Math.round(r.shares[i] * 100)}%</span><span class="ct">${n}</span>`
          + `<span class="xb"><i style="width:${Math.round(r.shares[i] * 100)}%"></i></span>`;
      return `<td class="c${hi ? " hi" : ""}">${body}</td>`;
    }).join("");
    return `<tr><th scope="row" class="rowhead">${esc(r.row)}</th>`
      + `<td class="c tot">${r.total}</td>${cells}</tr>`;
  }).join("");

  return `<div class="panel">
<h3>${esc(table.title)}<em>百分比是「这一行里占多少」，小字是家数</em></h3>
<div class="scroll xt"><table class="xt">
<caption>${esc(table.note)}</caption>
<thead><tr><th scope="col">${esc(table.rowLabel)}</th><th scope="col">本组</th>${head}</tr></thead>
<tbody>${rows}</tbody></table></div>
</div>`;
}

/** 一眼看清这批公司的形状：分布 + 缺口。图在判断之后、名单之前。 */
function renderShape(profiles: CompanyProfile[]): string {
  const listing = listingBars(profiles);
  const dims = dimensionBars(profiles);
  const fields = fieldBars(profiles).slice(0, 12);
  const empty = fieldBars(profiles).filter(f => f.count === 0);

  return `<section id="shape">
<h2>它们是谁，以及我们查到哪一步<span class="n">${profiles.length} 家</span></h2>
<p class="lede">三张图，一眼能读完。条形长度按本组最大值归一——不按 100%，
否则完整度最高才 40% 的那组会排成一排看不见的细线。</p>

<div class="two">
<div class="panel">
<h3>上市地分布<em>决定能拿到哪种披露</em></h3>
${barRows(listing, "var(--g-statutory)")}
<p class="note">上市与否不是标签，是资料天花板：未上市公司拿不到法定披露，
它那一半名单的级别上限就是自述。</p>
</div>
<div class="panel">
<h3>六个维度分别查到多少<em>分母＝字段数 × 公司数</em></h3>
${barRows(dims, "var(--g-independent)")}
<p class="note">这几条能横向比，因为分母都按各自的字段数算过。</p>
</div>
</div>

<div class="panel">
<h3>字段完整度<em>先看清缺口，再看任何结论</em></h3>
${barRows(fields, "var(--g-independent)")}
<p class="note">只列前 12 个。${empty.length
      ? `另有 <b>${empty.length}</b> 个字段全表零命中：${empty.map(f => esc(f.label)).join("、")}——
缺口本身是结论，判断第一节已经说了这件事。`
      : "所有字段都有至少一条命中。"}
凡缺口字段都保留「空」这一类，不并入其它类别，也不按比例外推。</p>
</div>
</section>`;
}

/** 概览 + 热图。 */
function renderOverview(profiles: CompanyProfile[]): string {
  const o = buildOverview(profiles);
  const pct = o.cells ? ((o.filled / o.cells) * 100).toFixed(1) : "0.0";
  const hard = o.byGrade.statutory + o.byGrade.independent;
  const hardPct = o.filled ? ((hard / o.filled) * 100).toFixed(1) : "0.0";

  const stats = [
    [String(o.companies), "在册公司"],
    [`${o.fields}`, "信息维度字段"],
    [`${pct}%`, `格子覆盖（${o.filled}/${o.cells}）`],
    [`${hardPct}%`, "其中够硬的（法定+三方）"],
  ].map(([b, s]) => `<div><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join("");

  const legend = SOURCE_GRADES.map(grade =>
    `<span class="gr"><i style="background:${GRADE_COLOR[grade]}"></i>${esc(GRADE_META[grade].label)} <b>${o.byGrade[grade]}</b> · ${esc(GRADE_META[grade].hint)}</span>`
  ).join("");

  const listing = Object.entries(o.byListing)
    .map(([key, count]) => `<span class="tag">${esc(LISTING_LABEL[key as keyof typeof LISTING_LABEL] || key)} ${count}</span>`).join(" ");
  const relevance = Object.entries(o.byRelevance)
    .map(([key, count]) => `<span class="tag">${esc(RELEVANCE_META[key as keyof typeof RELEVANCE_META]?.label || key)} ${count}</span>`).join(" ");

  // 逐维度汇总。matrix 已经按字段算好了，这里只是把同维度的字段加起来——
  // 数据层不用动，加出来的和必然和 o.filled 一致。
  const dimCards = o.matrix.map(dim => {
    const tally: Record<SourceGrade, number> = { statutory: 0, independent: 0, self: 0, unverified: 0 };
    let dimFilled = 0;
    for (const field of dim.fields) {
      dimFilled += field.filled;
      for (const grade of SOURCE_GRADES) tally[grade] += field.byGrade[grade];
    }
    const cells = o.companies * dim.fields.length;
    const dimPct = cells ? ((dimFilled / cells) * 100).toFixed(1) : "0.0";
    return `<div class="d">
<div class="t"><b>${esc(dim.dimensionLabel)}</b><em>${dim.fields.length} 字段</em><span>${dimPct}%　${dimFilled}/${cells}</span></div>
${bar(tally, cells)}
</div>`;
  }).join("");

  const rows = o.matrix.map(dim => {
    const head = `<tr class="dimhead"><td colspan="4">${esc(dim.dimensionLabel)}</td></tr>`;
    const body = dim.fields.map(field => {
      const p = o.companies ? ((field.filled / o.companies) * 100).toFixed(0) : "0";
      return `<tr>
<th scope="row" class="rowhead">${esc(field.label)}<div class="where">${esc(field.where)}</div></th>
<td class="num">${field.filled}/${o.companies}</td>
<td class="num">${p}%</td>
<td>${bar(field.byGrade, field.filled)}</td>
</tr>`;
    }).join("");
    return head + body;
  }).join("");

  return `<section id="overview">
<h2>概览<span class="n">${o.companies} 家 × ${o.fields} 个字段</span></h2>
<p class="lede">这一节回答「我们目前收集到哪些资料」。每一格只有两种状态：有出处的事实，或者空。没有出处的东西不进报告，也不算覆盖——覆盖率算得低，是为了让它算得准。</p>
<div class="stats">${stats}</div>
<div class="grades">${legend}</div>
<p class="lede">上市地：${listing}<br>与 FDE 模式的相关度：${relevance}</p>
<h3 class="subhead">六个维度分别查到哪一步</h3>
<p class="lede">条形填满的部分是有出处的格子，按来源级别分色；剩下的底色就是缺口。分母是「在册公司 × 该维度字段数」，所以这几条能横向比。</p>
<div class="dims">${dimCards}</div>
<div class="scroll"><table>
<caption>逐字段的覆盖热图。条形按来源级别分色——同样是「有值」，法定披露和未核实的意义差得远。</caption>
<thead><tr><th scope="col">字段 / 去哪儿找</th><th scope="col">有值</th><th scope="col">占比</th><th scope="col">级别分布</th></tr></thead>
<tbody>${rows}</tbody></table></div>
</section>`;
}

/** 公司卡。 */
function renderCards(profiles: CompanyProfile[], limit: number): string {
  const rankedAll = rankProfiles(profiles);
  const shown = rankedAll;
  const visibleLimit = Math.min(limit, shown.length);
  const cards = shown.map((profile, index) => {
    const overLimit = index >= visibleLimit;
    const cover = coverageOf(profile);

    // 搜索索引：不仅搜公司名，也搜卡片正文里的所有事实值。
    // 这样搜「广联达」能找到创始人曾在广联达干过的公司，而不只是名字带广联达的公司。
    const searchText = [
      profile.name, profile.legalName || "", profile.ticker || "", profile.city || "", profile.sector || "", profile.relevanceReason || "",
      ...DIMENSIONS.flatMap(dim => dim.fields.map(field => {
        const entry = fact(profile, dim.id, field.key);
        return entry ? String(entry.value).slice(0, 200) : "";
      })),
    ].filter(Boolean).join(" ");

    const tags = [
      // 主动盯的公司要标出来。一张整片空白的卡如果不说明「这是我们主动列进来待抓的」，
      // 读的人会以为是数据坏了，而不是待办。
      profile.watchlist ? `<span class="tag watch">重点盯</span>` : "",
      `<span class="tag">${esc(LISTING_LABEL[profile.listing])}</span>`,
      profile.ticker ? `<span class="tag">${esc(profile.ticker)}</span>` : "",
      `<span class="tag">${esc(RELEVANCE_META[profile.relevance].label)}</span>`,
      profile.sector ? `<span class="tag">${esc(profile.sector)}</span>` : "",
      profile.city ? `<span class="tag">${esc(profile.city)}</span>` : "",
    ].filter(Boolean).join(" ");

    // 30 个格子的缩略图，按维度分成 6 组。填了的按来源级别上色，空的留底色。
    // 卡片本身有一屏多长，看完才知道这家查到哪一步；这一排在最上面先把结论给出来。
    const grid = DIMENSIONS.map(dim => {
      const cells = dim.fields.map(field => {
        const entry = fact(profile, dim.id, field.key);
        const label = entry
          ? `${dim.label} / ${field.label}：${GRADE_META[entry.grade].label}`
          : `${dim.label} / ${field.label}：空`;
        const fill = entry ? ` style="background:${GRADE_COLOR[entry.grade]}"` : "";
        return `<i${fill} title="${esc(label)}"></i>`;
      }).join("");
      const seen = cover.byDimension[dim.id];
      return `<span class="g" role="img" aria-label="${esc(dim.label)} ${seen ? seen.filled : 0}/${dim.fields.length} 有出处">${cells}</span>`;
    }).join("");

    const dims = DIMENSIONS.map(dim => {
      const items = dim.fields.map(field => {
        const entry = fact(profile, dim.id, field.key);
        if (!entry) return "";
        const url = entry.sourceUrl
          ? ` · <a href="${esc(entry.sourceUrl)}" rel="noreferrer noopener">出处链接</a>`
          : "";
        // 持股名单是唯一天然是表的字段：机器生成的、格式统一的、十来个「名字 + 比例」。
        // 之前渲染成一整段散文，十个股东挤在一行里读不出谁大谁小。
        const table = holderTable(String(entry.value));
        const value = table || `<div class="v">${esc(entry.value)}</div>`;
        return `<div class="f" style="border-left-color:${GRADE_COLOR[entry.grade]}">
<div class="k">${esc(field.label)}</div>
${value}
<div class="s"><b>[${esc(GRADE_META[entry.grade].label)}]</b> ${esc(entry.source)} · 抓取 ${esc(entry.fetchedAt)}${url}</div>
</div>`;
      }).filter(Boolean).join("");
      if (!items) {
        return `<div class="dim"><b>${esc(dim.label)}</b><div class="empty flush">整项未核实——${esc(dim.fields.length)} 个字段全空。<b>这是待办，不是结论。</b></div></div>`;
      }
      return `<div class="dim"><b>${esc(dim.label)}</b>${items}</div>`;
    }).join("");

    const why = profile.relevanceReason
      ? `<div class="why">为什么这样归类：${esc(profile.relevanceReason)}</div>`
      : "";

    // 一句话摘要：覆盖率 + 最硬来源 + 最空维度。
    // 卡片本身有一屏多长，读者得滚完才能归纳；这一行在最顶上先把结论给出来。
    const hardestGrade = (() => {
      for (const grade of SOURCE_GRADES) {
        const found = DIMENSIONS.some(dim => dim.fields.some(f => {
          const e = fact(profile, dim.id, f.key);
          return e && e.grade === grade;
        }));
        if (found) return grade;
      }
      return null;
    })();
    const emptyDims = DIMENSIONS
      .filter(dim => !dim.fields.some(f => fact(profile, dim.id, f.key)))
      .map(dim => dim.label);
    const coverPct = cover.total ? Math.round((cover.filled / cover.total) * 100) : 0;
    const summaryParts = [
      `<b>${cover.filled}/${cover.total}</b> 格有出处（${coverPct}%）`,
      hardestGrade ? `最硬：<b>${esc(GRADE_META[hardestGrade].label)}</b>` : null,
      emptyDims.length
        ? `<span class="cs-gap">缺口：${emptyDims.slice(0, 2).map(esc).join("、")}${emptyDims.length > 2 ? `等 ${emptyDims.length} 项` : ""}</span>`
        : `<span style="color:var(--g-statutory)">六维均有命中</span>`,
    ].filter(Boolean).join(" · ");

    return `<article class="card${overLimit ? " over-limit hidden" : ""}" id="c-${esc(profile.id)}"
data-search="${esc(searchText)}"
data-relevance="${esc(profile.relevance)}"
data-listing="${esc(profile.listing)}"
data-sector="${esc(profile.sector || "")}">
<header>
<h3>${esc(profile.name)}</h3>
${profile.legalName && profile.legalName !== profile.name ? `<span class="meta">${esc(profile.legalName)}</span>` : ""}
${tags}
<span class="cov">${cover.filled}/${cover.total} 格有出处</span>
</header>
${why}
<div class="card-sum">${summaryParts}</div>
<div class="fgrid">${grid}<span class="lg">每格一个字段，按六个维度分组；上色的有出处，颜色即来源级别</span></div>
${dims}
</article>`;
  }).join("");

  const omitted = rankedAll.length - visibleLimit;
  const note = omitted > 0
    ? `<p class="lede">默认只展示排序靠前的 ${visibleLimit} 家；其余 ${omitted} 家仍在库里，<b>用顶部搜索或筛选可以直接检索全部 ${rankedAll.length} 家</b>。</p>`
    : "";
  // 名单默认收起来。
  //
  // 卡片全部渲染、默认只显示前 N 家：这样搜索和筛选能覆盖整库，
  // 而不是只搜得到恰好排进前 60 的那一部分。
  return `<section id="cards"><h2>全量名单<span class="n">${visibleLimit} / ${rankedAll.length}</span></h2>
<p class="lede">默认收起。判断和图在前面几节，这里是原始材料——要核某一条时再展开。
每条事实后面都跟着级别、出处和抓取时间。看到 <b style="color:${GRADE_COLOR.unverified}">[未核实]</b> 就当没有——它的作用是标出缺口，不是充数。</p>
${note}<details class="roster" data-limit="${visibleLimit}"><summary>展开 ${visibleLimit} 张重点公司卡 · 全库 ${rankedAll.length} 家</summary>${cards}<div id="reportEmpty" class="roster-empty" hidden>没有匹配的公司，换个关键词或清空筛选。</div></details></section>`;
}

/** 变更条的色标也走变量，理由同 GRADE_COLOR：打印时要能整套换掉。 */
const CHANGE_COLOR: Record<Change["kind"], string> = {
  "company-added": "var(--g-statutory)",
  "company-dropped": "var(--c-drop)",
  "fact-added": "var(--g-statutory)",
  "fact-changed": "var(--accent)",
  "fact-dropped": "var(--c-drop)",
  "grade-changed": "var(--g-independent)",
};

function clip(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 变更条。分组渲染时公司名已经在组标题上，条目里不再重复——
 *  同一家补了八个字段，重复八遍公司名会把真正在变的字段名挤到看不见。 */
const KIND_ICON: Record<Change["kind"], string> = {
  "company-added": "＋",
  "company-dropped": "－",
  "fact-added": "↑",
  "fact-changed": "⟳",
  "fact-dropped": "↓",
  "grade-changed": "△",
};

function renderChange(change: Change): string {
  const color = CHANGE_COLOR[change.kind];
  const icon = KIND_ICON[change.kind];
  const li = (title: string, detail: string) =>
    `<li style="border-left-color:${color}"><b><i class="chg-icon" style="color:${color}" aria-hidden="true">${icon}</i>${title}</b><div class="w">${detail}</div></li>`;
  switch (change.kind) {
    case "company-added":
      return li("新增公司", "本次更新纳入名单，字段待抓取");
    case "company-dropped":
      return li("移出名单", "上一版有、本版没有，需要说明原因");
    case "fact-added":
      return li(`补上「${esc(change.field)}」`, `[${esc(GRADE_META[change.grade].label)}] ${esc(clip(String(change.value)))}`);
    case "fact-changed":
      return li(`「${esc(change.field)}」变了`, `原：${esc(clip(change.from, 80))}<br>现：[${esc(GRADE_META[change.grade].label)}] ${esc(clip(change.to, 80))}`);
    case "fact-dropped":
      return li(`「${esc(change.field)}」消失`, `上一版为：${esc(clip(change.was, 80))}。一条事实从报告里没了，本身要解释`);
    case "grade-changed":
      return li(`「${esc(change.field)}」来源升降级`, `${esc(GRADE_META[change.from].label)} → ${esc(GRADE_META[change.to].label)}（值没变，出处换了）`);
  }
}

function renderChanges(changes: Change[] | null): string {
  if (!changes) {
    return `<section id="changes"><h2>本次更新</h2>
<p class="lede">这是第一版，没有可比的上一版。下一次重跑之后，这里会逐条列出新增公司、补上的字段、变过的值，以及来源升降级。</p></section>`;
  }
  if (!changes.length) {
    return `<section id="changes"><h2>本次更新<span class="n">0 项</span></h2>
<p class="lede">和上一版逐字段比对，没有任何变化。这通常意味着抓取没跑成，或者源站没更新——值得看一眼，不是好消息。</p></section>`;
  }
  const order: Change["kind"][] = ["company-added", "fact-added", "grade-changed", "fact-changed", "fact-dropped", "company-dropped"];
  const sorted = [...changes].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  // 按类型汇总一行。87 项平铺时，「这一轮到底发生了什么」得自己一条条数。
  const byKind = order
    .map(kind => ({ kind, count: sorted.filter(change => change.kind === kind).length }))
    .filter(item => item.count > 0);
  const KIND_LABEL: Record<Change["kind"], string> = {
    "company-added": "新增公司", "company-dropped": "移出名单",
    "fact-added": "补上字段", "fact-changed": "值变了",
    "fact-dropped": "字段消失", "grade-changed": "来源升降级",
  };
  const summary = byKind.map(item =>
    `<span class="gr"><i style="background:${CHANGE_COLOR[item.kind]}"></i><span style="color:${CHANGE_COLOR[item.kind]};font-family:ui-monospace,monospace" aria-hidden="true">${KIND_ICON[item.kind]}</span> ${esc(KIND_LABEL[item.kind])} <b>${item.count}</b></span>`).join("");

  // 再按公司分组。同一家公司这一轮补了七八个字段是常态，平铺就是公司名重复七八遍，
  // 而且看不出「这一轮主要推进了哪几家」——那恰好是读变更页最想知道的事。
  // 组内保持上面的类型顺序，组间按条数多的在前：推进最大的那几家排最上面。
  const groups = new Map<string, { name: string; items: Change[] }>();
  for (const change of sorted) {
    const bucket = groups.get(change.id) || { name: change.name, items: [] };
    bucket.items.push(change);
    groups.set(change.id, bucket);
  }
  const ordered = [...groups.values()].sort((a, b) =>
    b.items.length - a.items.length || a.name.localeCompare(b.name, "zh"));
  const blocks = ordered.map(group => `<div class="chgroup">
<h3>${esc(group.name)}<span>${group.items.length} 项</span></h3>
<ul class="chg">${group.items.map(renderChange).join("")}</ul>
</div>`).join("");

  return `<section id="changes"><h2>本次更新<span class="n">${changes.length} 项 · ${ordered.length} 家公司</span></h2>
<p class="lede">和上一版逐字段比对的结果。「来源升降级」是里面最有价值的一类——值没变，但从通稿换成了年报。</p>
<div class="grades">${summary}</div>
<p class="lede">按公司分组，条数多的排前面——那几家就是这一轮推进最大的。</p>
${blocks}</section>`;
}

/** 待办：无人化的输入。抓取器读这一节决定下一轮抓什么，不需要人排任务。 */
function renderGaps(profiles: CompanyProfile[]): string {
  const gaps = findGaps(profiles, 60);
  if (!gaps.length) {
    return `<section id="gaps"><h2>下一轮该抓什么</h2><p class="lede">没有可自动补的缺口了。</p></section>`;
  }
  const rows = gaps.map(gap => `<tr>
<th scope="row" class="rowhead">${esc(gap.name)}</th>
<td>${esc(LISTING_LABEL[gap.listing])}</td>
<td>${esc(gap.field)}</td>
<td><span class="tag" style="border-color:${GRADE_COLOR[gap.reachable]};color:${GRADE_COLOR[gap.reachable]}">${esc(GRADE_META[gap.reachable].label)}</span></td>
<td class="where">${esc(gap.where)}</td>
</tr>`).join("");
  return `<section id="gaps"><h2>下一轮该抓什么<span class="n">前 ${gaps.length} 条</span></h2>
<p class="lede">按「这个字段最高能拿到什么级别的来源」排序：能拿到法定披露的排最前，因为那一格补上之后是硬的。拿不到的字段不列——列了只是噪音。</p>
<div class="scroll"><table>
<thead><tr><th scope="col">公司</th><th scope="col">上市地</th><th scope="col">缺哪个字段</th><th scope="col">可达级别</th><th scope="col">去哪儿抓</th></tr></thead>
<tbody>${rows}</tbody></table></div></section>`;
}



/** 知识图谱。数据来自原语料的 network 字段：公司 → 投资方 / 背景标签。
 *  布局是确定性的同心圆：公司在外环、投资方和背景标签在内环，
 *  高连接度的枢纽更大、更靠近中心，边按关系类型着色。
 *  全部是内联 SVG，不依赖任何外部图库。 */
function renderKnowledgeGraph(network: ReportNetwork | undefined, profiles: CompanyProfile[]): string {
  if (!network?.nodes?.length) {
    return `<section id="graph"><h2>知识图谱</h2><p class="lede">这一版没有附带网络关系数据。带 network 字段重跑即可生成。</p></section>`;
  }

  const nodes = network.nodes;
  const links = network.links.filter(link =>
    nodes.some(n => n.id === link.source) && nodes.some(n => n.id === link.target)
  );
  const degree = new Map<string, number>();
  for (const link of links) {
    degree.set(link.source, (degree.get(link.source) || 0) + 1);
    degree.set(link.target, (degree.get(link.target) || 0) + 1);
  }

  const companies = nodes.filter(n => n.type === "company").sort((a, b) =>
    String(a.sector || "").localeCompare(String(b.sector || ""), "zh") || a.id.localeCompare(b.id));
  const hubs = nodes.filter(n => n.type !== "company").sort((a, b) =>
    (degree.get(b.id) || 0) - (degree.get(a.id) || 0) || a.label.localeCompare(b.label, "zh"));

  const hash = (text: string) => {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) { value ^= text.charCodeAt(i); value = Math.imul(value, 16777619); }
    return (value >>> 0) / 4294967295;
  };
  const SECTOR_COLORS = ["#4fc3f7", "#81c784", "#ffb74d", "#ba68c8", "#4db6ac", "#f06292", "#aed581", "#7986cb", "#e57373", "#90a4ae", "#fff176", "#4dd0e1"];
  const colorOf = (node: ReportNetworkNode, isHub: boolean) => {
    if (isHub) return node.type === "investor" ? "#ffad21" : "#56c8d8";
    const sector = node.sector || "未归类";
    return SECTOR_COLORS[Math.floor(hash(sector) * SECTOR_COLORS.length)];
  };

  const place = (items: ReportNetworkNode[], rx: number, ry: number) => items.map((node, index) => {
    const angle = (index / Math.max(items.length, 1)) * Math.PI * 2 - Math.PI / 2;
    return { node, x: 500 + Math.cos(angle) * rx, y: 350 + Math.sin(angle) * ry };
  });
  const companyPos = place(companies, 420, 275);
  const hubPos = place(hubs, 235, 160);
  const pos = new Map<string, { x: number; y: number }>();
  for (const item of [...companyPos, ...hubPos]) pos.set(item.node.id, item);

  const linkSvg = links.map((link) => {
    const a = pos.get(link.source), b = pos.get(link.target);
    if (!a || !b) return "";
    const color = link.kind === "investor" ? "rgba(255,173,33,.18)" : "rgba(86,200,216,.15)";
    return `<line class="graph-link graph-link-${esc(link.kind)}" data-kind="${esc(link.kind)}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${color}" stroke-width="1" vector-effect="non-scaling-stroke"><title>${esc(link.kind === "investor" ? "投资关系" : "背景关系")}</title></line>`;
  }).join("");

  const profileByLabel = new Map<string, CompanyProfile>();
  for (const profile of profiles) {
    profileByLabel.set(profile.name, profile);
    if (profile.legalName) profileByLabel.set(profile.legalName, profile);
    for (const alias of profile.aliases || []) profileByLabel.set(alias, profile);
  }

  const nodeSvg = [...companyPos, ...hubPos].map(({ node, x, y }) => {
    const deg = degree.get(node.id) || 0;
    const isHub = node.type !== "company";
    const radius = isHub ? 3.5 + Math.min(11, deg * 0.9) : 3.5 + Math.min(12, deg * 1.1);
    const label = deg >= (isHub ? 3 : 4) ? node.label : "";
    const jumpProfile = isHub ? undefined : profileByLabel.get(node.label);
    const jumpAttr = jumpProfile ? ` data-jump-card="${esc(jumpProfile.id)}"` : "";
    const kindLabel = node.type === "company" ? "公司" : node.type === "investor" ? "投资方" : "背景标签";
    return `<g class="graph-node type-${esc(node.type)}" data-id="${esc(node.id)}"${jumpAttr} transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
<circle r="${radius.toFixed(1)}" fill="${colorOf(node, isHub)}" fill-opacity="${isHub ? ".9" : ".82"}" stroke="rgba(255,255,255,.28)" stroke-width="1"><title>${esc(node.label)} · ${esc(kindLabel)} · ${deg} 条关系${node.sector ? ` · ${esc(node.sector)}` : ""}${node.city ? ` · ${esc(node.city)}` : ""}</title></circle>
${label ? `<text y="${(radius + 10).toFixed(1)}" text-anchor="middle" class="gn">${esc(label.length > 14 ? label.slice(0, 13) + "…" : label)}</text>` : ""}
</g>`;
  }).join("");

  const topHubs = hubs.slice(0, 5).map(node => ({ node, deg: degree.get(node.id) || 0 }));
  const topCompanies = companies.slice().sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0)).slice(0, 5)
    .map(node => ({ node, deg: degree.get(node.id) || 0 }));
  const avgCompanyDeg = companies.length ? (companies.reduce((sum, node) => sum + (degree.get(node.id) || 0), 0) / companies.length).toFixed(1) : "0";
  const readout = `
<aside class="graph-readout">
<h3>图里一眼能看到的</h3>
<div class="gr-stat"><b>${avgCompanyDeg}</b><span>平均每家公司连接数</span></div>
<h4>连接最多的背景</h4>
<ol>${topHubs.map(item => `<li><b>${esc(item.node.label)}</b><span>${item.deg}</span></li>`).join("")}</ol>
<h4>连接最多的公司</h4>
<ol>${topCompanies.map(item => `<li><b>${esc(item.node.label)}</b><span>${item.deg}</span></li>`).join("")}</ol>
</aside>`;

  return `<section id="graph"><h2>知识图谱<span class="n">${companies.length} 家公司 · ${hubs.length} 个投资方/背景 · ${links.length} 条关系</span></h2>
<p class="lede">外环是公司，按行业聚在一起；内环是投资方与背景标签。点越大，连接越多。
这不是结论图，而是「谁和谁通过什么被连在一起」的索引用图——每一条边的原始依据仍在公司卡里。</p>
<div class="graph-controls" role="group" aria-label="关系类型筛选">
<button class="rt-link active" data-graph-filter="all" type="button">显示全部</button>
<button class="rt-link" data-graph-filter="investor" type="button">只看投资关系</button>
<button class="rt-link" data-graph-filter="background" type="button">只看背景关系</button>
</div>
<div class="graph-legend">
<span><i style="background:#4fc3f7"></i>公司（按行业着色）</span>
<span><i style="background:#ffad21"></i>投资方</span>
<span><i style="background:#56c8d8"></i>背景标签</span>
<span><i style="background:rgba(255,173,33,.45)"></i>投资关系</span>
<span><i style="background:rgba(86,200,216,.45)"></i>背景关系</span>
</div>
<div class="graph-layout">${readout}<div class="kgraph"><svg viewBox="0 0 1000 700" role="img" aria-label="FDE 公司知识图谱">${linkSvg}${nodeSvg}</svg></div></div>
</section>`;
}



function profileByLabelMap(profiles: CompanyProfile[]): Map<string, CompanyProfile> {
  const map = new Map<string, CompanyProfile>();
  for (const profile of profiles) {
    map.set(profile.name, profile);
    if (profile.legalName) map.set(profile.legalName, profile);
    for (const alias of profile.aliases || []) map.set(alias, profile);
  }
  return map;
}

/** 共现聚簇图：同一个投资方 / 背景标签把哪些公司连在一起。
 *  每个聚簇是一张小图，中央是投资方或背景标签，外圈是公司；点公司跳公司卡。 */
function renderCooccurrence(network: ReportNetwork | undefined, profiles: CompanyProfile[]): string {
  if (!network?.nodes?.length || !network.links?.length) {
    return `<section id="co-graph"><h2>共现聚簇图</h2><p class="lede">没有网络数据，无法生成公司共现图。</p></section>`;
  }
  const byLabel = profileByLabelMap(profiles);
  const nodes = new Map(network.nodes.map(n => [n.id, n]));
  const links = network.links.filter(l => nodes.has(l.source) && nodes.has(l.target));
  const degree = new Map<string, number>();
  for (const link of links) {
    degree.set(link.source, (degree.get(link.source) || 0) + 1);
    degree.set(link.target, (degree.get(link.target) || 0) + 1);
  }
  const hubs = network.nodes.filter(n => n.type !== "company" && (degree.get(n.id) || 0) >= 2)
    .sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0)).slice(0, 8);
  const hubColor = (kind: string) => kind === "investor" ? "#ffad21" : "#56c8d8";
  const sectorColor = (sector?: string) => {
    const colors = ["#4fc3f7", "#81c784", "#ffb74d", "#ba68c8", "#4db6ac", "#f06292", "#aed581", "#7986cb", "#e57373", "#4dd0e1"];
    let h = 2166136261;
    const text = sector || "";
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return colors[(h >>> 0) % colors.length];
  };

  const clusters = hubs.map(hub => {
    const companyIds = links.filter(l => l.source === hub.id || l.target === hub.id)
      .map(l => l.source === hub.id ? l.target : l.source)
      .filter(id => nodes.get(id)?.type === "company");
    const seen = new Set<string>();
    const companies = companyIds.filter(id => seen.has(id) ? false : (seen.add(id), true));
    const w = 230, h = 180, cx = w / 2, cy = h / 2, r = Math.min(72, 24 + companies.length * 3.2);
    const linksSvg = companies.map((id, i) => {
      const angle = (i / Math.max(companies.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(angle) * r, y = cy + Math.sin(angle) * r;
      const kind = links.find(l => (l.source === hub.id && l.target === id) || (l.target === hub.id && l.source === id))?.kind || "";
      return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${hubColor(kind)}" stroke-opacity=".3" stroke-width="1"><title>${esc(kind === "investor" ? "投资关系" : "背景关系")}</title></line>`;
    }).join("");
    const companySvg = companies.map((id, i) => {
      const node = nodes.get(id)!;
      const angle = (i / Math.max(companies.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(angle) * r, y = cy + Math.sin(angle) * r;
      const jump = byLabel.get(node.label)?.id;
      const attr = jump ? ` data-jump-card="${esc(jump)}"` : "";
      return `<g class="co-node company"${attr} transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
<circle r="4" fill="${sectorColor(node.sector)}" stroke="rgba(255,255,255,.35)"><title>${esc(node.label)}${node.sector ? ` · ${esc(node.sector)}` : ""}</title></circle>
${companies.length <= 14 ? `<text y="11" text-anchor="middle" class="cn">${esc(node.label.length > 10 ? node.label.slice(0, 9) + "…" : node.label)}</text>` : ""}
</g>`;
    }).join("");
    return `<article class="cluster-card"><header><b>${esc(hub.label)}</b><span>${companies.length} 家 · ${hub.type === "investor" ? "投资方" : "背景标签"}</span></header>
<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(hub.label)} 的公司聚簇">${linksSvg}${companySvg}
<g transform="translate(${cx},${cy})"><circle r="8" fill="${hubColor(hub.type)}"><title>${esc(hub.label)}</title></circle><text y="-12" text-anchor="middle" class="hn">${esc(hub.label.length > 12 ? hub.label.slice(0, 11) + "…" : hub.label)}</text></g>
</svg></article>`;
  }).join("");

  return `<section id="co-graph"><h2>共现聚簇图<span class="n">${hubs.length} 个核心聚簇</span></h2>
<p class="lede">每个聚簇的中心是一个投资方或背景标签，外圈是通过它连在一起的公司。
这是「同一拨人 / 同一类出身会同时出现在哪些公司」的网络视角。点任意公司节点会跳到下面的公司卡。</p>
<div class="cluster-grid">${clusters}</div></section>`;
}

/** 行业 × 交付模式网络图：左侧行业、右侧计费/交付模式，线的粗细是公司数。 */
function renderBillingNetwork(profiles: CompanyProfile[]): string {
  const sectorCount = new Map<string, number>();
  const billingCount = new Map<string, number>();
  const pairs = new Map<string, number>();

  for (const profile of profiles) {
    const entry = fact(profile, "business", "pricing");
    if (!entry?.value) continue;
    const billing = (entry.label || String(entry.value).split(/[（(]/)[0].trim()).slice(0, 16);
    const sector = profile.sector || "未归类";
    sectorCount.set(sector, (sectorCount.get(sector) || 0) + 1);
    billingCount.set(billing, (billingCount.get(billing) || 0) + 1);
    const key = `${sector}||${billing}`;
    pairs.set(key, (pairs.get(key) || 0) + 1);
  }

  if (!pairs.size) return `<section id="billing-graph"><h2>行业 × 交付模式网络图</h2><p class="lede">还没有足够的计费模式数据。</p></section>`;

  const sectors = [...sectorCount.keys()].sort((a, b) => sectorCount.get(b)! - sectorCount.get(a)!);
  const billings = [...billingCount.keys()].sort((a, b) => billingCount.get(b)! - billingCount.get(a)!);
  const rowH = 64, top = 50, leftX = 190, rightX = 830;
  const height = Math.max(sectors.length, billings.length) * rowH + top;
  const yOf = (index: number, count: number) => top + index * rowH + (Math.max(count, 1) ? (height - top) / Math.max(count, 1) / 2 : 0);

  const lines = [...pairs.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => {
    const [sector, billing] = key.split("||");
    const y1 = yOf(sectors.indexOf(sector), sectors.length);
    const y2 = yOf(billings.indexOf(billing), billings.length);
    const width = 1 + Math.min(7, Math.sqrt(count) * 1.6);
    return `<path class="billing-link" d="M ${leftX} ${y1.toFixed(1)} C ${(leftX + rightX) / 2} ${y1.toFixed(1)}, ${(leftX + rightX) / 2} ${y2.toFixed(1)}, ${rightX} ${y2.toFixed(1)}" stroke-width="${width.toFixed(2)}" data-count="${count}"><title>${esc(sector)} × ${esc(billing)}：${count} 家</title></path>`;
  }).join("");

  const sectorNodes = sectors.map((sector, index) => {
    const y = yOf(index, sectors.length);
    const r = 5 + Math.min(12, Math.sqrt(sectorCount.get(sector) || 0) * 1.7);
    return `<g class="bn sector" transform="translate(${leftX},${y.toFixed(1)})" data-filter-sector="${esc(sector)}">
<circle r="${r.toFixed(1)}" fill="#4fc3f7"><title>${esc(sector)}：${sectorCount.get(sector)} 家</title></circle>
<text x="-${(r + 8).toFixed(1)}" y="3" text-anchor="end" class="bn-label">${esc(sector)}</text>
</g>`;
  }).join("");

  const billingNodes = billings.map((billing, index) => {
    const y = yOf(index, billings.length);
    const r = 5 + Math.min(12, Math.sqrt(billingCount.get(billing) || 0) * 1.7);
    return `<g class="bn billing" transform="translate(${rightX},${y.toFixed(1)})" data-filter-billing="${esc(billing)}">
<circle r="${r.toFixed(1)}" fill="#ffad21"><title>${esc(billing)}：${billingCount.get(billing)} 家</title></circle>
<text x="${(r + 8).toFixed(1)}" y="3" text-anchor="start" class="bn-label">${esc(billing)}</text>
</g>`;
  }).join("");

  return `<section id="billing-graph"><h2>行业 × 交付模式网络图<span class="n">${sectors.length} 个行业 · ${billings.length} 种模式</span></h2>
<p class="lede">左边是行业，右边是计费/交付模式。线的粗细代表落在这条边上的公司数。
这张图回答的是：不同行业在用哪些方式交付——项目制、软硬一体、订阅还是按效果付费。</p>
<div class="billing-graph"><svg viewBox="0 0 1020 ${height}" role="img" aria-label="行业与交付模式网络">${lines}${sectorNodes}${billingNodes}</svg></div></section>`;
}

/** 时间轴热图：从所有事实原文里抽出年份，看信息在时间上的分布。 */
function renderTimeline(profiles: CompanyProfile[]): string {
  const years = new Set<number>();
  const counts = new Map<string, number>();
  const dimensionLabels: Record<string, string> = {};
  for (const dim of DIMENSIONS) dimensionLabels[dim.id] = dim.label;
  const DIM_IDS = DIMENSIONS.map(d => d.id);

  for (const profile of profiles) {
    for (const dim of DIM_IDS) {
      const fields = profile.facts[dim] || {};
      for (const entry of Object.values(fields)) {
        const found = String(entry.value).matchAll(/20\d{2}/g);
        const seenYears = new Set<number>();
        for (const m of found) {
          const y = Number(m[0]);
          if (y >= 2000 && y <= 2030) seenYears.add(y);
        }
        for (const y of seenYears) {
          years.add(y);
          const k = `${dim}||${y}`;
          counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
    }
  }

  const sortedYears = [...years].sort((a, b) => a - b);
  if (!sortedYears.length) return `<section id="timeline"><h2>时间轴</h2><p class="lede">事实原文里还没有可识别的年份。</p></section>`;

  const left = 130, right = 970, top = 46, rowH = 58;
  const width = right - left;
  const height = top + DIM_IDS.length * rowH + 20;
  const xOf = (year: number) => left + ((year - sortedYears[0]) / Math.max(1, sortedYears[sortedYears.length - 1] - sortedYears[0])) * width;
  const yOf = (index: number) => top + index * rowH + rowH / 2;

  const grid = sortedYears.map(year => `<line class="tl-year" x1="${xOf(year).toFixed(1)}" y1="${top - 12}" x2="${xOf(year).toFixed(1)}" y2="${top + DIM_IDS.length * rowH}"></line>`).join("");
  const yearLabels = sortedYears.map(year => `<text class="tl-year-label" x="${xOf(year).toFixed(1)}" y="${top - 18}" text-anchor="middle">${year}</text>`).join("");
  const rowLabels = DIM_IDS.map((dim, index) => `<text class="tl-dim-label" x="${left - 12}" y="${(yOf(index) + 3).toFixed(1)}" text-anchor="end">${esc(dimensionLabels[dim])}</text>`).join("");
  const dots: string[] = [];
  for (const [key, count] of counts) {
    const [dim, yearText] = key.split("||");
    const index = DIM_IDS.indexOf(dim as (typeof DIM_IDS)[number]);
    const year = Number(yearText);
    if (index < 0 || !sortedYears.includes(year)) continue;
    const r = 2 + Math.sqrt(count) * 2.6;
    dots.push(`<circle class="tl-dot" cx="${xOf(year).toFixed(1)}" cy="${yOf(index).toFixed(1)}" r="${r.toFixed(1)}" data-count="${count}"><title>${esc(dimensionLabels[dim])} · ${year}：${count} 条事实</title></circle>`);
  }

  const maxCount = Math.max(...counts.values(), 1);
  const legend = `<div class="timeline-legend"><span>少</span><i></i><span>${maxCount} 条</span></div>`;

  return `<section id="timeline"><h2>时间轴<span class="n">${sortedYears[0]}–${sortedYears[sortedYears.length - 1]} · ${counts.size} 个落点</span></h2>
<p class="lede">从全部事实原文里抽出的年份分布。点越大，说明那一年、那个维度有越多事实被写进报告。
它不替代来源和出处，只是告诉你资料集中在哪些时间窗口。</p>
<div class="timeline-graph"><svg viewBox="0 0 1000 ${height}" role="img" aria-label="事实年份分布时间轴">${grid}${yearLabels}${rowLabels}${dots.join("")}</svg></div>${legend}</section>`;
}


/** 报告顶部工具条。筛选项从数据里生成，避免手工维护枚举和字段漂移。 */
function reportToolbar(profiles: CompanyProfile[]): string {
  const relevance = [...new Set(profiles.map(p => p.relevance))].sort();
  const listings = [...new Set(profiles.map(p => p.listing))].sort();
  const sectors = [...new Set(profiles.map(p => p.sector).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), "zh"));

  const options = (items: Array<string | undefined>, labels: Record<string, string>, all: string) =>
    `<option value="">${all}</option>` + items.filter(Boolean).map(item => {
      const key = String(item);
      return `<option value="${esc(key)}">${esc(labels[key] || key)}</option>`;
    }).join("");

  const relevanceLabels = Object.fromEntries(Object.entries(RELEVANCE_META).map(([key, meta]) => [key, meta.label]));
  const listingLabels = Object.fromEntries(Object.entries(LISTING_LABEL).map(([key, label]) => [key, label]));

  return `<div class="report-toolbar">
<div class="rt-inner">
<a class="rt-brand" href="#top">TD · FDE 报告</a>
<label class="rt-search"><span aria-hidden="true">⌕</span><input id="reportSearch" type="search" placeholder="搜公司 / 行业 / 城市 / 代码" autocomplete="off"></label>
<select id="reportRelevance" class="rt-select" aria-label="按相关度筛选">${options(relevance, relevanceLabels, "全部相关度")}</select>
<select id="reportListing" class="rt-select" aria-label="按上市地筛选">${options(listings, listingLabels, "全部上市地")}</select>
<select id="reportSector" class="rt-select" aria-label="按行业筛选">${options(sectors, {}, "全部行业")}</select>
<span id="reportCount" class="rt-count"></span>
<button id="reportToggle" class="rt-link" type="button" style="background:transparent;cursor:pointer">展开公司卡</button>
<a class="rt-link" href="/?section=collect&tab=FDE 查询包">去查询台继续查 →</a>
</div>
<div class="rt-progress"><i id="readingProgress"></i></div>
</div>`;
}


export function renderReport(input: ReportInput): string {
  const { profiles, previous, generatedAt, cardLimit = 40, manualJudgments = [], network } = input;
  const changes = previous ? diffFor(previous, profiles) : null;
  const o = buildOverview(profiles);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>FDE 模式公司情报报告 · ${esc(generatedAt)}</title>
<link rel="icon" href="${FAVICON}">
<link rel="apple-touch-icon" href="${FAVICON}">
<style>${STYLE}</style>
</head>
<body id="top">
${reportToolbar(profiles)}
<div class="wrap">
<header class="top">
<div class="kicker">TOKENDANCE FIELD · 情报中台</div>
<h1>FDE 模式公司情报报告</h1>
<p>生成时间 ${esc(generatedAt)}　·　在册 ${o.companies} 家　·　六个信息维度、${o.fields} 个字段　·　每条事实都带出处与抓取时间</p>
<nav class="jump" aria-label="目录">
<a href="#judgment">这批公司到底怎么回事</a>
<a href="#graph">知识图谱</a>
<a href="#co-graph">共现聚簇</a>
<a href="#billing-graph">行业 × 交付</a>
<a href="#timeline">时间轴</a>
<a href="#shape">它们是谁</a>
<a href="#changes">本次更新</a>
<a href="#gaps">下一轮该抓什么</a>
<a href="#cards">全量名单</a>
<a href="#overview">逐字段覆盖热图</a>
<a href="#method">方法与数据边界</a>
</nav>
</header>
${renderJudgments(profiles, manualJudgments)}
${renderKnowledgeGraph(network, profiles)}
${renderCooccurrence(network, profiles)}
${renderBillingNetwork(profiles)}
${renderTimeline(profiles)}
${renderShape(profiles)}
${renderChanges(changes)}
${renderGaps(profiles)}
${renderCards(profiles, cardLimit)}
${renderOverview(profiles)}
<section id="method">
<h2>怎么读这份报告</h2>
<p class="lede">四个级别，按可信度从高到低：</p>
<div class="grades">${SOURCE_GRADES.map(grade =>
    `<span class="gr"><i style="background:${GRADE_COLOR[grade]}"></i><b>[${esc(GRADE_META[grade].label)}]</b> ${esc(GRADE_META[grade].hint)}</span>`).join("")}</div>
<footer class="foot">
<p>这份报告下判断，但每条判断都把算法和分母摊在旁边——「算出来的」那些能照着复算，交叉表就是它们的算术。哪一条要被拿去做决策，那一条再单独核：报告层给结论，不替人签字。</p>
<p>覆盖率算的是「有出处的格子」，不是「填过的格子」。所以它看起来偏低：空着的地方就是真的还没查到，而不是被占位符盖住了。</p>
<p>相关度（FDE 实践者 / 近似模式 / 交付商 / 待判定）默认都是「待判定」。把一家公司认定为 FDE 实践者需要 JD 原文或年报里的组织描述作依据——那正是这份报告要去查的东西，不能预先猜出来。</p>
</footer>
</section>
</div>
<script>${REPORT_SCRIPT}</script>
</body>
</html>`;
}
