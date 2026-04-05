import {
  AgentContext,
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentOutput,
} from "./base-agent";
import { SkillInvoker } from "../modified-runtime/tools/skill-invoker";

interface PatentAnalysis {
  technicalSummary: string;
  keyTechnologies: string[];
  innovationPoints: string[];
  potentialRisks: string[];
}

interface FeasibilityResult {
  score: number;
  technicalFeasibility: number;
  resourceRequirements: string[];
  timelineEstimate: string;
}

interface ResearchReport {
  executiveSummary: string;
  detailedAnalysis: string;
  recommendations: string[];
  nextSteps: string[];
}

interface WebSearchHit {
  title: string;
  url: string;
  snippet?: string;
}

interface WebResearchSummary {
  provider: string;
  query: string;
  hits: WebSearchHit[];
  summary: string;
  status: "completed" | "fallback";
  reason?: string;
}

function readEnv(name: string): string | undefined {
  const maybeProcess = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return maybeProcess.process?.env?.[name];
}

export class ResearchAgent extends DepartmentAgentRuntime {
  constructor(taskId: string, blackboard: BlackboardClient) {
    super("research", taskId, blackboard);
  }

  getDependencies(): [] {
    return [];
  }

  async execute(context: AgentContext): Promise<DepartmentOutput> {
    const patent = await this.parsePatent(context.bossInstruction);
    const webResearch = await this.searchAndSummarizeWeb(context.bossInstruction);
    const feasibility = await this.assessFeasibility(patent);
    const report = await this.generateReport({
      patent,
      feasibility,
      taskInfo: context.taskInfo,
      webResearch,
    });

    return {
      department: "research",
      taskId: context.taskId,
      status: "completed",
      score: feasibility.score,
      output: {
        patent,
        webResearch,
        feasibility,
        report,
      },
      timestamp: new Date(),
      metadata: {
        dependencyCount: 0,
        webResearchStatus: webResearch.status,
        webResearchProvider: webResearch.provider,
      },
    };
  }

  private async searchAndSummarizeWeb(instruction: string): Promise<WebResearchSummary> {
    const query = this.extractSearchQuery(instruction);
    const serviceUrl = readEnv("OPENCLAW_SKILL_SERVICE_URL") ?? readEnv("OPENCLOW_SKILL_SERVICE_URL") ?? "";
    if (serviceUrl.trim().length === 0) {
      return {
        provider: "baidu",
        query,
        hits: [],
        summary: `未配置技能服务，返回本地摘要占位。建议配置 OPENCLAW_SKILL_SERVICE_URL 后重试，关键词：${query}`,
        status: "fallback",
        reason: "missing_skill_service_url",
      };
    }

    const invoker = new SkillInvoker(
      serviceUrl,
      readEnv("OPENCLAW_SKILL_SERVICE_API_KEY") ?? readEnv("OPENCLOW_SKILL_SERVICE_API_KEY"),
    );

    try {
      const browserOutput = await invoker.invoke("browser-automation", {
        start_url: (readEnv("BAIDU_WEB_URL") ?? "https://www.baidu.com").trim(),
        actions: this.buildBaiduActions(query),
        options: {
          provider: "baidu",
          query,
          top_k: this.readTopK(),
        },
      });

      const hits = this.extractHits(browserOutput).slice(0, this.readTopK());
      const summary = this.buildSummaryFromHits(query, hits, browserOutput);

      return {
        provider: "baidu",
        query,
        hits,
        summary,
        status: "completed",
      };
    } catch (error) {
      return {
        provider: "baidu",
        query,
        hits: [],
        summary: `百度检索执行失败，已降级为本地摘要占位。关键词：${query}`,
        status: "fallback",
        reason: String(error),
      };
    }
  }

  private extractSearchQuery(instruction: string): string {
    const fromEnv = readEnv("BAIDU_SEARCH_KEYWORD");
    if (fromEnv && fromEnv.trim().length > 0) {
      return fromEnv.trim();
    }

    const regexCandidates = [
      /(?:关键词|关键字|search\s*keyword)\s*[:：]\s*([^\n。；;]+)/i,
      /百度(?:搜索)?\s*[:：]\s*([^\n。；;]+)/i,
    ];

    for (const regex of regexCandidates) {
      const match = instruction.match(regex);
      if (match?.[1]) {
        return match[1].trim();
      }
    }

    const compact = instruction.replace(/\s+/g, " ").trim();
    return compact.slice(0, 32) || "AI创业项目";
  }

