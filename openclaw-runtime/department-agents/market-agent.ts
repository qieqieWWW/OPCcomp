import {
  AgentContext,
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentOutput,
} from "./base-agent";
import { SkillInvoker } from "../modified-runtime/tools/skill-invoker";
import { ensureNumber, ensureString, ensureStringArray, requestModelJson } from "./model-json";

interface MarketingPlan {
  campaignTheme: string;
  channels: string[];
  budgetSplit: Record<string, number>;
}

interface ContentStrategy {
  pillarTopics: string[];
  weeklyCadence: string;
}

interface BrandStrategy {
  brandPosition: string;
  voiceTone: string[];
  targetAudience: string[];
}

interface VideoPromptPlan {
  prompt: string;
  durationSec: number;
  resolution: string;
}

interface BrowserVideoProviderConfig {
  providerId: string;
  startUrl: string;
  actions: string[];
}

interface CreativeDecision {
  needCreativeAsset: boolean;
  reason: string;
}

function readEnv(name: string): string | undefined {
  const maybeProcess = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return maybeProcess.process?.env?.[name];
}

export class MarketAgent extends DepartmentAgentRuntime {
  constructor(taskId: string, blackboard: BlackboardClient) {
    super("market", taskId, blackboard);
  }

  getDependencies(): ["strategy"] {
    return ["strategy"];
  }

  async execute(context: AgentContext): Promise<DepartmentOutput> {
    const existingOutput = await this.blackboard.getDepartmentOutput(context.taskId, "market");
    if (existingOutput?.status === "completed" && this.hasVideoReceipt(existingOutput)) {
      return {
        ...existingOutput,
        timestamp: new Date(),
        metadata: {
          ...(existingOutput.metadata ?? {}),
          idempotentReuse: true,
        },
      };
    }

    const strategyData = context.dependencies.strategy?.output ?? {};
    const legalOutput = await this.blackboard.getDepartmentOutput(context.taskId, "legal");
    const legalData = legalOutput?.output ?? {};
    const generated = await this.generateMarketByModel(context.bossInstruction, strategyData, legalData);
    const plan = generated.plan;
    const content = generated.content;
    const brand = generated.brand;
    const creativeDecision = await this.decideCreativeExecution(context.bossInstruction, plan, content, brand);
    const defaultProvider = (readEnv("VIDEO_BROWSER_PROVIDER") ?? "jimeng").trim().toLowerCase();
    let idempotencyKey = `${defaultProvider}:${context.taskId}:market`;
    let receipt: {
      provider: string;
      requestId: string;
      status: string;
      videoUrl?: string;
      fileId?: string;
      raw: Record<string, unknown>;
    };
    let requestPayload: {
      provider: string;
      start_url: string;
      prompt: string;
      duration_sec: number;
      resolution: string;
    };

    if (creativeDecision.needCreativeAsset) {
      const promptPlan = this.buildVideoPromptPlan(context, plan, content, brand);
      const providerConfig = this.resolveBrowserVideoProviderConfig(promptPlan);
      idempotencyKey = `${providerConfig.providerId}:${context.taskId}:market`;
      receipt = await this.generateByBrowserSkill(providerConfig, promptPlan, idempotencyKey);
      requestPayload = {
        provider: providerConfig.providerId,
        start_url: providerConfig.startUrl,
        prompt: promptPlan.prompt,
        duration_sec: promptPlan.durationSec,
        resolution: promptPlan.resolution,
      };
    } else {
      receipt = {
        provider: defaultProvider,
        requestId: `skipped:${context.taskId}:market`,
        status: "skipped",
        raw: {
          reason: creativeDecision.reason,
          message: "本次任务未触发创意素材生成，跳过 browser skill 调用。",
        },
      };
      requestPayload = {
        provider: defaultProvider,
        start_url: "",
        prompt: "",
        duration_sec: 0,
        resolution: "",
      };
    }

    if (!receipt.videoUrl && !receipt.fileId) {
      // 降级：警告但不 throw，允许 market 以 "submitted" 状态完成，避免阻断后续 sales agent
      console.warn(
        `[market-agent] 视频服务未返回可用视频回执，服务商: ${requestPayload.provider}，状态: ${receipt.status}。` +
        " 已降级为 submitted 状态继续执行。",
      );
    }

    return {
      department: "market",
      taskId: context.taskId,
      status: "completed",
      score: 85,
      output: {
        plan,
        content,
        brand,
        video_generation: {
          request: requestPayload,
          receipt,
        },
      },
      timestamp: new Date(),
      metadata: {
        dependencies: this.getDependencies(),
        idempotencyKey,
        executionMode: "browser_video_skill",
        provider: requestPayload.provider,
        generationMode: "model-driven",
        creativeDecision: creativeDecision.reason,
      },
    };
  }

