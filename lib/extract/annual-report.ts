import { compactText, excerptAround, type PagedTextPage } from "./paged-text";

export interface LocatedValue<T> {
  value: T;
  pageNumber: number;
  excerpt: string;
}

export interface ExtractedTerm {
  term: string;
  plainMeaning: string;
  aliases: string;
  pageNumber: number;
  excerpt: string;
}

export interface ExtractedBusinessLine {
  name: string;
  revenue: string;
  yearOnYear: string;
  pageNumber: number;
  excerpt: string;
}

export interface ExtractedProcessStep {
  businessLineName: string;
  seq: number;
  name: string;
  ownerOrgUnit: string;
  painPoint: string;
  pageNumber: number;
  excerpt: string;
}

export interface ExtractedSystem {
  category: string;
  product: string;
  vendor: string;
  coversProcessStep: string;
  pageNumber: number;
  excerpt: string;
}

export interface ExtractedFinancialYear {
  year: number;
  revenue: LocatedValue<string> | null;
  netProfit: LocatedValue<string> | null;
  rndExpense: LocatedValue<string> | null;
}

export interface ExtractedPosition {
  name: string;
  title: string;
  bio: string;
  pageNumber: number;
  excerpt: string;
}

export interface AnnualReportExtraction {
  terms: ExtractedTerm[];
  businessLines: ExtractedBusinessLine[];
  processSteps: ExtractedProcessStep[];
  systems: ExtractedSystem[];
  financialYears: ExtractedFinancialYear[];
  positions: ExtractedPosition[];
  industryPage: LocatedValue<string> | null;
}

function pageContaining(pages: PagedTextPage[], pattern: RegExp): PagedTextPage | undefined {
  return pages.find(page => pattern.test(page.text));
}

function numberValue(value: string): string {
  return value.replace(/,/g, "");
}

function glossaryTerm(page: PagedTextPage, term: string, nextTerms: string[]): ExtractedTerm | null {
  const flat = compactText(page.text);
  const boundary = nextTerms.length ? `(?=(?:${nextTerms.join("|")})\\s+指|$)` : "$";
  const match = flat.match(new RegExp(`${term.replace("/", "\\/")}\\s+指\\s+(.{12,420}?)${boundary}`));
  if (!match?.[1]) return null;
  const meaning = match[1].trim().replace(/[，,]?\s*$/, "").slice(0, 180);
  return {
    term,
    plainMeaning: meaning,
    aliases: "",
    pageNumber: page.pageNumber,
    excerpt: `${term} 指 ${meaning}`,
  };
}

