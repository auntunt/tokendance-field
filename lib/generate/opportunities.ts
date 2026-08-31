import type { DossierDatabase } from "../dossier/repository";
import { stableId } from "../dossier/id";

export interface GeneratedOpportunity {
  id: string;
  companyId: string;
  processStepId: string;
  systemInUseId: string;
  businessStep: string;
  painPoint: string;
  aiScenario: string;
  dataPrerequisite: string;
  ownerOrgUnit: string;
  confidence: "high" | "mid" | "low";
  processSourceIds: string[];
  systemSourceIds: string[];
  sourceIds: string[];
}

interface OpportunityRule {
  process: RegExp;
  system: RegExp;
  businessStep: string;
  painPoint: string;
  aiScenario: string;
  dataPrerequisite: string;
  ownerOrgUnit: string;
}

const RULES: OpportunityRule[] = [
  {
    process: /算量|组价|投标|清标|评标/,
    system: /AecGPT|算量|计价|成本/,
    businessStep: "造价交易",
    painPoint: "图纸、清单、定额与材料价跨源核验耗时",
    aiScenario: "有引用定位的算量/组价/清标助手",
    dataPrerequisite: "图纸解析、清单规则、价格库、历史结果、人工纠错",
    ownerOrgUnit: "数字成本产品线",
  },
  {
    process: /数据接入|统一标准|组件复用|平台|生态/,
    system: /AECOS|AecGPT|数据中台/,
    businessStep: "产品研发",
    painPoint: "七大场景模型、提示与评测难统一",
    aiScenario: "AecGPT 评测与发布管理，按场景跟踪准确率/成本",
    dataPrerequisite: "评测集、版本、错误类型、调用日志、权限",
    ownerOrgUnit: "技术平台 / 各产品线",
  },
  {
    process: /客户细分|交付|服务|续费|扩品/,
    system: /AecGPT|知识|服务/,
    businessStep: "客户服务",
    painPoint: "复杂产品与规则问题依赖专家",
    aiScenario: "基于产品文档、规则库和案例的可追溯助手",
    dataPrerequisite: "文档版本、产品权限、工单、满意度与升级路径",
    ownerOrgUnit: "客户服务 / 产品线",
  },
  {
    process: /人机料|进度|安全|项目决策/,
    system: /PMSmart|项目综合决策/,
    businessStep: "项目管理",
    painPoint: "人机料与进度/成本数据分散，异常发现晚",
    aiScenario: "项目风险解释、原因定位与行动建议",
    dataPrerequisite: "PMSmart、BIM、物料、劳务、进度、成本及反馈",
    ownerOrgUnit: "数字施工产品线",
  },
  {
    process: /客户细分|合同|续费|扩品/,
    system: /ERP|CRM|合同|客户/,
    businessStep: "销售经营",
    painPoint: "大客户跨产品机会、续费和渗透难统一判断",
    aiScenario: "客户计划助手与下一最佳行动",
    dataPrerequisite: "CRM、合同、使用、续费、服务、产品关系；需统一客户主键",
    ownerOrgUnit: "客群 / 销售运营",
  },
  {
    process: /安全|隐患|项目决策/,
    system: /安全|PMSmart|视觉|隐患/,
    businessStep: "工地安全",
    painPoint: "视觉识别后仍需分级、派单和闭环",
    aiScenario: "隐患识别后的规则校验、解释与闭环助手",
    dataPrerequisite: "图像、项目/设备、隐患规则、处置与复查",
    ownerOrgUnit: "数字施工 / 安全产品",
  },
];

function sourceIdsFor(db: DossierDatabase, table: string, rowId: string): string[] {
  return db.prepare(`SELECT DISTINCT source_id FROM fact WHERE "table"=? AND row_id=? ORDER BY source_id`)
    .all(table, rowId).map((row: unknown) => (row as { source_id: string }).source_id);
}

export function generateOpportunities(db: DossierDatabase, companyId: string): GeneratedOpportunity[] {
  const processes = db.prepare(`
    SELECT ps.id, ps.name, ps.pain_point, ps.owner_org_unit, bl.name AS business_line
    FROM process_step ps JOIN business_line bl ON bl.id=ps.business_line_id
    WHERE bl.company_id=? ORDER BY bl.name, ps.seq
  `).all(companyId) as Array<{ id: string; name: string; pain_point: string; owner_org_unit: string; business_line: string }>;
  const systems = db.prepare(`
    SELECT id, category, product, vendor, covers_process_step
    FROM system_in_use WHERE company_id=? ORDER BY category, product
  `).all(companyId) as Array<{ id: string; category: string; product: string; vendor: string; covers_process_step: string }>;
  const output: GeneratedOpportunity[] = [];
  for (const rule of RULES) {
    const process = processes.find(row => rule.process.test(`${row.business_line} ${row.name} ${row.pain_point}`));
    const system = systems.find(row => rule.system.test(`${row.category} ${row.product} ${row.covers_process_step}`));
    if (!process || !system) continue;
    const processSources = sourceIdsFor(db, "process_step", process.id);
    const systemSources = sourceIdsFor(db, "system_in_use", system.id);
    if (processSources.length === 0 || systemSources.length === 0) continue;
    output.push({
      id: stableId("opportunity", companyId, process.id, system.id, rule.businessStep),
      companyId,
      processStepId: process.id,
      systemInUseId: system.id,
      businessStep: rule.businessStep,
      painPoint: rule.painPoint,
      aiScenario: rule.aiScenario,
      dataPrerequisite: rule.dataPrerequisite,
      ownerOrgUnit: rule.ownerOrgUnit,
      confidence: "mid",
      processSourceIds: processSources,
      systemSourceIds: systemSources,
      sourceIds: [...new Set([...processSources, ...systemSources])],
    });
  }
  return output;
}

export function persistOpportunities(db: DossierDatabase, opportunities: GeneratedOpportunity[]): void {
  db.transaction(() => {
    for (const row of opportunities) {
      db.prepare(`
        INSERT INTO opportunity (id, company_id, process_step_id, pain_point, ai_scenario, data_prerequisite, owner_org_unit, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET pain_point=excluded.pain_point, ai_scenario=excluded.ai_scenario,
          data_prerequisite=excluded.data_prerequisite, owner_org_unit=excluded.owner_org_unit, confidence=excluded.confidence
      `).run(row.id, row.companyId, row.processStepId, row.painPoint, row.aiScenario,
        row.dataPrerequisite, row.ownerOrgUnit, row.confidence);
      const fields = ["company_id", "process_step_id", "pain_point", "ai_scenario", "data_prerequisite", "owner_org_unit", "confidence"];
      for (const field of fields) {
        for (const sourceId of row.sourceIds) {
          db.prepare(`
            INSERT INTO fact (id, source_id, "table", row_id, field) VALUES (?, ?, 'opportunity', ?, ?)
            ON CONFLICT(source_id, "table", row_id, field) DO NOTHING
          `).run(stableId("fact", sourceId, "opportunity", row.id, field), sourceId, row.id, field);
        }
      }
      const systemField = `system_in_use:${row.systemInUseId}`;
      for (const sourceId of row.sourceIds) {
        db.prepare(`
          INSERT INTO fact (id, source_id, "table", row_id, field) VALUES (?, ?, 'opportunity', ?, ?)
          ON CONFLICT(source_id, "table", row_id, field) DO NOTHING
        `).run(stableId("fact", sourceId, "opportunity", row.id, systemField), sourceId, row.id, systemField);
      }
    }
  })();
}
