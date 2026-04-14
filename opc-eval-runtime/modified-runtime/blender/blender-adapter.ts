import type {
  BlenderAdapter,
  DepartmentOutputs,
  FusedResult,
  FusionConfig,
  FusionMethod,
  FusionStrategy,
  PairwiseComparison,
  RankedCandidate,
} from "./types";
import { applyFusionStrategy } from "./fusion-strategies";
import { getFusionPromptWithRanking } from "./prompts";

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    total_tokens?: number;
  };
  reasoning?: string;
}

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<OpenAIChatResponse>;
}>;

type DepartmentName = keyof DepartmentOutputs;

const RANKER_MODEL = "pairranker-heuristic-v1";
const FUSER_MODEL = "genfuser-heuristic-v1";
const DEFAULT_TOP_K = 5;

// ── 千帆 App Runs API 辅助函数 ─────────────────────────────────────

function readEnv(name: string): string | undefined {
  const maybeProcess = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return maybeProcess.process?.env?.[name];
}

async function qianfanSign(bodyStr: string, secretKey: string, requestId: string, signTime: string): Promise<string> {
  const data = new TextEncoder().encode(`${bodyStr}${secretKey}${requestId}${signTime}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function qianfanHeaders(bodyStr: string): Promise<Record<string, string>> {
  const authMode = (readEnv("QIANFAN_AUTH_MODE") ?? "signature").toLowerCase();
  const bearerToken = readEnv("QIANFAN_BEARER_TOKEN") ?? "";
  if (authMode === "bearer" && bearerToken) {
    return { "Content-Type": "application/json", Authorization: `Bearer ${bearerToken}` };
  }
  const accessKey = readEnv("QIANFAN_ACCESS_KEY") ?? "";
  const secretKey = readEnv("QIANFAN_SECRET_KEY") ?? "";
  const requestId = crypto.randomUUID().replace(/-/g, "");
  const signTime = new Date().toISOString().replace("T", " ").slice(0, 19);
  const token = await qianfanSign(bodyStr, secretKey, requestId, signTime);
  return {
    "Content-Type": "application/json",
    "X-Bce-Request-ID": requestId,
    "Access-Key": accessKey,
    "Sign-Time": signTime,
    Token: token,
  };
}

/**
 * 调用千帆 App Runs API 做融合推理。
 * 使用 evidence-agent 作为通用 LLM 通道。
 */
async function callQianfanFusion(prompt: string, config: FusionConfig): Promise<string> {
  const host = (readEnv("QIANFAN_HOST") ?? "").replace(/\/$/, "");
  if (!host) throw new Error("QIANFAN_HOST 未配置");
  // 使用 evidence-agent 做融合（它擅长信息综合）
  const appId = "dae4fbab-4e20-47ca-9d8b-10afe052f999";

  // 新建会话
  const convBody = JSON.stringify({ app_id: appId });
  const convResp = await fetch(`${host}/api/ai_apaas/v1/app/conversation`, {
    method: "POST", headers: await qianfanHeaders(convBody), body: convBody,
  });
  if (!convResp.ok) {
    const raw = await convResp.text();
    throw new Error(`千帆新建会话失败: ${convResp.status} ${raw.slice(0, 200)}`);
  }
  const { conversation_id } = await convResp.json() as { conversation_id?: string };
  if (!conversation_id) throw new Error("千帆未返回 conversation_id");

  // 发送对话
  const query = `[系统指令]\nYou synthesize multiple departmental outputs into one coherent, execution-oriented result. Respond in the same language as the input.\n\n[用户请求]\n${prompt}`;
  const runBody = JSON.stringify({ app_id: appId, query, stream: false, conversation_id: conversation_id });
  const runResp = await fetch(`${host}/api/ai_apaas/v1/app/conversation/runs`, {
    method: "POST", headers: await qianfanHeaders(runBody), body: runBody,
  });
  if (!runResp.ok) {
    const raw = await runResp.text();
    throw new Error(`千帆对话失败: ${runResp.status} ${raw.slice(0, 200)}`);
  }
  const runData = await runResp.json() as { answer?: string; content?: Array<{ outputs?: { text?: string } }> };
  let answer = runData.answer ?? "";
  if (!answer && Array.isArray(runData.content)) {
    answer = runData.content
      .map((item) => {
        const t = (item as Record<string, unknown>).outputs;
        return t && typeof t === "object" ? String((t as Record<string, unknown>).text ?? "") : "";
      })
      .join("\n");
  }
  return answer.trim();
}

// ── 主 Adapter ──────────────────────────────────────────────────────

export class LLMBlenderAdapter implements BlenderAdapter {
  private apiKey = "";
  private model = "gpt-4";
  private baseUrl = "https://api.openai.com/v1";
  private readonly fetchImpl: FetchLike | undefined;

  constructor(config?: { apiKey?: string; model?: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (config?.apiKey) {
      this.apiKey = config.apiKey;
    }
    if (config?.model) {
      this.model = config.model;
    }
    if (config?.baseUrl) {
      this.baseUrl = config.baseUrl;
    }
    this.fetchImpl = config?.fetchImpl;
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  setModel(model: string): void {
    this.model = model;
  }

  async fuse(outputs: DepartmentOutputs, config: FusionConfig = { strategy: "consensus" }): Promise<FusedResult> {
    const startedAt = Date.now();
    const strategyFrame = applyFusionStrategy(outputs, config.strategy);
    const rankedCandidates = this.rankCandidates(outputs, strategyFrame, config.topK ?? DEFAULT_TOP_K);
    const pairwiseComparisons = this.buildPairwiseComparisons(rankedCandidates);
    const prompt = getFusionPromptWithRanking(outputs, config.strategy, rankedCandidates.slice(0, config.topK ?? DEFAULT_TOP_K));
    const sourceDepartments = rankedCandidates.map((candidate) => candidate.department);
    const localFallback = this.buildLocalFusion(rankedCandidates, config.strategy, strategyFrame.instruction);

    if (!this.apiKey || !this.resolveFetch()) {
      // 尝试千帆回退
      const qianfanHost = readEnv("QIANFAN_HOST") ?? "";
      if (qianfanHost) {
        console.log("[LLMBlenderAdapter] 无 OpenAI API Key，尝试千帆后端融合...");
        try {
          const fusedContent = await callQianfanFusion(prompt, config);
          return this.buildResult({
            resultType: "llm-based-fusion",
            fusedContent: fusedContent || localFallback,
            fusionMethod: "llm-genfuser-qianfan",
            sourceDepartments,
            rankedCandidates,
            pairwiseComparisons,
            startedAt,
            tokenUsage: 0,
            reasoning: config.includeReasoning ? strategyFrame.instruction : null,
            rankingStrategy: config.strategy,
            modelUsed: "qianfan-app",
          });
        } catch (qfErr) {
          console.warn(`[LLMBlenderAdapter] 千帆融合也失败了，降级为本地回退: ${(qfErr as Error).message}`);
        }
      }
      return this.buildResult({
        resultType: "local-fallback-fusion",
        fusedContent: localFallback,
        fusionMethod: "priority-based",
        sourceDepartments,
        rankedCandidates,
        pairwiseComparisons,
        startedAt,
        tokenUsage: 0,
        reasoning: config.includeReasoning ? strategyFrame.instruction : null,
        rankingStrategy: config.strategy,
        modelUsed: "local-fallback",
      });
    }

    const response = await this.callLLM(prompt, config);
    const fusedContent = this.parseResponse(response) || localFallback;

    return this.buildResult({
      resultType: "llm-based-fusion",
      fusedContent,
      fusionMethod: "llm-genfuser",
      sourceDepartments,
      rankedCandidates,
      pairwiseComparisons,
      startedAt,
      tokenUsage: response.usage?.total_tokens ?? 0,
      reasoning: config.includeReasoning ? response.reasoning ?? null : null,
      rankingStrategy: config.strategy,
      modelUsed: this.model,
    });
  }

  private resolveFetch(): FetchLike | undefined {
    if (this.fetchImpl) {
      return this.fetchImpl;
    }
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    return typeof globalFetch === "function" ? globalFetch : undefined;
  }

  private async callLLM(prompt: string, config: FusionConfig): Promise<OpenAIChatResponse> {
    const fetchFn = this.resolveFetch();
    if (!fetchFn) {
      throw new Error("Fetch is not available in the current environment.");
    }

    const response = await fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: "system",
            content: "You synthesize multiple departmental outputs into one coherent, execution-oriented result.",
          },
          { role: "user", content: prompt },
        ],
        temperature: config.temperature ?? 0.7,
        max_tokens: config.maxTokens ?? 2000,
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  private parseResponse(response: OpenAIChatResponse): string {
    return response.choices?.[0]?.message?.content?.trim() ?? "";
  }

  private rankCandidates(
    outputs: DepartmentOutputs,
    strategyFrame: ReturnType<typeof applyFusionStrategy>,
    topK: number,
  ): RankedCandidate[] {
    const entries = Object.entries(outputs)
      .filter(([, content]) => typeof content === "string" && content.trim().length > 0)
      .map(([department, content]) => ({
        department: department as DepartmentName,
        content: content.trim(),
        baseQuality: this.scoreCandidate(content.trim(), department as DepartmentName, strategyFrame),
      }));

    if (entries.length === 0) {
      return [];
    }

    const wins = new Map<DepartmentName, number>(entries.map((entry) => [entry.department, 0]));

    for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
        const left = entries[leftIndex]!;
        const right = entries[rightIndex]!;
        const leftAdjusted = this.adjustScore(left.baseQuality, left.department, strategyFrame);
        const rightAdjusted = this.adjustScore(right.baseQuality, right.department, strategyFrame);

        if (leftAdjusted >= rightAdjusted) {
          wins.set(left.department, (wins.get(left.department) ?? 0) + 1);
        } else {
          wins.set(right.department, (wins.get(right.department) ?? 0) + 1);
        }
      }
    }

    const ranked = entries
      .map((entry) => {
        const pairScore = entries.length > 1 ? (wins.get(entry.department) ?? 0) / (entries.length - 1) : 1;
        const totalScore = (entry.baseQuality * 0.55) + (pairScore * 0.45);
        return {
          department: entry.department,
          wins: wins.get(entry.department) ?? 0,
          baseQuality: this.clampScore(entry.baseQuality),
          pairScore: this.clampScore(pairScore),
          totalScore: this.clampScore(totalScore),
          contentLength: entry.content.length,
          content: entry.content,
          rank: 0,
        } satisfies RankedCandidate;
      })
      .sort((left, right) => right.totalScore - left.totalScore)
      .slice(0, Math.max(1, topK));

    return ranked.map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
    }));
  }

  private buildPairwiseComparisons(rankedCandidates: RankedCandidate[]): PairwiseComparison[] {
    const comparisons: PairwiseComparison[] = [];

    for (let leftIndex = 0; leftIndex < rankedCandidates.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < rankedCandidates.length; rightIndex += 1) {
        const left = rankedCandidates[leftIndex]!;
        const right = rankedCandidates[rightIndex]!;
        const winner = left.totalScore >= right.totalScore ? left.department : right.department;

        comparisons.push({
          leftDepartment: left.department,
          rightDepartment: right.department,
          winnerDepartment: winner,
          leftScore: left.totalScore,
          rightScore: right.totalScore,
        });
      }
    }

    return comparisons;
  }

  private scoreCandidate(content: string, department: DepartmentName, strategyFrame: ReturnType<typeof applyFusionStrategy>): number {
    let score = 0.22;

    if (content.length > 60) {
      score += 0.1;
    }
    if (content.length > 160) {
      score += 0.08;
    }
    if (content.length > 320) {
      score += 0.05;
    }
    if (/^#{1,3}\s/m.test(content) || /\n[-*]\s/.test(content) || /\n\d+\./.test(content)) {
      score += 0.12;
    }
    if (/recommend|recommendation|建议|方案|行动|action|risk|风险|feasibility|可行/.test(content.toLowerCase())) {
      score += 0.12;
    }
    if (/\b(data|evidence|evidence|metrics|指标|cost|costs|预算|deadline|timeline)\b/i.test(content)) {
      score += 0.08;
    }
    if (content.split(/\n+/).filter((line) => line.trim().length > 0).length >= 4) {
      score += 0.06;
    }

    return this.adjustScore(score, department, strategyFrame);
  }

  private adjustScore(score: number, department: DepartmentName, strategyFrame: ReturnType<typeof applyFusionStrategy>): number {
    const emphasis = strategyFrame.emphasis[department] ?? 1;
    return this.clampScore(score * emphasis);
  }

  private buildLocalFusion(rankedCandidates: RankedCandidate[], strategy: FusionStrategy, instruction: string): string {
    if (rankedCandidates.length === 0) {
      return [
        "融合结果（本地回退）",
        `策略：${strategy}`,
        `提示：${instruction}`,
        "",
        "(no department output)",
      ].join("\n");
    }

    const topCandidate = rankedCandidates[0]!;
    const sections = rankedCandidates.map((candidate) => {
      const content = this.truncateText(candidate.content, 1000);
      return [
        `## ${candidate.rank}. ${candidate.department}`,
        `- total: ${candidate.totalScore.toFixed(4)}`,
        `- base: ${candidate.baseQuality.toFixed(4)}`,
        `- pair: ${candidate.pairScore.toFixed(4)}`,
        `- wins: ${candidate.wins}`,
        content,
      ].join("\n");
    });

    return [
      "融合结果（本地回退）",
      "架构：pairranker+genfuser",
      `策略：${strategy}`,
      `提示：${instruction}`,
      `顶部候选：${topCandidate.department} (${topCandidate.totalScore.toFixed(4)})`,
      "",
      ...sections,
    ].join("\n\n");
  }

  private buildResult(params: {
    resultType: FusedResult["type"];
    fusedContent: string;
    fusionMethod: FusionMethod;
    sourceDepartments: string[];
    rankedCandidates: RankedCandidate[];
    pairwiseComparisons: PairwiseComparison[];
    startedAt: number;
    tokenUsage: number;
    reasoning: string | null;
    rankingStrategy: FusionStrategy;
    modelUsed: string;
  }): FusedResult {
    const confidence = this.calculateConfidence(params.rankedCandidates, params.fusedContent);
    const fusionMetadata: NonNullable<FusedResult["fusionMetadata"]> = {
      tokenUsage: params.tokenUsage,
      latencyMs: Date.now() - params.startedAt,
      modelUsed: params.modelUsed,
      rankerModel: RANKER_MODEL,
      fuserModel: FUSER_MODEL,
      rankingSummary: this.buildRankingSummary(params.rankedCandidates),
    };

    if (params.reasoning) {
      fusionMetadata.reasoning = params.reasoning;
    }

    return {
      type: params.resultType,
      architecture: params.resultType === "llm-based-fusion" ? "pairranker+genfuser" : "local-priority-fallback",
      fusedContent: params.fusedContent,
      fusionMethod: params.fusionMethod,
      confidence,
      sourceDepartments: params.sourceDepartments,
      rankingStrategy: params.rankingStrategy,
      rankedCandidates: params.rankedCandidates,
      pairwiseComparisons: params.pairwiseComparisons,
      fusionTimestamp: new Date().toISOString(),
      fusionMetadata,
    };
  }

  private calculateConfidence(rankedCandidates: RankedCandidate[], fusedContent: string): number {
    if (rankedCandidates.length === 0) {
      return 0.42;
    }

    const topScore = rankedCandidates[0]?.totalScore ?? 0;
    const secondScore = rankedCandidates[1]?.totalScore ?? 0;
    const spread = Math.max(0, topScore - secondScore);
    const sourceBoost = Math.min(0.18, rankedCandidates.length * 0.04);
    const contentBoost = fusedContent.trim().length > 120 ? 0.07 : 0.02;

    return this.clampScore(0.45 + (topScore * 0.35) + (spread * 0.1) + sourceBoost + contentBoost);
  }

  private buildRankingSummary(rankedCandidates: RankedCandidate[]): string {
    if (rankedCandidates.length === 0) {
      return "no candidates";
    }

    return rankedCandidates
      .map((candidate) => `${candidate.rank}:${candidate.department}:${candidate.totalScore.toFixed(4)}`)
      .join(" | ");
  }

  private truncateText(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
  }

  private clampScore(score: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));
  }
}