  private async decideCreativeExecution(
    bossInstruction: string,
    plan: MarketingPlan,
    content: ContentStrategy,
    brand: BrandStrategy,
  ): Promise<CreativeDecision> {
    const force = (readEnv("MARKET_FORCE_CREATIVE") ?? "").toLowerCase();
    if (force === "true") {
      return { needCreativeAsset: true, reason: "forced_by_env" };
    }

    const systemPrompt = [
      "你是 market 工具调度器。",
      "判断当前任务是否需要调用 browser skill 生成图片/视频素材。",
      "仅返回 JSON：{\"needCreativeAsset\": boolean, \"reason\": string}。",
      "只有在任务明确要求海报/图片/视频/素材生成或发布前素材制作时，needCreativeAsset 才为 true。",
    ].join("\n");
    const userPrompt = [
      `任务描述: ${bossInstruction}`,
      `campaignTheme: ${plan.campaignTheme}`,
      `content topics: ${content.pillarTopics.join("；")}`,
      `brandPosition: ${brand.brandPosition}`,
    ].join("\n");

    const raw = await requestModelJson<Record<string, unknown>>(systemPrompt, userPrompt);
    return {
      needCreativeAsset: raw.needCreativeAsset === true,
      reason: ensureString(raw.reason, raw.needCreativeAsset === true ? "model_required" : "model_not_required"),
    };
  }

  private async generateMarketByModel(
    bossInstruction: string,
    strategyData: Record<string, unknown>,
    legalData: Record<string, unknown>,
  ): Promise<{ plan: MarketingPlan; content: ContentStrategy; brand: BrandStrategy }> {
    const systemPrompt = [
      "你是市场增长顾问。",
      "请根据任务、strategy 输出、legal 输出生成 market 部门 JSON。",
      "只返回 JSON，不要解释。",
      "结构:",
      "{",
      "  \"plan\": { \"campaignTheme\": string, \"channels\": string[], \"budgetSplit\": Record<string, number> },",
      "  \"content\": { \"pillarTopics\": string[], \"weeklyCadence\": string },",
      "  \"brand\": { \"brandPosition\": string, \"voiceTone\": string[], \"targetAudience\": string[] }",
      "}",
      "budgetSplit 的 value 为 0-1 的小数，总和尽量接近 1。",
    ].join("\n");

    const userPrompt = [
      `老板任务: ${bossInstruction}`,
      `strategy 输出(JSON): ${JSON.stringify(strategyData).slice(0, 4500)}`,
      `legal 输出(JSON): ${JSON.stringify(legalData).slice(0, 4500)}`,
    ].join("\n\n");

    const raw = await requestModelJson<Record<string, unknown>>(systemPrompt, userPrompt);
    const planRaw = (raw.plan && typeof raw.plan === "object") ? raw.plan as Record<string, unknown> : {};
    const contentRaw = (raw.content && typeof raw.content === "object") ? raw.content as Record<string, unknown> : {};
    const brandRaw = (raw.brand && typeof raw.brand === "object") ? raw.brand as Record<string, unknown> : {};
    const budgetRaw = (planRaw.budgetSplit && typeof planRaw.budgetSplit === "object")
      ? planRaw.budgetSplit as Record<string, unknown>
      : {};

    const budgetSplit: Record<string, number> = {};
    for (const [key, value] of Object.entries(budgetRaw)) {
      budgetSplit[key] = ensureNumber(value, 0);
    }
    if (Object.keys(budgetSplit).length === 0) {
      budgetSplit.strategy = 0.6;
      budgetSplit.legal = 0.4;
    }

    return {
      plan: {
        campaignTheme: ensureString(planRaw.campaignTheme, "待模型补全"),
        channels: ensureStringArray(planRaw.channels, ["待模型补全"]),
        budgetSplit,
      },
      content: {
        pillarTopics: ensureStringArray(contentRaw.pillarTopics, ["待模型补全"]),
        weeklyCadence: ensureString(contentRaw.weeklyCadence, "待模型补全"),
      },
      brand: {
        brandPosition: ensureString(brandRaw.brandPosition, "待模型补全"),
        voiceTone: ensureStringArray(brandRaw.voiceTone, ["待模型补全"]),
        targetAudience: ensureStringArray(brandRaw.targetAudience, ["待模型补全"]),
      },
    };
  }

