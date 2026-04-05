#!/usr/bin/env node
"use strict";

const http = require("node:http");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "127.0.0.1";

const skills = [
  {
    name: "browser-automation",
    description: "本地浏览器自动化服务：使用 Playwright 执行真实页面动作",
  },
];

const server = http.createServer(async (req, res) => {
  setCommonHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "openclaw-local-skill-service",
      status: "running",
      port: PORT,
      host: HOST,
    });
    return;
  }

  if (req.method === "GET" && req.url === "/skills") {
    sendJson(res, 200, { skills });
    return;
  }

  if (req.method === "POST" && req.url === "/skills/invoke") {
    try {
      const body = await readJsonBody(req);
      const skillName = normalizeString(body?.skill);
      const parameters = isObject(body?.parameters) ? body.parameters : {};

      if (skillName !== "browser-automation") {
        sendJson(res, 404, {
          ok: false,
          error: `Unsupported skill: ${skillName || "<empty>"}`,
        });
        return;
      }

      const result = await invokeBrowserAutomation(parameters);
      sendJson(res, 200, result);
      return;
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  sendJson(res, 404, {
    ok: false,
    error: "Not found",
    available: ["GET /health", "GET /skills", "POST /skills/invoke"],
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[skill-service] listening on http://${HOST}:${PORT}`);
  console.log(`[skill-service] skill endpoint: http://${HOST}:${PORT}/skills/invoke`);
});

function invokeBrowserAutomation(parameters) {
  if (process.env.SKILL_SERVICE_MOCK_MODE === "true") {
    return invokeBrowserAutomationMock(parameters);
  }

  return invokeBrowserAutomationReal(parameters);
}

async function invokeBrowserAutomationReal(parameters) {
  const startUrl = normalizeString(parameters.start_url) || normalizeString(parameters.startUrl) || "";
  if (!startUrl) {
    throw new Error("Missing required parameter: start_url");
  }

  const options = isObject(parameters.options) ? parameters.options : {};
  const actions = Array.isArray(parameters.actions)
    ? parameters.actions.filter((item) => typeof item === "string")
    : [];
  const provider = normalizeString(options.provider) || detectProvider(startUrl);
  const requestId = `live-${randomUUID().slice(0, 8)}`;
  const timeout = clampInteger(options.timeout_ms ?? options.timeoutMs ?? 20000, 20000, 1000, 120000);
  const headless = String(process.env.SKILL_BROWSER_HEADLESS ?? "true") !== "false";

  const { chromium } = loadPlaywright();

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  const actionLogs = [];
  const extractedLists = [];

  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout });

    for (const action of actions) {
      const log = await executeAction(page, action, timeout);
      actionLogs.push(log);
      if (Array.isArray(log.extracted) && log.extracted.length > 0) {
        extractedLists.push(...log.extracted);
      }
    }

    const currentUrl = page.url();
    const baseResult = {
      provider,
      request_id: requestId,
      requestId,
      status: provider === "jimeng" ? "submitted" : "completed",
      state: provider === "jimeng" ? "submitted" : "completed",
      start_url: startUrl,
      startUrl,
      url: currentUrl,
      result_url: currentUrl,
      actions,
      action_logs: actionLogs,
      raw: {
        options,
      },
    };

    if (provider === "baidu" || /baidu\.com/i.test(startUrl)) {
      const query = extractQuery({ options, parameters, actions }) || "OPC";
      const topK = clampInteger(options.top_k ?? options.topK ?? process.env.BAIDU_TOP_K, 5, 1, 10);
      const hits = extractedLists
        .filter((item) => isObject(item) && normalizeString(item.url))
        .slice(0, topK)
        .map((item) => ({
          title: normalizeString(item.title) || "未命名结果",
          url: normalizeString(item.url),
          ...(normalizeString(item.snippet) ? { snippet: normalizeString(item.snippet) } : {}),
        }));

      return {
        ...baseResult,
        query,
        top_k: topK,
        topK,
        hits,
        results: hits,
        items: hits,
        links: hits,
        pages: hits,
        summary: hits.length > 0
          ? `真实浏览器已完成百度搜索，关键词“${query}”命中 ${hits.length} 条结果。`
          : `真实浏览器已执行百度搜索动作，但未提取到结构化结果。`,
      };
    }

    if (provider === "jimeng" || /jimeng|jianying|即梦/i.test(startUrl)) {
      const prompt = extractPrompt({ options, parameters, actions }) || "";
      const durationSec = clampInteger(options.duration_sec ?? options.durationSec ?? parameters.duration_sec, 15, 1, 180);
      const resolution = normalizeString(options.resolution) || normalizeString(parameters.resolution) || "1920x1080";

      return {
        ...baseResult,
        prompt,
        duration_sec: durationSec,
        durationSec,
        resolution,
        file_id: `jimeng-${requestId}`,
        fileId: `jimeng-${requestId}`,
        summary: "真实浏览器已执行即梦页面动作，返回提交回执。",
      };
    }

    return {
      ...baseResult,
      summary: `真实浏览器已执行 ${actions.length} 个动作。`,
    };
  } catch (error) {
    throw new Error(`browser-automation failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

function invokeBrowserAutomationMock(parameters) {
  const startUrl = normalizeString(parameters.start_url) || normalizeString(parameters.startUrl) || "";
  const options = isObject(parameters.options) ? parameters.options : {};
  const actions = Array.isArray(parameters.actions)
    ? parameters.actions.filter((item) => typeof item === "string")
    : [];
  const provider = normalizeString(options.provider) || detectProvider(startUrl);
  const requestId = `mock-${randomUUID().slice(0, 8)}`;

  if (provider === "baidu" || /baidu\.com/i.test(startUrl)) {
    return buildBaiduResponse({
      requestId,
      startUrl,
      actions,
      options,
      parameters,
    });
  }

  if (provider === "jimeng" || /jimeng|jianying|即梦/i.test(startUrl)) {
    return buildJimengResponse({
      requestId,
      startUrl,
      actions,
      options,
      parameters,
    });
  }

  return {
    provider,
    request_id: requestId,
    requestId,
    status: "completed",
    state: "completed",
    start_url: startUrl,
    startUrl,
    actions,
    summary: `本地 mock skill service 已执行 ${actions.length} 个动作。`,
    raw: {
      start_url: startUrl,
      actions,
      options,
    },
  };
}

async function executeAction(page, action, timeout) {
  const trimmed = String(action).trim();

  if (trimmed === "wait:dom-ready") {
    await page.waitForLoadState("domcontentloaded", { timeout });
    return { action: trimmed, ok: true, effect: "dom-ready" };
  }

  if (trimmed.startsWith("wait:text=")) {
    const text = trimmed.slice("wait:text=".length).trim();
    await page.locator(`text=${text}`).first().waitFor({ timeout });
    return { action: trimmed, ok: true, effect: `wait-text:${text}` };
  }

  if (trimmed.startsWith("click:text=")) {
    const text = trimmed.slice("click:text=".length).trim();
    await page.locator(`text=${text}`).first().click({ timeout });
    return { action: trimmed, ok: true, effect: `click-text:${text}` };
  }

  if (trimmed.startsWith("click:selector=")) {
    const selector = trimmed.slice("click:selector=".length).trim();
    const visibleSelector = toVisibleSelector(selector);
    try {
      await page.waitForSelector(visibleSelector, { state: "visible", timeout });
      await page.click(visibleSelector, { timeout });
    } catch (error) {
      if (isBaiduPage(page.url()) && /input\[type=['"]?submit['"]?\]/i.test(selector)) {
        return {
          action: trimmed,
          ok: true,
          effect: "baidu-submit-skipped",
          warning: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    }
    return { action: trimmed, ok: true, effect: `click-selector:${selector}` };
  }

  if (trimmed.startsWith("type:selector=")) {
    const parsed = parseSelectorValueAction(trimmed, "type:selector=");
    const visibleSelector = toVisibleSelector(parsed.selector);
    try {
      await page.waitForSelector(visibleSelector, { state: "visible", timeout });
      await page.fill(visibleSelector, parsed.value, { timeout });
    } catch (error) {
      if (isBaiduPage(page.url()) && /name=['"]?wd['"]?/i.test(parsed.selector)) {
        const target = `https://www.baidu.com/s?wd=${encodeURIComponent(parsed.value)}`;
        await page.goto(target, { waitUntil: "domcontentloaded", timeout });
        return {
          action: trimmed,
          ok: true,
          effect: `baidu-direct-search:${target}`,
          warning: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    }
    return { action: trimmed, ok: true, effect: `type-selector:${parsed.selector}` };
  }

  if (trimmed.startsWith("extract:list=")) {
    const selector = trimmed.slice("extract:list=".length).trim();
    await page.locator(selector).first().waitFor({ timeout });
    const extracted = await page.$$eval(selector, (nodes) => nodes.map((node) => {
      const anchor = node.tagName === "A" ? node : node.querySelector("a");
      const title = (node.textContent || "").trim().replace(/\s+/g, " ");
      return {
        title,
        url: anchor ? anchor.href : "",
      };
    }));
    return { action: trimmed, ok: true, effect: `extract-list:${selector}`, extracted };
  }

  if (trimmed === "wait:network-idle") {
    await page.waitForLoadState("networkidle", { timeout });
    return { action: trimmed, ok: true, effect: "network-idle" };
  }

  return { action: trimmed, ok: true, effect: "ignored-unsupported-action" };
}