function extractTerms(pages: PagedTextPage[]): ExtractedTerm[] {
  const terms: ExtractedTerm[] = [];
  const glossary = pageContaining(pages, /数字建筑\s+指/);
  if (glossary) {
    const specs = [
      ["数字建筑", ["数字设计", "BIM", "CIM", "SaaS", "PaaS", "人工智能\/AI"]],
      ["BIM", ["CIM", "SaaS", "PaaS", "人工智能\/AI"]],
      ["SaaS", ["PaaS", "人工智能\/AI"]],
    ] as const;
    for (const [term, next] of specs) {
      const extracted = glossaryTerm(glossary, term, [...next]);
      if (extracted) terms.push(extracted);
    }
  }

  const platform = pageContaining(pages, /CDE\s*数据\s*集成环境[、，]/);
  if (platform) {
    const excerpt = excerptAround(platform.text, /CDE\s*数据\s*集成环境[\s\S]{0,100}ECS\s*数据\s*转换环境/, 90);
    terms.push({
      term: "CDE / GDE / ECS",
      plainMeaning: "AECOS 中的数据集成、数据连接与数据转换环境",
      aliases: "CDE、GDE、ECS",
      pageNumber: platform.pageNumber,
      excerpt,
    });
  }
  const model = pageContaining(pages, /AecGPT\s*建筑产业大模型/);
  if (model) {
    const excerpt = excerptAround(model.text, /AecGPT\s*建筑产业大模型[\s\S]{0,180}?七大领域/, 80);
    terms.push({
      term: "AecGPT",
      plainMeaning: "广联达建筑产业大模型，已在设计、交易、成本等七大领域验证",
      aliases: "建筑产业大模型",
      pageNumber: model.pageNumber,
      excerpt,
    });
  }
  const organization = pageContaining(pages, /STL\s*组织模式/);
  if (organization) {
    const excerpt = excerptAround(organization.text, /STL\s*组织模式（[^）]+）/, 80);
    const description = excerpt.match(/STL\s*组织模式（([^）]+)）/)?.[1] ?? "";
    terms.push({
      term: "STL 组织",
      plainMeaning: description,
      aliases: "单线程模式",
      pageNumber: organization.pageNumber,
      excerpt,
    });
  }
  const costing = pageContaining(pages, /工程算量、工程计价、工程数据、工程成本/);
  if (costing) {
    const excerpt = excerptAround(costing.text, /工程算量、工程计价、工程数据、工程成本[\s\S]{0,80}?产品/, 80);
    terms.push({
      term: "工程算量",
      plainMeaning: "从工程图纸或模型计算工程量，是工程造价与成本管理的输入",
      aliases: "算量",
      pageNumber: costing.pageNumber,
      excerpt,
    });
  }
  const tendering = pageContaining(pages, /AI\s*清标、AI\s*编标、AI\s*评标/);
  if (tendering) {
    const excerpt = excerptAround(tendering.text, /AI\s*算量[\s\S]{0,120}?AI\s*评标/, 80);
    terms.push({
      term: "清标 / 评标",
      plainMeaning: "工程交易中检查投标材料并辅助评审的环节",
      aliases: "清标、评标",
      pageNumber: tendering.pageNumber,
      excerpt,
    });
  }
  return terms.filter(term => term.excerpt);
}

function extractBusinessLines(pages: PagedTextPage[]): ExtractedBusinessLine[] {
  const specs = [
    { name: "数字成本", pattern: /数字成本业务[\s\S]{0,260}?营业收入\s*([\d,.]+)\s*亿元[\s\S]{0,50}?同比(下降|增长)\s*([\d.]+)%/ },
    { name: "数字施工", pattern: /数字施工业务[\s\S]{0,260}?营业收入\s*([\d,.]+)\s*亿元[\s\S]{0,50}?同比(下降|增长)\s*([\d.]+)%/ },
    { name: "数字设计", pattern: /数字设计业务[\s\S]{0,260}?营业收入\s*([\d,.]+)\s*万元[\s\S]{0,50}?同比(下降|增长)\s*([\d.]+)%/ },
    { name: "海外", pattern: /海外业务[\s\S]{0,180}?营业收入\s*([\d,.]+)\s*亿元[\s\S]{0,50}?同比(下降|增长)\s*([\d.]+)%/ },
  ];
  const output: ExtractedBusinessLine[] = [];
  for (const spec of specs) {
    for (const page of pages) {
      const match = page.text.match(spec.pattern);
      if (!match) continue;
      output.push({
        name: spec.name,
        revenue: match[1],
        yearOnYear: `${match[2] === "下降" ? "-" : "+"}${match[3]}%`,
        pageNumber: page.pageNumber,
        excerpt: compactText(match[0]),
      });
      break;
    }
  }
  const platform = pageContaining(pages, /AECOS 产业业务平台/);
  if (platform) {
    output.push({
      name: "平台与生态",
      revenue: "",
      yearOnYear: "",
      pageNumber: platform.pageNumber,
      excerpt: excerptAround(platform.text, /AECOS 产业业务平台[\s\S]{0,260}?柔性数据标准体系/, 80),
    });
  }
  return output;
}

