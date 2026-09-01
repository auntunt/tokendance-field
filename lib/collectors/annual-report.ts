import { contentFingerprint, stableId } from "../dossier/id";
import type { AnnualReportCollection, EvidencePointer, SourceInput } from "../dossier/types";
import { extractAnnualReport } from "../extract/annual-report";
import { splitPagedText } from "../extract/paged-text";

export interface CollectAnnualReportInput {
  companyId: string;
  companyName: string;
  industryId: string;
  industryName: string;
  url: string;
  content: string;
  reportYear: number;
  publishedAt: string;
}

export function collectAnnualReport(input: CollectAnnualReportInput): AnnualReportCollection {
  const pages = splitPagedText(input.content);
  if (pages.length === 0) throw new Error(`年报没有可解析页面：${input.url}`);
  const extracted = extractAnnualReport(pages, input.reportYear);
  if (!extracted.industryPage) throw new Error(`年报没有抽取到主要业务：${input.url}`);

  const pageSources = new Map<number, SourceInput>();
  const sourceFor = (pageNumber: number): SourceInput => {
    const existing = pageSources.get(pageNumber);
    if (existing) return existing;
    const page = pages.find(item => item.pageNumber === pageNumber);
    if (!page) throw new Error(`年报页码不存在：${pageNumber}`);
    const source: SourceInput = {
      id: stableId("src", input.url, String(pageNumber), contentFingerprint(page.text)),
      url: `${input.url}#page=${pageNumber}`,
      type: "filing",
      publishedAt: input.publishedAt,
      fingerprint: contentFingerprint(page.text),
      pageOrExcerpt: page.text.slice(0, 4_000),
    };
    pageSources.set(pageNumber, source);
    return source;
  };
  const pointer = (pageNumber: number, excerpt: string): EvidencePointer => ({
    sourceId: sourceFor(pageNumber).id,
    excerpt,
  });

  const industryEvidence = pointer(extracted.industryPage.pageNumber, extracted.industryPage.excerpt);
  const industry = {
    record: {
      id: input.industryId,
      name: input.industryName,
      upstream: "",
      downstream: "建设方、设计方、中介咨询方、施工方、制造厂商、材料供应商、建筑运营方",
      kpis: "",
      regulators: "",
    },
    evidence: {
      name: industryEvidence,
      downstream: industryEvidence,
    },
  };
  const company = {
    record: { id: input.companyId, name: input.companyName, industryId: input.industryId },
    evidence: { name: industryEvidence, industry_id: industryEvidence },
  };

  const industryTerms = extracted.terms.map(term => {
    const evidence = pointer(term.pageNumber, term.excerpt);
    return {
      record: {
        id: stableId("term", input.industryId, term.term),
        industryId: input.industryId,
        term: term.term,
        plainMeaning: term.plainMeaning,
        aliases: term.aliases,
      },
      evidence: {
        industry_id: evidence,
        term: evidence,
        plain_meaning: evidence,
        ...(term.aliases ? { aliases: evidence } : {}),
      },
    };
  });
  const businessLines = extracted.businessLines.map(line => {
    const evidence = pointer(line.pageNumber, line.excerpt);
    return {
      record: {
        id: stableId("business", input.companyId, line.name),
        companyId: input.companyId,
        name: line.name,
        revenueShare: "",
      },
      evidence: { company_id: evidence, name: evidence },
    };
  });
  const processSteps = extracted.processSteps.map(step => {
    const evidence = pointer(step.pageNumber, step.excerpt);
    const businessLineId = stableId("business", input.companyId, step.businessLineName);
    return {
      record: {
        id: stableId("process", input.companyId, step.businessLineName, String(step.seq)),
        businessLineId,
        seq: String(step.seq),
        name: step.name,
        ownerOrgUnit: step.ownerOrgUnit,
        painPoint: step.painPoint,
      },
      evidence: {
        business_line_id: evidence,
        seq: evidence,
        name: evidence,
        owner_org_unit: evidence,
        pain_point: evidence,
      },
    };
  });
  const systems = extracted.systems.map(system => {
    const evidence = pointer(system.pageNumber, system.excerpt);
    return {
      record: {
        id: stableId("system", input.companyId, system.category, system.product),
        companyId: input.companyId,
        category: system.category,
        product: system.product,
        vendor: system.vendor,
        coversProcessStep: system.coversProcessStep,
        since: String(input.reportYear),
      },
      evidence: {
        company_id: evidence,
        category: evidence,
        product: evidence,
        vendor: evidence,
        covers_process_step: evidence,
        since: evidence,
      },
    };
  });
  const financialSnapshots = extracted.financialYears.map(financial => {
    const first = financial.revenue ?? financial.netProfit ?? financial.rndExpense;
    if (!first) throw new Error(`年报 ${financial.year} 年没有财务字段`);
    const yearEvidence = pointer(first.pageNumber, first.excerpt);
    return {
      record: {
        id: stableId("financial", input.companyId, String(financial.year)),
        companyId: input.companyId,
        year: String(financial.year),
        revenue: financial.revenue?.value ?? "",
        netProfit: financial.netProfit?.value ?? "",
        rndExpense: financial.rndExpense?.value ?? "",
        itCapex: "",
        fundraisingProjects: "",
      },
      evidence: {
        company_id: yearEvidence,
        year: yearEvidence,
        ...(financial.revenue ? { revenue: pointer(financial.revenue.pageNumber, financial.revenue.excerpt) } : {}),
        ...(financial.netProfit ? { net_profit: pointer(financial.netProfit.pageNumber, financial.netProfit.excerpt) } : {}),
        ...(financial.rndExpense ? { rnd_expense: pointer(financial.rndExpense.pageNumber, financial.rndExpense.excerpt) } : {}),
      },
    };
  });
  const people = extracted.positions.map(position => {
    const evidence = pointer(position.pageNumber, position.excerpt);
    return {
      record: {
        id: stableId("person", input.companyId, position.name),
        name: position.name,
        bio: position.bio,
        stance: "decider" as const,
      },
      evidence: { name: evidence, bio: evidence, stance: evidence },
    };
  });
  const positions = extracted.positions.map(position => {
    const evidence = pointer(position.pageNumber, position.excerpt);
    const personId = stableId("person", input.companyId, position.name);
    return {
      record: {
        id: stableId("position", input.companyId, personId, position.title),
        companyId: input.companyId,
        personId,
        title: position.title,
        owns: "",
        start: "",
        end: "",
      },
      evidence: { company_id: evidence, person_id: evidence, title: evidence },
    };
  });

  return {
    sources: [...pageSources.values()].sort((a, b) => Number(a.url.match(/page=(\d+)/)?.[1]) - Number(b.url.match(/page=(\d+)/)?.[1])),
    company,
    industry,
    industryTerms,
    businessLines,
    processSteps,
    systems,
    financialSnapshots,
    people,
    positions,
  };
}