function parseSelectorValueAction(input, prefix) {
  const body = input.slice(prefix.length).trim();
  const marker = ", value=";
  const markerIndex = body.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Invalid action format: ${input}`);
  }

  const selector = body.slice(0, markerIndex).trim();
  const value = cleanupActionValue(body.slice(markerIndex + marker.length));
  if (!selector) {
    throw new Error(`Selector is empty in action: ${input}`);
  }
  return { selector, value };
}

function toVisibleSelector(selector) {
  if (!selector) {
    return selector;
  }

  if (selector.includes(":visible")) {
    return selector;
  }

  if (selector.startsWith("text=")) {
    return selector;
  }

  return `${selector}:visible`;
}

function isBaiduPage(url) {
  return /baidu\.com/i.test(String(url));
}

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    throw new Error("Playwright is not installed. Run: npm install playwright && npx playwright install chromium");
  }
}

function buildBaiduResponse({ requestId, startUrl, actions, options, parameters }) {
  const query = extractQuery({ options, parameters, actions }) || "OPC";
  const topK = clampInteger(options.top_k ?? options.topK ?? process.env.BAIDU_TOP_K, 5, 1, 10);
  const encodedQuery = encodeURIComponent(query);
  const hits = Array.from({ length: topK }, (_, index) => {
    const rank = index + 1;
    return {
      title: `${query} - 百度模拟结果 ${rank}`,
      url: `https://www.baidu.com/s?wd=${encodedQuery}&mock=${rank}`,
      snippet: `这是关键词“${query}”的本地模拟结果 ${rank}，用于验证小模型 -> agent -> 浏览器链路。`,
    };
  });

  return {
    provider: "baidu",
    request_id: requestId,
    requestId,
    status: "completed",
    state: "completed",
    start_url: startUrl,
    startUrl,
    query,
    top_k: topK,
    topK,
    actions,
    hits,
    results: hits,
    items: hits,
    links: hits,
    pages: hits,
    summary: `关键词“${query}”已完成本地百度模拟检索，返回 ${topK} 条结果。`,
    result_url: `https://www.baidu.com/s?wd=${encodedQuery}`,
    url: `https://www.baidu.com/s?wd=${encodedQuery}`,
    raw: {
      start_url: startUrl,
      actions,
      options,
      parameters,
    },
  };
}

