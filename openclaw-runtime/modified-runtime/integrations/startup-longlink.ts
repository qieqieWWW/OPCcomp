/// <reference types="node" />

import * as Lark from "@larksuiteoapi/node-sdk";

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
  result?: string;
};

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
        console.log("[feishu-longlink] 事件触发 im.message.receive_v1", JSON.stringify(data).slice(0, 200));

        if (!this.messageHandler) {
          // eslint-disable-next-line no-console
          console.warn("[feishu-longlink] messageHandler 未注册，跳过处理");
          return;
        }

        const msgData = data as MessageReceiveEvent;
        const messageType = msgData.event?.message?.message_type ?? "";
        const content = msgData.event?.message?.content ?? "";
        const openId = msgData.event?.sender?.sender_id?.open_id ?? "";

        if (!openId || !messageType) {
          // eslint-disable-next-line no-console
          console.warn("[feishu-longlink] 事件缺少必要字段，跳过", { messageType, openId });
          return;
        }

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
const RUNTIME_TIMEOUT_MS = Number(process.env.FEISHU_RUNTIME_TIMEOUT_MS ?? "30000");

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
      content: { text: replyText },
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[feishu-longlink] 处理失败:", error);
    await bot.replyMessage(event, {
      msg_type: "text",
      content: { text: "服务异常，请稍后再试" },
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

    const payload = await response.json() as RuntimeExecuteResponse;
    if (!response.ok) {
      throw new Error(`runtime http=${response.status}`);
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}
