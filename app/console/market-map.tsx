"use client";

// 版图视图。屏幕上这张表只做一件事：把「我们查过谁、查到什么程度」摊平。
//
// 界面上最要紧的一条规矩：空格子写「没查过」，不写 0，也不涂成和 0 一样的颜色。
// 热力图撒谎最常见的方式就是这个——没查过的格子涂成冷色，读图的人当成"这里没关系"，
// 于是一张几乎全空的图看起来像一份结论。所以三态用三种画法，图例第一行就说这件事。
//
// 单色深浅表示热度，不用彩虹色阶：彩虹会读成排名，而热度只是材料份数。

import { useMemo, useState } from "react";
import { Signal } from "../../lib/field-core";
import { RELATIONS, relationLabel } from "../../lib/ontology";
import { MapCell, MapRow, buildMarketMap, groupByBasis, scaleClaims } from "../../lib/market-map";
import { EntityKind } from "../../lib/extractor";
import { ViewHeader } from "./shared";

const KIND_LABEL: Record<EntityKind, string> = {
  legal: "法人", brand: "品牌", project: "项目",
  site: "园区 / 厂区", asset: "设备 / 资产", unknown: "待核实",
};

/** 热度→底色深浅。0 不给底色（0 由 state 决定画法，不走这里）。 */
function heatStyle(heat: number) {
  if (heat <= 0) return undefined;
  return { background: `rgba(65, 198, 204, ${Math.min(0.72, 0.16 + heat * 0.18)})` };
}

function cellText(cell: MapCell) {
  if (cell.state === "unchecked") return "";
  if (cell.state === "no-independent") return "○";
  return String(cell.heat);
}

/** 给读屏和悬停用的一句话。措辞和图例一致，不让两处对同一格说不同的话。 */
function cellLabel(cell: MapCell) {
  const where = `${cell.org} · ${relationLabel(cell.relation)}`;
  if (cell.state === "unchecked") return `${where}：没查过`;
  const reprint = cell.reprints > 0 ? `，其中 ${cell.reprints} 条是转载` : "";
  if (cell.state === "no-independent") {
    return `${where}：有 ${cell.signals.length} 条材料${reprint}，但没有独立第三方来源，热度不计`;
  }
  return `${where}：${cell.heat} 份独立材料${reprint}；${cell.admitted.length} 条六项已齐`;
}

