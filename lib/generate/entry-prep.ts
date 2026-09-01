import type { DossierDatabase } from "../dossier/repository";
import type { GeneratedOpportunity } from "./opportunities";

export interface StakeholderStep {
  order: number;
  target: string;
  purpose: string;
  basisIds: string[];
}

export interface EntryQuestion {
  question: string;
  basisIds: string[];
}

export interface EntryRisk {
  risk: string;
  handling: string;
  basisIds: string[];
}

export interface EntryPrep {
  stakeholders: StakeholderStep[];
  questions: EntryQuestion[];
  risks: EntryRisk[];
}

function idsMatching(db: DossierDatabase, table: string, companyId: string, pattern: RegExp): string[] {
  if (table === "system_in_use") {
    return (db.prepare("SELECT id, category, product FROM system_in_use WHERE company_id=?").all(companyId) as Array<{id:string;category:string;product:string}>)
      .filter(row => pattern.test(`${row.category} ${row.product}`)).map(row => row.id);
  }
  return [];
}

export function generateEntryPrep(
  db: DossierDatabase,
  companyId: string,
  opportunities: GeneratedOpportunity[],
): EntryPrep {
  const allSystemIds = (db.prepare("SELECT id FROM system_in_use WHERE company_id=? ORDER BY id").all(companyId) as Array<{id:string}>).map(row => row.id);
  const allProcessIds = (db.prepare(`
    SELECT ps.id FROM process_step ps JOIN business_line bl ON bl.id=ps.business_line_id
    WHERE bl.company_id=? ORDER BY ps.id
  `).all(companyId) as Array<{id:string}>).map(row => row.id);
  const aiSystems = idsMatching(db, "system_in_use", companyId, /AecGPT|AI|大模型/);
  const platformSystems = idsMatching(db, "system_in_use", companyId, /AECOS|数据中台/);
  const managementSystems = idsMatching(db, "system_in_use", companyId, /ERP|CRM|客户|合同/);
  const firstProcess = allProcessIds[0] ? [allProcessIds[0]] : [];
  const firstAi = aiSystems[0] ? [aiSystems[0]] : allSystemIds.slice(0, 1);
  const firstPlatform = platformSystems[0] ? [platformSystems[0]] : firstAi;
  const firstManagement = managementSystems[0] ? [managementSystems[0]] : allSystemIds.slice(-1);
  return {
    stakeholders: [
      { order: 1, target: "董事长授权人", purpose: "定经营结果", basisIds: opportunities.slice(0, 1).map(row => row.id) },
      { order: 2, target: "AecGPT/AECOS 负责人", purpose: "定底座边界", basisIds: [...firstAi, ...firstPlatform] },
      { order: 3, target: "成本/施工负责人", purpose: "定试点流程", basisIds: allProcessIds.slice(0, 2) },
      { order: 4, target: "财务/安全/法务", purpose: "定上线门槛", basisIds: firstManagement },
      { order: 5, target: "一线用户", purpose: "验证效果", basisIds: allProcessIds.slice(-1) },
    ],
    questions: [
      { question: "七领域哪项已有周活、准确率、续费？", basisIds: firstAi },
      { question: "AECOS 与数据中台如何分工？", basisIds: [...firstPlatform, ...aiSystems].slice(0, 2) },
      { question: "五类 AI 场景谁单线负责？", basisIds: opportunities.slice(0, 5).map(row => row.id) },
      { question: "成本业务先改善续费还是客单价？", basisIds: allProcessIds.filter(id => /PS1|PS5/i.test(id)).slice(0, 2).concat(firstProcess).slice(0, 2) },
      { question: "输出能否定位图纸、清单和价格？", basisIds: firstProcess },
      { question: "外部模型和算力供应商是谁？", basisIds: firstManagement },
      { question: "评测是否分地区、专业、规则版本？", basisIds: firstAi },
      { question: "人工纠错是否回流？", basisIds: firstAi },
      { question: "ERP/CRM 接口与负责人是谁？", basisIds: firstManagement },
      { question: "试点验收看时间、收入还是风险？", basisIds: opportunities.slice(0, 3).map(row => row.id) },
    ].filter(item => item.basisIds.length > 0).slice(0, 10),
    risks: [
      { risk: "把公开产品当内部全量系统", handling: "先画数据流", basisIds: allSystemIds },
      { risk: "只演示通用问答", handling: "用真实工程数据验收", basisIds: allProcessIds },
      { risk: "重复建设 AecGPT", handling: "复用入口、权限、日志", basisIds: firstAi },
    ].filter(item => item.basisIds.length > 0),
  };
}