  private hasVideoReceipt(output: DepartmentOutput): boolean {
    const videoGeneration = output.output.video_generation;
    if (!videoGeneration || typeof videoGeneration !== "object") {
      return false;
    }

    const receipt = (videoGeneration as Record<string, unknown>).receipt;
    if (!receipt || typeof receipt !== "object") {
      return false;
    }

    const typedReceipt = receipt as Record<string, unknown>;
    return typeof typedReceipt.requestId === "string";
  }

  private buildVideoPromptPlan(
    context: AgentContext,
    plan: MarketingPlan,
    content: ContentStrategy,
    brand: BrandStrategy,
  ): VideoPromptPlan {
    const instruction = context.bossInstruction;
    const durationSec = this.extractDuration(instruction);
    const resolution = this.extractResolution(instruction);
    const style = this.extractStyle(instruction, brand);
    const prompt = [
      `生成一条用于市场传播的中文短视频。主题：${plan.campaignTheme}。`,
      `风格：${style}。语气：${brand.voiceTone.join("、")}。`,
      `目标受众：${brand.targetAudience.slice(0, 3).join("、")}。`,
      `核心信息：${content.pillarTopics.join("；")}。`,
      `时长约${durationSec}秒，分辨率${resolution}，画面包含科技感办公场景与产品演示镜头。`,
      `补充要求：${instruction}`,
    ].join(" ");

    return {
      prompt,
      durationSec,
      resolution,
    };
  }

  private resolveBrowserVideoProviderConfig(promptPlan: VideoPromptPlan): BrowserVideoProviderConfig {
    const providerId = (readEnv("VIDEO_BROWSER_PROVIDER") ?? "jimeng").trim().toLowerCase();
    const startUrl = (readEnv("VIDEO_BROWSER_START_URL") ?? this.defaultProviderUrl(providerId)).trim();
    if (startUrl.length === 0) {
      throw new Error("缺少视频网页服务地址，请设置 VIDEO_BROWSER_START_URL");
    }

    const configuredActions = this.parseActionsJson(readEnv("VIDEO_BROWSER_ACTIONS_JSON"));
    const actionsTemplate = configuredActions ?? this.defaultProviderActions(providerId);
    const actions = actionsTemplate.map((action) =>
      action
        .replaceAll("{{PROMPT}}", promptPlan.prompt)
        .replaceAll("{{DURATION_SEC}}", String(promptPlan.durationSec))
        .replaceAll("{{RESOLUTION}}", promptPlan.resolution),
    );

    return {
      providerId,
      startUrl,
      actions,
    };
  }

  private parseActionsJson(raw: string | undefined): string[] | null {
    if (!raw || raw.trim().length === 0) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("VIDEO_BROWSER_ACTIONS_JSON 不是数组");
      }

      const actions = parsed.filter((item): item is string => typeof item === "string");
      if (actions.length === 0) {
        throw new Error("VIDEO_BROWSER_ACTIONS_JSON 为空或不包含字符串动作");
      }

