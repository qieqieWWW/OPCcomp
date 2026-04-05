import {
  AgentContext,
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentOutput,
} from "./base-agent";
import { SkillInvoker } from "../modified-runtime/tools/skill-invoker";

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

function readEnv(name: string): string | undefined {
  const maybeProcess = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return maybeProcess.process?.env?.[name];
}

export class MarketAgent extends DepartmentAgentRuntime {
  constructor(taskId: string, blackboard: BlackboardClient) {
    super("market", taskId, blackboard);
  }

  getDependencies(): ["strategy", "legal"] {
    return ["strategy", "legal"];
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
    const legalData = context.dependencies.legal?.output ?? {};
    const plan = await this.marketingPlan(strategyData, legalData);
    const content = await this.contentCreation(plan);
    const brand = await this.brandPositioning(plan);
    const promptPlan = this.buildVideoPromptPlan(context, plan, content, brand);
    const providerConfig = this.resolveBrowserVideoProviderConfig(promptPlan);
    const idempotencyKey = `${providerConfig.providerId}:${context.taskId}:market`;
    const receipt = await this.generateByBrowserSkill(providerConfig, promptPlan, idempotencyKey);

    if (!receipt.videoUrl && !receipt.fileId) {
      throw new Error(`视频服务未返回可用视频回执，服务商: ${providerConfig.providerId}，当前状态: ${receipt.status}`);
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
          request: {
            provider: providerConfig.providerId,
            start_url: providerConfig.startUrl,
            prompt: promptPlan.prompt,
            duration_sec: promptPlan.durationSec,
            resolution: promptPlan.resolution,
          },
          receipt,
        },
      },
      timestamp: new Date(),
      metadata: {
        dependencies: this.getDependencies(),
        idempotencyKey,
        executionMode: "browser_video_skill",
        provider: providerConfig.providerId,
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
      throw new Error("缺少技能服务地址，请设置 OPENCLAW_SKILL_SERVICE_URL");
    }

    const invoker = new SkillInvoker(
      openclawUrl,
      readEnv("OPENCLAW_SKILL_SERVICE_API_KEY") ?? readEnv("OPENCLOW_SKILL_SERVICE_API_KEY"),
    );

    const browserResult = await invoker.invoke("browser-automation", {
      start_url: providerConfig.startUrl,
      actions: providerConfig.actions,
      options: {
        provider: providerConfig.providerId,
        duration_sec: promptPlan.durationSec,
        resolution: promptPlan.resolution,
        idempotency_key: idempotencyKey,
      },
    });

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

  private async marketingPlan(
    strategyData: Record<string, unknown>,
    legalData: Record<string, unknown>,
  ): Promise<MarketingPlan> {
    const strategyWeight = Object.keys(strategyData).length > 0 ? 0.7 : 0.5;
    const legalWeight = Object.keys(legalData).length > 0 ? 0.3 : 0.5;
    return {
      campaignTheme: "替老板干活的AI团队",
      channels: ["公众号", "短视频", "私域直播"],
      budgetSplit: {
        strategy: strategyWeight,
        legal: legalWeight,
      },
    };
  }

  private async contentCreation(plan: MarketingPlan): Promise<ContentStrategy> {
    return {
      pillarTopics: [
        `${plan.campaignTheme}案例`,
        "部门协同方法论",
        "AI团队降本增效",
      ],
      weeklyCadence: "每周3篇图文+2条短视频",
    };
  }

  private async brandPositioning(marketData: MarketingPlan): Promise<BrandStrategy> {
    return {
      brandPosition: "一人公司可落地的AI运营系统",
      voiceTone: ["专业", "务实", "可执行"],
      targetAudience: ["创业者", "小微企业负责人", ...marketData.channels],
    };
  }
}