export function MarketMapView({ signals, people, onOpenSignal }: {
  signals: Signal[]; people: string[]; onOpenSignal: (id: string) => void;
}) {
  const map = useMemo(() => buildMarketMap(signals, people), [signals, people]);
  const groups = useMemo(() => groupByBasis(scaleClaims(signals)), [signals]);
  const [picked, setPicked] = useState<{ row: MapRow; cell: MapCell } | null>(null);

  if (!map.rows.length) {
    return <>
      <ViewHeader kicker="看关系 / 版图" title="版图还是空的"
        copy="这张表按「主体 × 关系类型」摊开，格子的深浅是独立材料份数。现在没有带关系边的材料，所以没有行——不是没有关系，是还没查。" />
      <section className="map-empty">
        <h3>要画出一张能给人看的版图，先把这几类材料收进来</h3>
        <ol>
          <li><b>法定披露</b>：公告、招股书、年报、招投标结果。写明了主体全称和金额，一条能顶十条通稿。</li>
          <li><b>第三方口径的测算</b>：谈规模和份额的，必须能说清口径是营收还是出货量——口径不同的数字不可比。</li>
          <li><b>自己打听到的</b>：走「收集」里的私有情报入口。它算弱来源，进得来但抬不高热度。</li>
        </ol>
        <p className="map-empty-note">新闻通稿可以进，但同一份稿子被几家转发只算一份材料。这张表的热度按去重后的独立来源数算，转载刷不上去。</p>
      </section>
    </>;
  }

  const blankRate = map.cellCount ? Math.round(map.uncheckedCount / map.cellCount * 100) : 0;

  return <>
    <ViewHeader kicker="看关系 / 版图" title="查过谁，查到什么程度"
      copy="深浅只表示有多少份彼此不同的、来自独立第三方的材料。它是覆盖度，不是强弱排名，也不代表判断成立。" />

    <section className="map-legend">
      <span className="legend-item"><i className="swatch unchecked" />没查过（不是「没有关系」）</span>
      <span className="legend-item"><i className="swatch weak" />查过，但只有当事人自己发的或自己打听的</span>
      <span className="legend-item"><i className="swatch backed" />有独立第三方材料，数字是份数</span>
      <b className="legend-blank">{map.cellCount} 个格子里 {map.uncheckedCount} 个没查过（{blankRate}%）</b>
    </section>

    <section className="map-grid-wrap">
      <table className="map-grid">
        <caption className="sr-caption">主体与关系类型的覆盖情况。数字为独立材料份数，空格表示尚未查证。</caption>
        <thead><tr>
          <th scope="col">主体</th>
          {RELATIONS.map(relation => <th key={relation.id} scope="col">{relation.label}</th>)}
          <th scope="col">合计</th>
        </tr></thead>
        <tbody>{map.rows.map(row => <tr key={row.org}>
          <th scope="row">
            <b>{row.org}</b>
            {row.kind !== "legal" && <em className="kind-flag" title="这一行不是法人主体，跟工商数据对不上，别当成一家公司">{KIND_LABEL[row.kind]}</em>}
          </th>
          {row.cells.map(cell => <td key={cell.relation} className={`map-cell ${cell.state}`}>
            <button type="button" style={heatStyle(cell.heat)} aria-label={cellLabel(cell)} title={cellLabel(cell)}
              disabled={cell.state === "unchecked"}
              onClick={() => setPicked({ row, cell })}>{cellText(cell)}</button>
          </td>)}
          <td className="map-total">{row.heat || "—"}</td>
        </tr>)}</tbody>
      </table>
    </section>

    {picked && <section className="map-detail">
      <header>
        <div><small>{picked.row.org} · {relationLabel(picked.cell.relation)}</small>
          <h3>{picked.cell.heat} 份独立材料 · {picked.cell.signals.length} 条情报 · {picked.cell.admitted.length} 条六项已齐</h3></div>
        <button className="ghost-action" onClick={() => setPicked(null)}>收起</button>
      </header>
      {picked.cell.reprints > 0 && <p className="map-reprint">
        这些情报里有 {picked.cell.reprints} 条和别人逐字相同，是转载，已折叠成同一份材料。换个来源不等于多了一个消息源。
      </p>}
      <ul className="map-signal-list">{picked.cell.signals.map(signal => <li key={signal.id}>
        <button onClick={() => onOpenSignal(signal.id)}>
          <b>{signal.title || "未命名"}</b>
          <span>{signal.source} · {signal.constraints.sourceType === "independent" ? "独立第三方"
            : signal.constraints.sourceType === "related" ? "当事人自己发的"
            : signal.constraints.sourceType === "internal" ? "自己打听的" : "来源未标"}</span>
        </button>
      </li>)}</ul>
    </section>}

    <section className="scale-block">
      <header><small>多大的盘子</small><h3>规模数字按口径分开放</h3></header>
      {groups.length ? <>
        {groups.map(group => <article key={group.basis || "__none__"} className="scale-group">
          <b>{group.basis || "没写口径"}</b>
          {!group.basis && <em>没写口径的数字不可比，也不能拿去汇报。去补第二道门的「里面的数字按什么算」。</em>}
          <ul>{group.claims.map(claim => <li key={claim.signal.id}>
            <button onClick={() => onOpenSignal(claim.signal.id)}>
              <strong>{claim.numbers.join(" / ")}</strong>
              <span>{claim.signal.source}{claim.window ? ` · ${claim.window}` : ""}</span>
              <i className={claim.admitted ? "good" : "watching"}>{claim.admitted ? "六项已齐" : "还没过闸，现在只是主张"}</i>
            </button>
          </li>)}</ul>
        </article>)}
        <p className="scale-note">这里不合计。营收口径的 3 亿和出货量口径的 3 亿加起来是 6，而 6 什么也不是。要一个能对外说的总数，先把口径统一。</p>
      </> : <div className="empty-log">还没有谈规模的材料。「多大的盘子」需要写明口径的第三方测算，猜的数字不进这张表。</div>}
    </section>

    {map.offMap.length > 0 && <section className="map-offmap">
      <b>{map.offMap.length} 条材料没进版图</b>
      <p>它们没有标出「谁和谁」的关系边，所以没有主体 × 关系这个坐标。这些不是被丢掉了，是还差一步：</p>
      <ul>{map.offMap.slice(0, 6).map(signal => <li key={signal.id}>
        <button onClick={() => onOpenSignal(signal.id)}>{signal.title || "未命名"}<span>{signal.source}</span></button>
      </li>)}</ul>
      {map.offMap.length > 6 && <small>还有 {map.offMap.length - 6} 条。</small>}
    </section>}
  </>;
}