  private buildBaiduActions(query: string): string[] {
    const configured = this.parseActionsJson(readEnv("BAIDU_BROWSER_ACTIONS_JSON"));
    if (configured) {
      return configured.map((item) => item.replaceAll("{{QUERY}}", query));
    }

    return [
      "wait:dom-ready",
      `type:selector=input[name='wd'], value=${query}`,
      "click:selector=input[type='submit']",
      "wait:dom-ready",
      "extract:list=.result h3 a",
    ];
  }

  private parseActionsJson(raw: string | undefined): string[] | null {
    if (!raw || raw.trim().length === 0) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return null;
      }
      const actions = parsed.filter((item): item is string => typeof item === "string");
      return actions.length > 0 ? actions : null;
    } catch {
      return null;
    }
  }

  private readTopK(): number {
    const raw = readEnv("BAIDU_TOP_K");
    const parsed = raw ? Number(raw) : 5;
    if (!Number.isFinite(parsed)) {
      return 5;
    }
    return Math.min(10, Math.max(1, Math.floor(parsed)));
  }

  private extractHits(browserOutput: Record<string, unknown>): WebSearchHit[] {
    const candidateKeys = ["hits", "results", "items", "pages", "links"];

    for (const key of candidateKeys) {
      const value = browserOutput[key];
      if (!Array.isArray(value)) {
        continue;
      }

      const normalized = value
        .map((item): WebSearchHit | null => {
          if (!item || typeof item !== "object") {
            return null;
          }

          const row = item as Record<string, unknown>;
          const title = this.readString(row, ["title", "name", "text"]) ?? "未命名结果";
          const url = this.readString(row, ["url", "link", "href"]) ?? "";
          const snippet = this.readString(row, ["snippet", "summary", "desc", "description"]);

          if (!url) {
            return null;
          }

          return {
            title,
            url,
            ...(snippet ? { snippet } : {}),
          };
        })
        .filter((item): item is WebSearchHit => item !== null);

      if (normalized.length > 0) {
        return normalized;
      }
    }

    return [];
  }

  private buildSummaryFromHits(query: string, hits: WebSearchHit[], raw: Record<string, unknown>): string {
    if (hits.length === 0) {
      const fallback = this.readString(raw, ["summary", "result_summary", "message"]);
      if (fallback) {
        return `关键词“${query}”检索结果摘要：${fallback}`;
      }
      return `关键词“${query}”已发起检索，但未获取结构化命中列表，请检查 browser-automation 返回字段。`;
    }

    const lines = hits.slice(0, 3).map((hit, index) => {
      const detail = hit.snippet ? `：${hit.snippet}` : "";
      return `${index + 1}. ${hit.title}${detail}`;
    });

    return `关键词“${query}”百度检索命中 ${hits.length} 条，核心结论：${lines.join(" ")}`;
  }

  private readString(container: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = container[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
    return null;
  }

  private async parsePatent(document: string): Promise<PatentAnalysis> {
    const seed = document.slice(0, 48);
    return {
      technicalSummary: `基于老板指令抽取的技术摘要: ${seed}`,
      keyTechnologies: ["核心算法", "数据管道", "部署体系"],
      innovationPoints: ["低成本自动化", "小模型路由", "多部门协同"],
      potentialRisks: ["数据质量波动", "算力瓶颈"],
    };
  }

  private async assessFeasibility(techInfo: PatentAnalysis): Promise<FeasibilityResult> {
    return {
      score: 82,
      technicalFeasibility: 84,
      resourceRequirements: ["2名工程师", "1名产品经理", "GPU推理环境"],
      timelineEstimate: `${techInfo.keyTechnologies.length + 3}周`,
    };
  }

  private async generateReport(data: {
    patent: PatentAnalysis;
    feasibility: FeasibilityResult;
    taskInfo: AgentContext["taskInfo"];
    webResearch: WebResearchSummary;
  }): Promise<ResearchReport> {
    return {
      executiveSummary: `${data.webResearch.summary}。技术方案具备落地条件，建议进入原型开发阶段。`,
      detailedAnalysis: `复杂度=${data.taskInfo.complexity}，可行性评分=${data.feasibility.score}，检索状态=${data.webResearch.status}`,
      recommendations: ["优先实现核心能力", "并行建设评估指标", "将检索关键词固化为任务参数"],
      nextSteps: ["输出PoC计划", "定义验收标准", "验证百度检索动作在真实页面稳定性"],
    };
  }
}
