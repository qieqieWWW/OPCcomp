/// <reference types="node" />

import * as Lark from "@larksuiteoapi/node-sdk";
import * as fs from "fs";
import * as path from "path";

type MessageReceiveEvent = {
  event?: {
    message?: {
      content?: string;
      message_type?: string;
    };
    sender?: {
      sender_id?: {
        open_id?: string;
      };
    };
  };
};

type RuntimeExecuteResponse = {
  ok?: boolean;
  error?: string;
  message?: string;
  result?: string;
};

class RuntimeCallError extends Error {
  code?: string;
}

loadDotEnv();

type BotMessageEvent = {
  message: {
    content: string;
    message_type: string;
  };
  sender: {
    sender_id: {
      open_id: string;
    };
  };
};

type BotReplyPayload = {
  msg_type: "text";
  content: {
    text: string;
  };
};

const processedEventKeys = new Map<string, number>();
const MESSAGE_DEDUP_WINDOW_MS = 5 * 60 * 1000; // 扩大到 5 分钟，防止飞书延迟重投
// 正在处理中的消息 key，防止并发竞态
const processingKeys = new Set<string>();

class FeishuLonglinkBot {
  private readonly client: Lark.Client;

  private readonly wsClient: Lark.WSClient;

  private readonly appId: string;

  private readonly appSecret: string;

  private messageHandler: ((event: BotMessageEvent) => Promise<void> | void) | null = null;

  constructor(config: { appId: string; appSecret: string }) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    // 长连接模式只需要 appId/appSecret，不传 webhookUrl。
    this.client = new Lark.Client(config);
    this.wsClient = new Lark.WSClient({
      ...config,
      loggerLevel: Lark.LoggerLevel.debug,
    });
  }

  on(eventName: "message", handler: (event: BotMessageEvent) => Promise<void> | void): void {
    if (eventName === "message") {
      this.messageHandler = handler;
    }
  }

  async replyMessage(event: BotMessageEvent, payload: BotReplyPayload): Promise<void> {
    await this.client.im.v1.message.create({
      params: {
        receive_id_type: "open_id",
      },
      data: {
        receive_id: event.sender.sender_id.open_id,
        msg_type: payload.msg_type,
        content: JSON.stringify(payload.content),
      },
    });
  }

  start(): Promise<void> {
    const eventDispatcher = new Lark.EventDispatcher({});

    eventDispatcher.register({
      "im.message.receive_v1": async (data: unknown) => {
        // eslint-disable-next-line no-console
        console.log("[feishu-longlink] 事件触发 im.message.receive_v1", JSON.stringify(data, null, 2));

        if (!this.messageHandler) {
          // eslint-disable-next-line no-console
          console.warn("[feishu-longlink] messageHandler 未注册，跳过处理");
          return;
        }

        // 飞书 SDK v2.0 事件结构：
        // message 和 sender 都在根级别
        const rawData = data as {
          event_id?: string;
          message?: { message_id?: string; message_type?: string; content?: string };
          sender?: { sender_id?: { open_id?: string } };
        };
        
        if (!rawData.message || !rawData.sender) {
          // eslint-disable-next-line no-console
          console.warn("[feishu-longlink] 消息数据为空，跳过", { data });
          return;
        }

        const eventId = rawData.event_id ?? "";
        const messageType = rawData.message?.message_type ?? "";
        const content = rawData.message?.content ?? "";
        const messageId = rawData.message?.message_id ?? "";
        const openId = rawData.sender?.sender_id?.open_id ?? "";

        if (!openId || !messageType) {
          // eslint-disable-next-line no-console
          console.warn("[feishu-longlink] 事件缺少必要字段，跳过", { messageType, openId, content });
          return;
        }

        const dedupKey = messageId || eventId;
        if (dedupKey) {
          if (isDuplicateMessage(dedupKey)) {
            // eslint-disable-next-line no-console
            console.log(`[feishu-longlink] 跳过重复消息（已处理完成）: ${dedupKey}`);
            return;
          }
          if (processingKeys.has(dedupKey)) {
            // eslint-disable-next-line no-console
            console.log(`[feishu-longlink] 跳过并发重复消息（处理中）: ${dedupKey}`);
            return;
          }
          // 原子性标记为处理中，防止并发竞态
          processingKeys.add(dedupKey);
        }

        try {
          await this.messageHandler({
            message: {
              content,
              message_type: messageType,
            },
            sender: {
              sender_id: {
                open_id: openId,
              },
            },
          });
          // 只有在成功完成后才标记为已处理
          if (dedupKey) {
            markMessageAsProcessed(dedupKey);
          }
        } catch (error) {
          // 处理失败时清除标记，允许重试
          if (dedupKey) {
            clearMessageMark(dedupKey);
          }
          throw error;
        } finally {
          // 处理完成后从进行中集合移除（无论成功还是失败）
          if (dedupKey) {
            processingKeys.delete(dedupKey);
          }
        }
      },
    });

    // WSClient.start() 内部会处理重连，返回 Promise 表示连接已建立
    return new Promise<void>((resolve, reject) => {
      this.wsClient.start({ eventDispatcher })
        .then(() => {
          // eslint-disable-next-line no-console
          console.log("[feishu-longlink] ✅ WSClient 已启动，等待飞书长连接...");
          resolve();
        })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error("[feishu-longlink] ❌ WSClient 启动失败", err);
          reject(err);
        });
    });
  }
}