      return actions;
    } catch (error) {
      throw new Error(`解析 VIDEO_BROWSER_ACTIONS_JSON 失败: ${String(error)}`);
    }
  }

  private defaultProviderUrl(providerId: string): string {
    if (providerId === "jimeng") {
      return readEnv("JIMENG_WEB_URL")
        ?? "https://jimeng.jianying.com/ai-tool/home/?utm_medium=baiduads&utm_source=pinzhuan&utm_campaign=title";
    }

    return "";
  }

  private defaultProviderActions(providerId: string): string[] {
    if (providerId === "jimeng") {
      return [
        "wait:dom-ready",
        "click:text=视频生成",
        "type:selector=textarea, value={{PROMPT}}",
        "click:text=生成",
        "wait:text=生成完成",
      ];
    }

    throw new Error(
      `未找到 provider=${providerId} 的默认动作，请配置 VIDEO_BROWSER_ACTIONS_JSON`,
    );
  }

  private async generateByBrowserSkill(
    providerConfig: BrowserVideoProviderConfig,
    promptPlan: VideoPromptPlan,
    idempotencyKey: string,
  ): Promise<{
    provider: string;
    requestId: string;
    status: string;
    videoUrl?: string;
    fileId?: string;
    raw: Record<string, unknown>;
  }> {
    const openclawUrl = readEnv("OPENCLAW_SKILL_SERVICE_URL") ?? readEnv("OPENCLOW_SKILL_SERVICE_URL") ?? "";
    if (openclawUrl.trim().length === 0) {
      // 严格要求 skill-service 配置，不再使用 mock 回退
      throw new Error(
        "[market-agent] OPENCLAW_SKILL_SERVICE_URL 未配置。视频生成需要 skill-service 服务。" +
        " 请在 .env 中设置 OPENCLAW_SKILL_SERVICE_URL，并确保 skill-service 服务已启动。",
      );
    }

    const invoker = new SkillInvoker(
      openclawUrl,
      readEnv("OPENCLAW_SKILL_SERVICE_API_KEY") ?? readEnv("OPENCLOW_SKILL_SERVICE_API_KEY"),
    );

    console.log(`[MarketAgent] [${this.taskId}] 调用 skill-service 生成视频: ${providerConfig.providerId}`);
    // 添加超时机制，避免 skill-service 卡住
    const browserResult = await Promise.race([
      invoker.invoke("browser-automation", {
        start_url: providerConfig.startUrl,
        actions: providerConfig.actions,
        options: {
          provider: providerConfig.providerId,
          duration_sec: promptPlan.durationSec,
          resolution: promptPlan.resolution,
          idempotency_key: idempotencyKey,
        },
      }),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error(`skill-service 视频生成超时 (15秒)`)), 15000)
      ),
    ]);

    const requestId = this.readString(browserResult, ["request_id", "requestId", "job_id", "jobId"])
      ?? idempotencyKey;
    const status = this.readString(browserResult, ["status", "state"]) ?? "submitted";
    const videoUrl = this.readString(browserResult, ["video_url", "videoUrl", "result_url", "url"]);
    const fileId = this.readString(browserResult, ["file_id", "fileId", "asset_id", "assetId"]);

    return {
      provider: providerConfig.providerId,
      requestId,
      status,
      ...(videoUrl ? { videoUrl } : {}),
      ...(fileId ? { fileId } : {}),
      raw: browserResult,
    };
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

  private extractDuration(instruction: string): number {
    const secondMatch = instruction.match(/(\d{1,3})\s*(秒|s|sec)/i);
    if (secondMatch?.[1]) {
      const parsed = Number(secondMatch[1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.min(180, Math.max(6, Math.floor(parsed)));
      }
    }

    const minuteMatch = instruction.match(/(\d{1,2})\s*(分钟|min)/i);
    if (minuteMatch?.[1]) {
      const parsed = Number(minuteMatch[1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.min(180, Math.max(6, Math.floor(parsed * 60)));
      }
    }

    return 15;
  }

  private extractResolution(instruction: string): string {
    const normalized = instruction.toLowerCase();
    if (/4k|2160p/.test(normalized)) {
      return "3840x2160";
    }
    if (/1080p|full\s*hd/.test(normalized)) {
      return "1920x1080";
    }
    if (/720p|hd/.test(normalized)) {
      return "1280x720";
    }
    return "1920x1080";
  }

  private extractStyle(instruction: string, brand: BrandStrategy): string {
    if (/科技|tech|futur/i.test(instruction)) {
      return "tech";
    }
    if (/品牌|brand|高级|premium/i.test(instruction)) {
      return "brand";
    }
    if (/轻松|幽默|fun|casual/i.test(instruction)) {
      return "casual";
    }
    if (brand.voiceTone.includes("务实")) {
      return "business";
    }
    return "storytelling";
  }

  // market plan/content/brand 已切换到模型驱动生成，保留其他函数负责视频执行。
}
