type JsonObject = Record<string, unknown>;

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

export async function requestModelJson<T extends JsonObject>(
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  const apiKey = readEnv("AGENT_LLM_API_KEY") ?? readEnv("BLENDER_API_KEY");
  const baseUrl = (readEnv("AGENT_LLM_BASE_URL") ?? readEnv("BLENDER_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = readEnv("AGENT_LLM_MODEL") ?? readEnv("BLENDER_MODEL") ?? "gpt-4o-mini";

  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("缺少 AGENT_LLM_API_KEY/BLENDER_API_KEY，无法进行模型驱动输出。");
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
