type JsonObject = Record<string, unknown>;

/** Agent 离线错误：千帆平台 HTTP 调用失败（404/401/403/500 等） */
export class AgentOfflineError extends Error {
  public readonly httpStatus: number;
  public readonly department: string;
  public readonly isOffline: true = true;

  constructor(message: string, httpStatus: number, department: string) {
    super(message);
    this.name = "AgentOfflineError";
    this.httpStatus = httpStatus;
    this.department = department;
  }
}

function readEnv(name: string): string | undefined {
  const maybeProcess = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return maybeProcess.process?.env?.[name];
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (!ch) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/**
 * 统一的 LLM 调用入口。
 * 根据 AGENT_LLM_BACKEND 环境变量自动选择后端：
 *   "qianfan" → 千帆平台 App Runs API（需要 QIANFAN_HOST / QIANFAN_ACCESS_KEY / QIANFAN_SECRET_KEY）
 *   其他或空 → OpenAI 兼容 chat/completions API（原有逻辑）
 *
 * 部门 Agent 的 department 名称会被映射到对应的千帆 Agent app_id：
 *   evidence  → evidence-agent
 *   feasibility → feasibility-agent
 *   risk      → risk-agent
 *   legal     → legal-agent
 */
export async function requestModelJson<T extends JsonObject>(
  systemPrompt: string,
  userPrompt: string,
  options?: { department?: string },
): Promise<T> {
  const backend = (readEnv("AGENT_LLM_BACKEND") ?? "").toLowerCase().trim();
  if (backend === "qianfan") {
    return requestModelJsonQianfan<T>(systemPrompt, userPrompt, options?.department);
  }
  return requestModelJsonOpenAI<T>(systemPrompt, userPrompt);
}

// ── OpenAI 兼容后端（原始实现）───────────────────────────────────────
async function requestModelJsonOpenAI<T extends JsonObject>(
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  const apiKey = readEnv("AGENT_LLM_API_KEY") ?? readEnv("BLENDER_API_KEY");
  const baseUrl = (readEnv("AGENT_LLM_BASE_URL") ?? readEnv("BLENDER_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = readEnv("AGENT_LLM_MODEL") ?? readEnv("BLENDER_MODEL") ?? "gpt-4o-mini";

  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("缺少 AGENT_LLM_API_KEY/BLENDER_API_KEY，无法进行模型驱动输出。（提示：设 AGENT_LLM_BACKEND=qianfan 可改用千帆后端）");
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`模型调用失败: http=${response.status}, body=${raw.slice(0, 300)}`);
  }

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };

  const content = payload.choices?.[0]?.message?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => (part && typeof part === "object" && part.type === "text" ? part.text ?? "" : ""))
      .join("\n");
  }

  const jsonText = extractFirstJsonObject(text) ?? text;
  if (!jsonText || jsonText.trim().length === 0) {
    throw new Error("模型返回为空，无法解析 JSON。");
  }

  return JSON.parse(jsonText) as T;
}

export function ensureString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

export function ensureStringArray(value: unknown, fallback: string[]): string[] {
  const arr = asStringArray(value);
  return arr.length > 0 ? arr : fallback;
}

export function ensureNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

// ── 千帆平台后端（App Runs API）──────────────────────────────────────
// 千帆 Agent 名称 → app_id 映射（与 config/qianfan_agents.json 保持一致）

const QIANFAN_AGENT_MAP: Record<string, string> = {
  evidence: "be5117b4-2611-4afd-a112-820b475e40ad",
  feasibility: "49e14f25-d38e-4fe0-8edf-d8f855d690ab",
  risk: "b02b9673-e7ea-4105-83c0-83c942d74404",
  legal: "307edb41-8370-4a24-99d6-d528b89ec253",
};

/** 默认 Agent：当 department 无法匹配时使用（选用 evidence-agent 作为通用 Agent） */
const QIANFAN_DEFAULT_APP_ID = QIANFAN_AGENT_MAP.evidence;

