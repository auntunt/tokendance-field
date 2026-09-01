// 企业关系情报本体。这里只换"看什么"，不换"怎么判断"。
// 六道约束门、Brier 校准、归因逻辑全部保留在 field-core.ts 中，未做任何修改。

export type Dimension = "资本关联" | "供应依赖" | "竞争替代" | "人事技术交叉";
export type RelationId = "equity" | "supply" | "compete" | "personnel" | "license" | "unclustered";
export type LocalScope = {
  entityScope: string;
  marketRegion: string;
  dataBasis: string;
  timeWindow: string;
  ourAccess: string;
};

/** 四个方向维度：只决定"先拷问哪一条"，不决定"能不能行动"。 */
export const DIMENSIONS: Array<{ dimension: Dimension; words: string[]; reason: string }> = [
  {
    dimension: "资本关联",
    words: ["持股", "股权", "投资", "增资", "认购", "并购", "收购", "控股", "基金", "融资"],
    reason: "是否存在可核查的出资或股权链条",
  },
  {
    dimension: "供应依赖",
    words: ["供应", "采购", "订单", "代工", "产能", "交付", "物料", "中标", "合同", "独家"],
    reason: "是否形成难以替换的单向供给关系",
  },
  {
    dimension: "竞争替代",
    words: ["竞争", "替代", "抢单", "降价", "同类", "对标", "份额", "挖角", "转单", "平替"],
    reason: "是否在同一需求上互相挤压",
  },
  {
    dimension: "人事技术交叉",
    words: ["任职", "兼任", "董事", "高管", "离职", "专利", "授权", "研发", "联合", "团队"],
    reason: "是否存在人员或技术上的重叠通道",
  },
];

/** 关系类型簇：替代原本的消费主题簇。 */
export const RELATIONS: Array<{ id: RelationId; label: string; words: string[]; hint: string }> = [
  {
    id: "equity",
    label: "投资持股",
    words: ["持股", "股权", "投资", "增资", "并购", "收购", "控股", "认购"],
    hint: "谁出钱，占多少，通过哪层主体",
  },
  {
    id: "supply",
    label: "供应采购",
    words: ["供应", "采购", "订单", "代工", "产能", "中标", "物料", "交付"],
    hint: "谁供给谁，能否被替换",
  },
  {
    id: "compete",
    label: "竞争替代",
    words: ["竞争", "替代", "份额", "对标", "降价", "平替", "抢单", "转单"],
    hint: "在哪个需求上正面冲突",
  },
  {
    id: "personnel",
    label: "人事变动",
    words: ["任职", "兼任", "董事", "高管", "离职", "挖角", "团队", "换帅", "上任"],
    hint: "谁离开了、谁上任了、同一批人同时出现在哪些主体",
  },
  {
    id: "license",
    label: "技术授权",
    words: ["专利", "授权", "许可", "技术", "研发", "联合", "标准"],
    hint: "技术从哪里流向哪里",
  },
];

/** 局部边界五问：企业关系语境下的重写。缺一项即无法过第二道门。
 *  label 写成问句而不是术语——界面上这五行是要人回答的问题，不是要人认识的名词。
 *  key 与数量是内核契约（见 tests/discipline.test.ts），只有文案可改。 */
export const SCOPE_FIELDS: Array<{ key: keyof LocalScope; label: string; placeholder: string }> = [
  { key: "entityScope", label: "涉及哪几家公司", placeholder: "写工商全称。母公司还是子公司要分清" },
  { key: "marketRegion", label: "在哪个市场或地区", placeholder: "华东 / 全国 / 某个具体客户群" },
  { key: "dataBasis", label: "里面的数字按什么算", placeholder: "营收 / 出货量 / 产能，口径是哪个" },
  { key: "timeWindow", label: "哪段时间内有效", placeholder: "2026 上半年 / 这一轮招标周期" },
  { key: "ourAccess", label: "我们能拿它做什么", placeholder: "能接触到谁、能提什么方案；没有就写没有" },
];

// ============ 人物关系测绘（B2B 客户组织测绘）============
// 目的：让销售知道该找谁、从哪条线切入。
//
// PII 边界，代码级而非自觉：人物节点只承载「公开职业事实」。
// 在范围内：姓名、雇主、部门、职务、任职时间、公开署名与演讲、董事席位。
// 不在范围内：私生活、家庭、非工作社交关系、住址、私人联系方式。
// 后者对销售也无用——决定能不能进门的是职权与汇报线，不是这个人周末做什么。
// 因此人物字段是下面这份白名单，不是自由文本框。
export type PersonRole = {
  /** 姓名。花名/外号放这里的括号内，如"林超（C师傅）"。 */
  name: string;
  /** 现雇主法人全称。人物与主体的连接点。 */
  employer: string;
  /** 部门，如"流程与数字化部"。 */
  department: string;
  /** 职务，如"总经理"。 */
  title: string;
  /** 我方正当通路：谁认识、哪次会议见过、通过哪个伙伴能递到。不是"打听到什么私事"。 */
  ourPath: string;
};

export const PERSON_FIELDS: Array<{ key: keyof PersonRole; label: string; placeholder: string }> = [
  { key: "name", label: "姓名", placeholder: "李全（全哥）" },
  { key: "employer", label: "所属主体", placeholder: "法人全称" },
  { key: "department", label: "部门", placeholder: "流程与数字化部" },
  { key: "title", label: "职务", placeholder: "总经理" },
  { key: "ourPath", label: "我方通路", placeholder: "谁认识他？哪次会议见过？没有就写明没有" },
];

/** 人物关系类型。只描述职权与工作关系，不描述私交。 */
export type PersonRelationId = "reports_to" | "decides" | "influences" | "moved_from" | "co_serves";
export const PERSON_RELATIONS: Array<{ id: PersonRelationId; label: string; hint: string }> = [
  { id: "reports_to", label: "汇报关系", hint: "谁向谁汇报（组织架构的边）" },
  { id: "decides", label: "决策权", hint: "这个人对哪类采购能拍板" },
  { id: "influences", label: "影响力", hint: "不拍板但能否决或推动" },
  { id: "moved_from", label: "履历流动", hint: "从哪家主体来的——预判业务或股权变化" },
  { id: "co_serves", label: "多主体兼任", hint: "同时出现在哪些主体" },
];

export function personRelationLabel(id: string) {
  return PERSON_RELATIONS.find(item => item.id === id)?.label || "待判定";
}
export function emptyPersonRole(): PersonRole {
  return { name: "", employer: "", department: "", title: "", ourPath: "" };
}

export const palette = ["#ff5a3d", "#ffad21", "#41c6cc", "#5796f4", "#9161e8"];

export function relationLabel(id: string) {
  return RELATIONS.find(item => item.id === id)?.label || "待聚类";
}
export function emptyScope(): LocalScope {
  return { entityScope: "", marketRegion: "", dataBasis: "", timeWindow: "", ourAccess: "" };
}
