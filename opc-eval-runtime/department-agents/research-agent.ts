import {
  AgentContext,
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentOutput,
} from "./base-agent";
import { ensureString, ensureStringArray, requestModelJson } from "./model-json";

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

interface WebResearchDecision {
  needWebSearch: boolean;
  query: string;
  reason: string;
}

type WebSearchProvider = "tavily" | "serper" | "none";

function readEnv(name: string): string | undefined {
  const maybeProcess = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return maybeProcess.process?.env?.[name];
}

export class EvidenceAgent extends DepartmentAgentRuntime {
  constructor(taskId: string, blackboard: BlackboardClient) {
    super("evidence", taskId, blackboard);
  }

  getDependencies(): [] {
    return [];
  }

  async execute(context: AgentContext): Promise<DepartmentOutput> {
    const patent = await this.parsePatent(context.bossInstruction);
    const decision = await this.decideWebResearch(context.bossInstruction);
    const webResearch = await this.searchAndSummarizeWeb(context.bossInstruction, decision);
    const feasibility = await this.assessFeasibility(patent);
    const report = await this.generateReport({
      patent,
      feasibility,
      taskInfo: context.taskInfo,
      webResearch,
    });

    return {
      department: "evidence",
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
        webResearchDecision: decision.reason,
      },
    };
  }

  private async decideWebResearch(instruction: string): Promise<WebResearchDecision> {
    const force = (readEnv("RESEARCH_FORCE_WEB_SEARCH") ?? "").toLowerCase();
    if (force === "true") {
      return {
        needWebSearch: true,
        query: this.extractSearchQuery(instruction),
        reason: "forced_by_env",
      };
    }

    const systemPrompt = [
      "你是 research 工具调度器。",
      "判断当前任务是否必须做网页检索（browser skill）。",
      "仅返回 JSON，结构为 {\"needWebSearch\": boolean, \"query\": string, \"reason\": string}。",
      "只有在任务明确要求最新动态、竞品信息、外部事实核验时，needWebSearch 才为 true。",
    ].join("\n");
    const userPrompt = `任务描述: ${instruction}`;

    const raw = await requestModelJson<Record<string, unknown>>(systemPrompt, userPrompt);
    const needWebSearch = raw.needWebSearch === true;
    return {
      needWebSearch,
      query: ensureString(raw.query, this.extractSearchQuery(instruction)),
      reason: ensureString(raw.reason, needWebSearch ? "model_required" : "model_not_required"),
    };
  }

  private async searchAndSummarizeWeb(
    instruction: string,
    decision: WebResearchDecision,
  ): Promise<WebResearchSummary> {
    const query = decision.query || this.extractSearchQuery(instruction);
    if (!decision.needWebSearch) {
      return {
        provider: "baidu",
        query,
        hits: [],
        summary: "本次任务未触发网页检索，已直接基于任务输入与内部上下文进行研究分析。",
        status: "fallback",
        reason: decision.reason,
      };
    }

    const apiSearchResult = await this.searchViaWebApi(query);
    if (apiSearchResult) {
      return apiSearchResult;
    }

    return {
      provider: "baidu",
      query,
      hits: [],
      summary: `联网检索已停用，本轮先基于可用上下文完成初步分析。若需联网检索，请配置 WEB_SEARCH_PROVIDER=tavily 或 serper。关键词：${query}`,
      status: "fallback",
      reason: "browser_automation_disabled",
    };
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

  private readTopK(): number {
    const raw = readEnv("BAIDU_TOP_K");
    const parsed = raw ? Number(raw) : 5;
    if (!Number.isFinite(parsed)) {
      return 5;
    }
    return Math.min(10, Math.max(1, Math.floor(parsed)));
  }

  private readWebSearchProvider(): WebSearchProvider {
    const explicit = (readEnv("WEB_SEARCH_PROVIDER") ?? "").trim().toLowerCase();
    if (explicit === "tavily" || explicit === "serper") {
      return explicit;
    }
    return "none";
  }

  private readWebSearchTimeoutMs(): number {
    const raw = Number(readEnv("WEB_SEARCH_TIMEOUT_MS") ?? "10000");
    if (!Number.isFinite(raw)) {
      return 10000;
    }
    return Math.min(30000, Math.max(3000, Math.floor(raw)));
  }

  private async searchViaWebApi(query: string): Promise<WebResearchSummary | null> {
    const provider = this.readWebSearchProvider();
    if (provider === "none") {
      return null;
    }

    const timeoutMs = this.readWebSearchTimeoutMs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let hits: WebSearchHit[] = [];
      if (provider === "tavily") {
        hits = await this.searchViaTavily(query, controller.signal);
      } else if (provider === "serper") {
        hits = await this.searchViaSerper(query, controller.signal);
      }

      if (hits.length === 0) {
        return null;
      }

      return {
        provider,
        query,
        hits,
        summary: this.buildSummaryFromHits(query, hits, { provider, source: "web_search_api" }),
        status: "completed",
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async searchViaTavily(query: string, signal: AbortSignal): Promise<WebSearchHit[]> {
    const apiKey = (readEnv("TAVILY_API_KEY") ?? "").trim();
    if (!apiKey) {
      return [];
    }

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: this.readTopK(),
      }),
      signal,
    });

    if (!response.ok) {
      return [];
    }

    const payload = await response.json() as { results?: Array<Record<string, unknown>> };
    const results = Array.isArray(payload.results) ? payload.results : [];
    return results
      .map((row) => {
        const title = this.readString(row, ["title"]) ?? "未命名结果";
        const url = this.readString(row, ["url"]) ?? "";
        const snippet = this.readString(row, ["content", "snippet"]);
        if (!url) {
          return null;
        }
        return {
          title,
          url,
          ...(snippet ? { snippet } : {}),
        };
      })
      .filter((item): item is WebSearchHit => item !== null)
      .slice(0, this.readTopK());
  }

  private async searchViaSerper(query: string, signal: AbortSignal): Promise<WebSearchHit[]> {
    const apiKey = (readEnv("SERPER_API_KEY") ?? "").trim();
    if (!apiKey) {
      return [];
    }

    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({
        q: query,
        num: this.readTopK(),
      }),
      signal,
    });

    if (!response.ok) {
      return [];
    }

    const payload = await response.json() as { organic?: Array<Record<string, unknown>> };
    const organic = Array.isArray(payload.organic) ? payload.organic : [];
    return organic
      .map((row) => {
        const title = this.readString(row, ["title"]) ?? "未命名结果";
        const url = this.readString(row, ["link", "url"]) ?? "";
        const snippet = this.readString(row, ["snippet"]);
        if (!url) {
          return null;
        }
        return {
          title,
          url,
          ...(snippet ? { snippet } : {}),
        };
      })
      .filter((item): item is WebSearchHit => item !== null)
      .slice(0, this.readTopK());
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
    const provider = this.readString(raw, ["provider"]) ?? "web";
    const providerLabel = provider === "tavily" || provider === "serper"
      ? `${provider} 网页检索`
      : "网页检索";

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

    return `关键词“${query}”${providerLabel}命中 ${hits.length} 条，核心结论：${lines.join(" ")}`;
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
      resourceRequirements: ["2名工程师", "1名产品经理", "托管API方案"],
      timelineEstimate: `${techInfo.keyTechnologies.length + 3}周`,
    };
  }

  private async generateReport(data: {
    patent: PatentAnalysis;
    feasibility: FeasibilityResult;
    taskInfo: AgentContext["taskInfo"];
    webResearch: WebResearchSummary;
  }): Promise<ResearchReport> {
    const systemPrompt = [
      "你是 research 部门分析师。",
      "请根据输入信息生成 research.report 的 JSON。",
      "仅返回 JSON 对象，禁止输出额外说明。",
      "若外部检索不可用，不要暴露工具错误细节（如检索失败/超时/接口错误），统一表述为\"外部实时数据待补充\"并继续分析。",
      "优先给出业务与投资可执行建议；除非用户明确要求系统架构设计，否则不要主动推荐 GPU 集群、小模型路由、自建推理环境。",
      "结构:",
      "{",
      "  \"executiveSummary\": string,",
      "  \"detailedAnalysis\": string,",
      "  \"recommendations\": string[],",
      "  \"nextSteps\": string[]",
      "}",
    ].join("\n");

    const userPrompt = [
      `webResearch.summary: ${data.webResearch.summary}`,
      `feasibility.score: ${data.feasibility.score}`,
      `feasibility.timelineEstimate: ${data.feasibility.timelineEstimate}`,
      `taskInfo.complexity: ${data.taskInfo.complexity}`,
      `patent(JSON): ${JSON.stringify(data.patent).slice(0, 2500)}`,
      `webResearch(JSON): ${JSON.stringify(data.webResearch).slice(0, 2500)}`,
    ].join("\n");

    const raw = await requestModelJson<Record<string, unknown>>(systemPrompt, userPrompt);
    return {
      executiveSummary: ensureString(raw.executiveSummary, `${data.webResearch.summary}。`),
      detailedAnalysis: ensureString(raw.detailedAnalysis, `复杂度=${data.taskInfo.complexity}，可行性评分=${data.feasibility.score}`),
      recommendations: ensureStringArray(raw.recommendations, ["待模型补全"]),
      nextSteps: ensureStringArray(raw.nextSteps, ["待模型补全"]),
    };
  }
}