function extractProcessSteps(pages: PagedTextPage[]): ExtractedProcessStep[] {
  const output: ExtractedProcessStep[] = [];
  const ai = pageContaining(pages, /AI\s*算量[\s\S]{0,160}?AI\s*评标/);
  if (ai) {
    const excerpt = excerptAround(ai.text, /AI\s*算量[\s\S]{0,160}?AI\s*评标/, 100);
    output.push({
      businessLineName: "数字成本",
      seq: 1,
      name: "图纸/模型 → 算量 → 组价 → 投标/清标/评标",
      ownerOrgUnit: "数字成本产品线",
      painPoint: "图纸、清单、定额与材料价跨环节使用",
      pageNumber: ai.pageNumber,
      excerpt,
    });
  }
  const platform = pageContaining(pages, /CDE\s*数据\s*集成环境[\s\S]{0,180}?柔性数据标准体系/);
  if (platform) {
    const excerpt = excerptAround(platform.text, /CDE\s*数据\s*集成环境[\s\S]{0,180}?柔性数据标准体系/, 100);
    output.push({
      businessLineName: "平台与生态",
      seq: 1,
      name: "数据接入/转换 → 统一标准 → 组件复用 → 产品/伙伴应用",
      ownerOrgUnit: "技术平台",
      painPoint: "多环境连接与标准转换需要统一管理",
      pageNumber: platform.pageNumber,
      excerpt,
    });
  }
  const construction = pageContaining(pages, /数字施工业务包括企业级管理软件以及项目级管理软件/);
  if (construction) {
    const excerpt = excerptAround(construction.text, /数字施工业务包括[\s\S]{0,180}?智能塔机/, 100);
    output.push({
      businessLineName: "数字施工",
      seq: 1,
      name: "项目立项 → 人机料采集 → 进度/安全/成本分析 → 项目决策",
      ownerOrgUnit: "数字施工产品线",
      painPoint: "项目级数据覆盖物料、劳务、安全和综合决策",
      pageNumber: construction.pageNumber,
      excerpt,
    });
  }
  const design = pageContaining(pages, /数维房建设计和数维基建设计/);
  if (design) {
    const excerpt = excerptAround(design.text, /数字设计业务[\s\S]{0,180}?数维基建设计/, 80);
    output.push({
      businessLineName: "数字设计",
      seq: 1,
      name: "多专业设计 → 构件协同 → 算量/成本校核 → BIM 交付",
      ownerOrgUnit: "数字设计产品线",
      painPoint: "房建与基建设计产品需要统一工程数据",
      pageNumber: design.pageNumber,
      excerpt,
    });
  }
  return output.filter(item => item.excerpt);
}

function extractSystems(pages: PagedTextPage[]): ExtractedSystem[] {
  const output: ExtractedSystem[] = [];
  const platform = pageContaining(pages, /AECOS 产业业务平台/);
  if (platform) {
    const excerpt = excerptAround(platform.text, /AECOS 产业业务平台[\s\S]{0,300}?柔性数据标准体系/, 80);
    output.push({
      category: "产业平台",
      product: "AECOS",
      vendor: "自研",
      coversProcessStep: "CDE 数据集成、GDE 数据连接、ECS 数据转换与柔性数据标准",
      pageNumber: platform.pageNumber,
      excerpt,
    });
  }
  const model = pageContaining(pages, /AecGPT\s*建筑产业大模型/);
  if (model) {
    const excerpt = excerptAround(model.text, /AecGPT\s*建筑产业大模型[\s\S]{0,360}?AI\s*评标/, 100);
    output.push({
      category: "AI 平台",
      product: "AecGPT",
      vendor: "自研",
      coversProcessStep: "设计、交易、成本等七大领域；AI 算量、组价、清标、编标、评标",
      pageNumber: model.pageNumber,
      excerpt,
    });
  }
  const construction = pageContaining(pages, /项目综合决策、物料管理、劳务管理、安全管理、智能塔机/);
  if (construction) {
    const excerpt = excerptAround(construction.text, /企业级管理软件[\s\S]{0,180}?智能塔机/, 100);
    output.push({
      category: "项目管理与安全",
      product: "项目综合决策 / 物料管理 / 劳务管理 / 安全管理 / 智能塔机",
      vendor: "自研",
      coversProcessStep: "物料、劳务、安全与项目综合决策",
      pageNumber: construction.pageNumber,
      excerpt,
    });
  }
  return output.filter(item => item.excerpt);
}