async function qianfanSignToken(bodyStr: string, secretKey: string, requestId: string, signTime: string): Promise<string> {
  const crypto = globalThis as unknown as { crypto?: { subtle?: { digest: (algo: string, data: Uint8Array) => Promise<ArrayBuffer> } } };
  // Node.js ≥ 18 / Deno / modern browsers
  if (crypto.crypto?.subtle) {
    const data = new TextEncoder().encode(`${bodyStr}${secretKey}${requestId}${signTime}`);
    const buf = await crypto.crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback: should not happen in Node.js runtime, but just in case
  throw new Error("当前环境不支持 SHA-256 签名（需要 crypto.subtle）");
}

async function buildQianfanHeaders(bodyStr: string): Promise<Record<string, string>> {
  const accessKey = readEnv("QIANFAN_ACCESS_KEY") ?? "";
  const secretKey = readEnv("QIANFAN_SECRET_KEY") ?? "";
  const authMode = (readEnv("QIANFAN_AUTH_MODE") ?? "signature").toLowerCase();
  const bearerToken = readEnv("QIANFAN_BEARER_TOKEN") ?? "";

  if (authMode === "bearer" && bearerToken) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerToken}`,
    };
  }

  // signature 模式（默认）
  const requestId = crypto.randomUUID().replace(/-/g, "");
  const signTime = new Date().toISOString().replace("T", " ").slice(0, 19);
  const token = await qianfanSignToken(bodyStr, secretKey, requestId, signTime);

  return {
    "Content-Type": "application/json",
    "X-Bce-Request-ID": requestId,
    "Access-Key": accessKey,
    "Sign-Time": signTime,
    Token: token,
  };
}

/**
 * 通过千帆 App Runs API 调用 LLM 并解析为 JSON。
 *
 * 流程：
 *  1. 根据 department 映射到对应的千帆 Agent app_id
 *  2. 新建会话 POST /api/ai_apaas/v1/app/conversation → conversation_id
 *  3. 发送对话 POST /api/ai_apaas/v1/app/conversation/runs → answer
 *  4. 从 answer 中提取第一个 JSON 对象
 */
async function requestModelJsonQianfan<T extends JsonObject>(
  systemPrompt: string,
  userPrompt: string,
  department?: string,
): Promise<T> {
  const host = (readEnv("QIANFAN_HOST") ?? "").replace(/\/$/, "");
  if (!host) {
    throw new Error("AGENT_LLM_BACKEND=qianfan 但 QIANFAN_HOST 未配置（如 http://qianfan.xjtlu.edu.cn:8080）");
  }

  const appId = QIANFAN_AGENT_MAP[department ?? ""] ?? QIANFAN_DEFAULT_APP_ID;
  console.log(`[model-json] 千帆后端: department=${department ?? "(default)"} → app_id=${(appId ?? "").slice(0, 8)}...`);

  // Step 1: 新建会话
  const convPayload = JSON.stringify({ app_id: appId });
  const convHeaders = await buildQianfanHeaders(convPayload);
  const convResp = await fetch(`${host}/api/ai_apaas/v1/app/conversation`, {
    method: "POST",
    headers: convHeaders,
    body: convPayload,
  });
  if (!convResp.ok) {
    const raw = await convResp.text();
    throw new AgentOfflineError(
      `千帆新建会话失败: http=${convResp.status}, body=${raw.slice(0, 300)}`,
      convResp.status,
      department ?? "unknown",
    );
  }
  const convData = await convResp.json() as { conversation_id?: string };
  const conversationId = convData.conversation_id;
  if (!conversationId) {
    throw new Error(`千帆新建会话未返回 conversation_id: ${JSON.stringify(convData).slice(0, 300)}`);
  }

  // Step 2: 发送对话（system + user 合并为 query）
  const query = systemPrompt
    ? `[系统指令]\n${systemPrompt}\n\n[用户请求]\n${userPrompt}`
    : userPrompt;
  const runPayload = JSON.stringify({
    app_id: appId,
    query,
    stream: false,
    conversation_id: conversationId,
  });
  const runHeaders = await buildQianfanHeaders(runPayload);
  const runResp = await fetch(`${host}/api/ai_apaas/v1/app/conversation/runs`, {
    method: "POST",
    headers: runHeaders,
    body: runPayload,
  });
  if (!runResp.ok) {
    const raw = await runResp.text();
    throw new AgentOfflineError(
      `千帆对话请求失败: http=${runResp.status}, body=${raw.slice(0, 300)}`,
      runResp.status,
      department ?? "unknown",
    );
  }
  const runData = await runResp.json() as { answer?: string; content?: Array<{ outputs?: { text?: string } }> };

  // Step 3: 提取回答文本
  let answer = runData.answer ?? "";
  if (!answer) {
    const contentItems = runData.content ?? [];
    if (Array.isArray(contentItems)) {
      const texts: string[] = [];
      for (const item of contentItems) {
        if (item && typeof item === "object") {
          const t = (item as Record<string, unknown>).outputs;
          if (t && typeof t === "object") {
            const text = (t as Record<string, unknown>).text;
            if (typeof text === "string" && text.trim()) {
              texts.push(text.trim());
            }
          }
        }
      }
      answer = texts.join("\n");
    }
  }

  if (!answer || answer.trim().length === 0) {
    throw new Error("千帆 Agent 返回为空。");
  }

  // Step 4: 提取第一个 JSON 对象
  const jsonText = extractFirstJsonObject(answer) ?? answer;
  if (!jsonText || jsonText.trim().length === 0) {
    throw new Error(`千帆返回内容无法解析为 JSON，原始回答前200字: ${answer.slice(0, 200)}`);
  }

  try {
    return JSON.parse(jsonText) as T;
  } catch (parseErr) {
    throw new Error(`千帆返回 JSON 解析失败: ${(parseErr as Error).message}\n原始前200字: ${answer.slice(0, 200)}`);
  }
}