const APP_ID = process.env.FEISHU_APP_ID ?? "";
const APP_SECRET = process.env.FEISHU_APP_SECRET ?? "";
const RUNTIME_EXECUTE_URL = process.env.FEISHU_RUNTIME_EXECUTE_URL ?? "http://127.0.0.1:30000/execute";
const RUNTIME_TIMEOUT_MS = Number(process.env.FEISHU_RUNTIME_TIMEOUT_MS ?? "120000");

if (!APP_ID || !APP_SECRET) {
  throw new Error("FEISHU_APP_ID / FEISHU_APP_SECRET 未配置，无法启动飞书长连接");
}

const baseConfig = {
  appId: APP_ID,
  appSecret: APP_SECRET,
};

const bot = new FeishuLonglinkBot(baseConfig);

bot.on("message", async (event: BotMessageEvent) => {
  if (event.message.message_type !== "text") {
    return;
  }

  const openId = event.sender.sender_id.open_id;
  const text = parseFeishuText(event.message.content);

  if (!text) {
    await bot.replyMessage(event, {
      msg_type: "text",
      content: { text: "未识别到有效文本指令，请直接输入任务描述。" },
    });
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[feishu-longlink] 收到消息 from ${openId}: ${text}`);

  try {
    const runtimeResult = await callRuntime(text, openId);
    const replyText = runtimeResult.result?.trim() ? runtimeResult.result : "处理完成";

    await bot.replyMessage(event, {
      msg_type: "text",
      content: { text: clampText(replyText, 1600) },
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[feishu-longlink] 处理失败:", error);

    if (error instanceof RuntimeCallError && error.code === "opc_unavailable") {
      await bot.replyMessage(event, {
        msg_type: "text",
        content: { text: "FAULT_CODE:ERR_OPC_UNAVAILABLE" },
      });
      return;
    }

    if (error instanceof RuntimeCallError && error.code === "runtime_timeout") {
      await bot.replyMessage(event, {
        msg_type: "text",
        content: { text: "FAULT_CODE:ERR_RUNTIME_TIMEOUT" },
      });
      return;
    }

    if (error instanceof RuntimeCallError) {
      await bot.replyMessage(event, {
        msg_type: "text",
        content: { text: `FAULT_CODE:${mapRuntimeCode(error.code)}` },
      });
      return;
    }

    await bot.replyMessage(event, {
      msg_type: "text",
      content: { text: "FAULT_CODE:ERR_RUNTIME_UNKNOWN" },
    });
  }
});

bot.start()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log("[feishu-longlink] 飞书长连接已启动");
  })
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[feishu-longlink] 启动失败:", error);
  });

function parseFeishuText(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as { text?: unknown };
    if (typeof parsed.text === "string") {
      return parsed.text.trim();
    }
  } catch {
    // Fallback to raw content.
  }

  return rawContent.trim();
}

async function callRuntime(input: string, openId: string): Promise<RuntimeExecuteResponse> {
  const timeoutMs = Number.isFinite(RUNTIME_TIMEOUT_MS) && RUNTIME_TIMEOUT_MS > 0
    ? RUNTIME_TIMEOUT_MS
    : 30000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(RUNTIME_EXECUTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, openId }),
      signal: controller.signal,
    });

    const payload = await parseRuntimeResponse(response);
    if (!response.ok) {
      const error = new RuntimeCallError(payload.message ?? `runtime http=${response.status}`);
      if (typeof payload.error === "string") {
        error.code = payload.error;
      }
      throw error;
    }

    if (payload.ok === false) {
      const error = new RuntimeCallError(payload.message ?? "runtime returned ok=false");
      if (typeof payload.error === "string") {
        error.code = payload.error;
      }
      throw error;
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      const timeoutError = new RuntimeCallError(`runtime 请求超时（>${timeoutMs}ms）`);
      timeoutError.code = "runtime_timeout";
      throw timeoutError;
    }
    if (error instanceof RuntimeCallError) {
      throw error;
    }
    const networkError = new RuntimeCallError(getErrorMessage(error));
    networkError.code = "runtime_network_error";
    throw networkError;
  } finally {
    clearTimeout(timer);
  }
}

async function parseRuntimeResponse(response: Response): Promise<RuntimeExecuteResponse> {
  const rawText = await response.text();
  if (!rawText) {
    return {};
  }

  try {
    return JSON.parse(rawText) as RuntimeExecuteResponse;
  } catch {
    return {
      ok: response.ok,
      message: `runtime 返回非 JSON 响应: ${clampText(rawText, 120)}`,
    };
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function clampText(input: string, maxLen: number): string {
  if (input.length <= maxLen) {
    return input;
  }
  return `${input.slice(0, Math.max(0, maxLen - 1))}…`;
}

function mapRuntimeCode(code: string | undefined): string {
  if (!code) {
    return "ERR_RUNTIME_CALL";
  }
  const normalized = code.toUpperCase();
  if (normalized.startsWith("ERR_")) {
    return normalized;
  }
  return `ERR_${normalized}`;
}

function isDuplicateMessage(messageKey: string): boolean {
  const now = Date.now();

  for (const [key, timestamp] of processedEventKeys.entries()) {
    if (now - timestamp > MESSAGE_DEDUP_WINDOW_MS) {
      processedEventKeys.delete(key);
    }
  }

  return processedEventKeys.has(messageKey);
}

function markMessageAsProcessed(messageKey: string): void {
  processedEventKeys.set(messageKey, Date.now());
}

function clearMessageMark(messageKey: string): void {
  processedEventKeys.delete(messageKey);
}

function loadDotEnv(): void {
  // 优先从脚本文件向上查找 .env，确保 PM2 / frp 等 cwd 不同时也能正确加载
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    // modified-runtime/integrations/ -> ../../.. -> runtime root
    path.resolve(__dirname, "..", "..", "..", ".env"),
    path.resolve(__dirname, ".env"),
  ];

  let envPath: string | undefined;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      envPath = candidate;
      break;
    }
  }

  if (!envPath) {
    console.warn("[feishu-longlink] .env 文件未找到，使用进程环境变量。已搜索路径:", candidates);
    return;
  }

  console.log(`[feishu-longlink] 加载 .env: ${envPath}`);
  const content = fs.readFileSync(envPath, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