function located(page: PagedTextPage, value: string, excerpt: string): LocatedValue<string> {
  return { value: numberValue(value), pageNumber: page.pageNumber, excerpt: compactText(excerpt) };
}

function extractFinancialYears(pages: PagedTextPage[], reportYear: number): ExtractedFinancialYear[] {
  const rows = new Map<number, ExtractedFinancialYear>();
  for (const year of [reportYear, reportYear - 1, reportYear - 2]) {
    rows.set(year, { year, revenue: null, netProfit: null, rndExpense: null });
  }
  const financial = pageContaining(pages, /主要会计数据和财务指标/);
  if (financial) {
    const flat = compactText(financial.text);
    const revenue = flat.match(/营业收入（元）\s*([\d,.]+)\s+([\d,.]+)\s+[+-]?[\d.]+%\s+([\d,.]+)/);
    const profit = flat.match(/归属于上市公司股东的净利润\s*([\d,.]+)\s+([\d,.]+)\s+[+-]?[\d.]+%\s+([\d,.]+)\s*（元）?/);
    for (const [offset, year] of [reportYear, reportYear - 1, reportYear - 2].entries()) {
      if (revenue?.[offset + 1]) rows.get(year)!.revenue = located(financial, revenue[offset + 1], revenue[0]);
      if (profit?.[offset + 1]) rows.get(year)!.netProfit = located(financial, profit[offset + 1], profit[0]);
    }
  }
  const research = pageContaining(pages, /公司研发投入情况/);
  if (research) {
    const flat = compactText(research.text);
    const rnd = flat.match(/研发投入金额（元）\s*([\d,.]+)\s+([\d,.]+)/);
    if (rnd) {
      rows.get(reportYear)!.rndExpense = located(research, rnd[1], rnd[0]);
      rows.get(reportYear - 1)!.rndExpense = located(research, rnd[2], rnd[0]);
    }
  }
  return [...rows.values()];
}

function extractPositions(pages: PagedTextPage[]): ExtractedPosition[] {
  const output: ExtractedPosition[] = [];
  const pattern = /([\u4e00-\u9fff]{2,4})先生：([\s\S]{0,500}?)现任本公司([^。]+)。/g;
  for (const page of pages) {
    for (const match of page.text.matchAll(pattern)) {
      const biography = compactText(match[2]).split("。").map(part => part.trim()).filter(Boolean).at(-1) ?? "";
      output.push({
        name: match[1],
        title: compactText(match[3]),
        bio: biography.slice(0, 180),
        pageNumber: page.pageNumber,
        excerpt: compactText(match[0]),
      });
    }
  }
  return output;
}

export function extractAnnualReport(pages: PagedTextPage[], reportYear: number): AnnualReportExtraction {
  const industryPage = pageContaining(pages, /公司从事的主要业务/);
  return {
    terms: extractTerms(pages),
    businessLines: extractBusinessLines(pages),
    processSteps: extractProcessSteps(pages),
    systems: extractSystems(pages),
    financialYears: extractFinancialYears(pages, reportYear),
    positions: extractPositions(pages),
    industryPage: industryPage ? {
      value: "建筑产业数字化",
      pageNumber: industryPage.pageNumber,
      excerpt: excerptAround(industryPage.text, /广联达作为数字建筑平台服务商[\s\S]{0,240}?产业链全参与方/, 40),
    } : null,
  };
}