function buildJimengResponse({ requestId, startUrl, actions, options, parameters }) {
  const prompt = extractPrompt({ options, parameters, actions }) || "本地 mock 即梦任务";
  const durationSec = clampInteger(options.duration_sec ?? options.durationSec ?? parameters.duration_sec, 15, 1, 180);
  const resolution = normalizeString(options.resolution) || normalizeString(parameters.resolution) || "1920x1080";
  const encodedPrompt = encodeURIComponent(prompt);
  const videoUrl = `http://${HOST}:${PORT}/mock-artifacts/${requestId}.mp4`;

  return {
    provider: "jimeng",
    request_id: requestId,
    requestId,
    status: "submitted",
    state: "submitted",
    start_url: startUrl,
    startUrl,
    prompt,
    duration_sec: durationSec,
    durationSec,
    resolution,
    actions,
    video_url: videoUrl,
    videoUrl,
    file_id: `file-${requestId}`,
    fileId: `file-${requestId}`,
    result_url: videoUrl,
    url: videoUrl,
    summary: `即梦本地 mock 任务已提交，提示词：${prompt}`,
    raw: {
      start_url: startUrl,
      actions,
      options,
      parameters,
      encoded_prompt: encodedPrompt,
    },
  };
}

function extractQuery({ options, parameters, actions }) {
  const candidates = [
    options.query,
    options.keyword,
    parameters.query,
    parameters.keyword,
    process.env.BAIDU_SEARCH_KEYWORD,
  ];

  for (const value of candidates) {
    const text = normalizeString(value);
    if (text) {
      return text;
    }
  }

  for (const action of actions) {
    const match = action.match(/value\s*=\s*(.+)$/i);
    if (match?.[1]) {
      return cleanupActionValue(match[1]);
    }
  }

  return "";
}

function extractPrompt({ options, parameters, actions }) {
  const candidates = [
    options.prompt,
    parameters.prompt,
    parameters.message,
  ];

  for (const value of candidates) {
    const text = normalizeString(value);
    if (text) {
      return text;
    }
  }

  for (const action of actions) {
    const match = action.match(/value\s*=\s*(.+)$/i);
    if (match?.[1]) {
      return cleanupActionValue(match[1]);
    }
  }

  return "";
}

function detectProvider(startUrl) {
  if (/baidu\.com/i.test(startUrl)) {
    return "baidu";
  }
  if (/jimeng|jianying|即梦/i.test(startUrl)) {
    return "jimeng";
  }
  return "generic";
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function cleanupActionValue(value) {
  const trimmed = String(value).trim();
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function normalizeString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function setCommonHeaders(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
