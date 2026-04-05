from __future__ import annotations

import argparse
import html
import importlib
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = PROJECT_ROOT / "src"
if str(SRC_ROOT) not in os.sys.path:
    os.sys.path.insert(0, str(SRC_ROOT))


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, indent=2)
    return str(value)


def _safe(v: Any) -> str:
    return html.escape(_stringify(v))


def _score_percent(score: Any) -> int:
    try:
        num = float(score)
    except Exception:
        return 0
    if num <= 1:
        return int(max(0.0, min(1.0, num)) * 100)
    return int(max(0.0, min(10.0, num)) / 10.0 * 100)


def _chunk_list(items: List[str], size: int = 4) -> List[List[str]]:
    if not items:
        return []
    return [items[i : i + size] for i in range(0, len(items), size)]


def build_dashboard_html(default_api_key: str = "") -> str:
    page = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OPC 联调看板</title>
  <style>
    :root {
      --bg: #0b1220;
      --panel: rgba(15, 23, 42, 0.82);
      --line: rgba(148, 163, 184, 0.20);
      --text: #e5e7eb;
      --muted: #94a3b8;
      --accent: #3b82f6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(circle at top right, rgba(34,197,94,0.16), transparent 28%),
        radial-gradient(circle at top left, rgba(56,189,248,0.16), transparent 28%),
        linear-gradient(180deg, #020617 0%, #0f172a 100%);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }
    .head {
      padding: 16px 18px 8px;
    }
    .head h1 {
      margin: 0;
      font-size: 24px;
    }
    .head p {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 13px;
    }
    .shell {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 12px;
      padding: 10px 18px 16px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel);
      box-shadow: 0 12px 30px rgba(2, 6, 23, 0.3);
    }
    .inner { padding: 12px; }
    .title {
      font-size: 15px;
      font-weight: 700;
      margin-bottom: 10px;
    }
    .form-grid { display: grid; gap: 8px; }
    label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
    }
    input, select, textarea, button {
      width: 100%;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: rgba(2, 6, 23, 0.6);
      color: var(--text);
      padding: 8px 10px;
      font-size: 13px;
      outline: none;
    }
    textarea { min-height: 92px; resize: vertical; line-height: 1.5; }
    button {
      border: 0;
      cursor: pointer;
      font-weight: 700;
      background: linear-gradient(135deg, #38bdf8, var(--accent));
    }
    button:disabled { opacity: 0.7; cursor: not-allowed; }
    .tip { color: var(--muted); font-size: 12px; line-height: 1.55; }
    .main {
      display: grid;
      gap: 12px;
    }
    .tabs {
      display: inline-flex;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 4px;
      width: fit-content;
      background: rgba(2, 6, 23, 0.5);
    }
    .tab-btn {
      display: inline-block;
      width: auto;
      padding: 7px 12px;
      border-radius: 8px;
      border: 0;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font-size: 13px;
      font-weight: 700;
    }
    .tab-radio {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
    #tabRadioStructured:checked ~ .tabs label[for="tabRadioStructured"],
    #tabRadioChat:checked ~ .tabs label[for="tabRadioChat"] {
      color: #dbeafe;
      background: rgba(59,130,246,0.28);
    }
    .views > .card { display: none; }
    #tabRadioStructured:checked ~ .views #structuredView { display: block; }
    #tabRadioChat:checked ~ .views #chatView { display: block; }
    .hidden { display: none !important; }
    .line {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(2, 6, 23, 0.55);
      padding: 10px;
      white-space: pre-wrap;
      line-height: 1.5;
      font-size: 13px;
    }
    .result-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .collab-wrap {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(2, 6, 23, 0.55);
      padding: 10px;
      display: grid;
      gap: 10px;
    }
    .collab-lanes {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .collab-lane {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(15, 23, 42, 0.75);
      padding: 8px;
      display: grid;
      gap: 8px;
      min-height: 120px;
    }
    .collab-lane-title {
      font-size: 12px;
      color: #93c5fd;
      font-weight: 700;
    }
    .collab-node {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(59,130,246,0.16);
      padding: 7px 8px;
      display: grid;
      gap: 3px;
    }
    .collab-node-name {
      font-size: 12px;
      color: #dbeafe;
      font-weight: 700;
    }
    .collab-node-role {
      font-size: 11px;
      color: var(--muted);
    }
    .collab-edges {
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 8px;
      display: grid;
      gap: 6px;
      background: rgba(2, 6, 23, 0.45);
    }
    .collab-edge {
      font-size: 12px;
      color: #cbd5e1;
      line-height: 1.45;
    }
    .result-card {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(2, 6, 23, 0.55);
      overflow: hidden;
    }
    .result-card > summary {
      list-style: none;
      cursor: pointer;
      padding: 10px;
      display: grid;
      gap: 4px;
    }
    .result-card > summary::-webkit-details-marker { display: none; }
    .result-title {
      font-size: 13px;
      font-weight: 700;
      color: #dbeafe;
    }
    .result-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .source-tag {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      color: #bfdbfe;
      background: rgba(59,130,246,0.18);
      white-space: nowrap;
    }
    .result-brief {
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
    }
    .result-detail {
      border-top: 1px solid var(--line);
      padding: 10px;
      white-space: pre-wrap;
      font-size: 12px;
      line-height: 1.55;
      color: #d1d5db;
      max-height: 260px;
      overflow: auto;
    }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chip {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 12px;
      background: rgba(59,130,246,0.15);
      color: #dbeafe;
    }
    .chat-list { display: grid; gap: 10px; }
    .chat-msg {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
      white-space: pre-wrap;
      line-height: 1.55;
      font-size: 13px;
      background: rgba(2, 6, 23, 0.55);
    }
    .chat-user { color: #93c5fd; }
    .chat-ai { color: #e5e7eb; }
    .loading {
      color: #bae6fd;
      font-size: 12px;
      padding: 4px 2px;
    }
    @media (max-width: 1100px) {
      .shell { grid-template-columns: 1fr; }
      .result-grid { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 760px) {
      .result-grid { grid-template-columns: 1fr; }
      .collab-lanes { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="head">
    <h1>OPC 结构化联调看板</h1>
    <p>保留结构化联调能力，并提供用户可见对话视图。</p>
  </div>

  <div class="shell">
    <section class="card">
      <div class="inner">
        <div class="title">联调参数</div>
        <div class="form-grid">
          <label>输入文本
            <textarea id="textInput">我准备做一人公司跨境电商代运营，预算紧张、没有技术团队，先给我一个90天落地方案并标出最高风险。</textarea>
          </label>
          <label>Provider
            <select id="providerSelect">
              <option value="deepseek">deepseek（个人联调）</option>
              <option value="qianfan">qianfan（赛事千帆）</option>
            </select>
          </label>
          <label>Host / Base URL
            <input id="endpointInput" placeholder="https://api.deepseek.com 或 http://10.7.88.150:8080" />
          </label>
          <label>Model
            <input id="modelInput" placeholder="deepseek-chat / test" />
          </label>
          <label>API Key
            <input id="apiKeyInput" placeholder="填入 API Key（remote=true 时建议填写）" />
          </label>
          <label>调用远程大模型摘要
            <select id="remoteSelect">
              <option value="false">否</option>
              <option value="true">是</option>
            </select>
          </label>
          <button id="runBtn" type="button" onclick="runPipeline()">运行并渲染结构化结果</button>
          <div id="statusText" class="loading">就绪</div>
          <div class="tip">如果点击无反应，先强制刷新（Cmd+Shift+R）再试。</div>
        </div>
      </div>
    </section>

    <section class="main">
      <input id="tabRadioStructured" class="tab-radio" type="radio" name="tabView" checked>
      <input id="tabRadioChat" class="tab-radio" type="radio" name="tabView">
      <div class="tabs">
        <label id="tabStructured" class="tab-btn" for="tabRadioStructured">结构化结果视图</label>
        <label id="tabChat" class="tab-btn" for="tabRadioChat">用户对话视图</label>
      </div>

      <div class="views">
      <div id="structuredView" class="card">
        <div class="inner">
          <div class="title">结构化结果</div>
          <div id="resultCards" class="result-grid">
            <details class="result-card" open>
              <summary>
                <div class="result-title">等待运行</div>
                <div class="result-brief">点击左侧按钮获取结构化结果</div>
              </summary>
              <div class="result-detail">尚未运行</div>
            </details>
          </div>
          <div style="height:10px"></div>
          <details class="result-card">
            <summary>
              <div class="result-title">完整 JSON</div>
              <div class="result-brief">点击展开详细结构</div>
            </summary>
            <div id="rawJson" class="result-detail">尚未运行</div>
          </details>
          <div style="height:10px"></div>
          <div class="title">Agent 协作图</div>
          <div id="collabGraph" class="collab-wrap">
            <div class="collab-lanes">
              <div class="collab-lane"><div class="collab-lane-title">前排分析</div></div>
              <div class="collab-lane"><div class="collab-lane-title">执行落地</div></div>
              <div class="collab-lane"><div class="collab-lane-title">法务支撑</div></div>
            </div>
            <div class="collab-edges"><div class="collab-edge">等待运行后生成协作连线</div></div>
          </div>
        </div>
      </div>

      <div id="chatView" class="card">
        <div class="inner">
          <div class="title">用户可见对话</div>
          <div id="chatMeta" class="chips"></div>
          <div style="height:10px"></div>
          <div class="chat-list" id="chatWindow">
            <div class="chat-msg chat-user">你：请先输入问题并运行。</div>
            <div class="chat-msg chat-ai">AI：这里会显示回复与动作建议。</div>
          </div>
          <div style="height:10px"></div>
          <div class="title">动作信息</div>
          <div id="chatActions" class="line">暂无动作</div>
        </div>
      </div>
      </div>
    </section>
  </div>

  <script>
    function el(id) { return document.getElementById(id); }
    function valueOr(v, d) { return v === undefined || v === null ? d : v; }
    var DEFAULT_API_KEY = __DEFAULT_API_KEY_JSON__;
    function storageGet(key, fallback) {
      try {
        var v = window.localStorage ? window.localStorage.getItem(key) : null;
        return v === null || v === undefined ? fallback : v;
      } catch (e) {
        return fallback;
      }
    }
    function storageSet(key, value) {
      try {
        if (window.localStorage) {
          window.localStorage.setItem(key, value);
        }
      } catch (e) {
      }
    }
    function deepGet(obj, path, fallback) {
      var cur = obj;
      for (var i = 0; i < path.length; i += 1) {
        if (cur === undefined || cur === null) return fallback;
        cur = cur[path[i]];
      }
      return cur === undefined || cur === null ? fallback : cur;
    }
    function esc(s) {
      return String(valueOr(s, ''))
        .split('&').join('&amp;')
        .split('<').join('&lt;')
        .split('>').join('&gt;')
        .split('"').join('&quot;')
        .split("'").join('&#39;');
    }

    var state = {
      runClicks: 0,
      provider: storageGet('opc_provider', 'deepseek'),
      endpoint: storageGet('opc_endpoint', 'https://api.deepseek.com'),
      model: storageGet('opc_model', 'deepseek-chat'),
      apiKey: storageGet('opc_api_key', DEFAULT_API_KEY || ''),
      remote: storageGet('opc_remote', 'false')
    };

    function setStatus(t) {
      var n = el('statusText');
      if (n) n.textContent = t;
    }

    function syncFormFromState() {
      if (el('providerSelect')) el('providerSelect').value = state.provider;
      if (el('endpointInput')) el('endpointInput').value = state.endpoint;
      if (el('modelInput')) el('modelInput').value = state.model;
      if (el('apiKeyInput')) el('apiKeyInput').value = state.apiKey;
      if (el('remoteSelect')) el('remoteSelect').value = state.remote;
    }

    function saveStateFromForm() {
      state.provider = el('providerSelect') ? el('providerSelect').value : state.provider;
      state.endpoint = el('endpointInput') ? el('endpointInput').value.trim() : state.endpoint;
      state.model = el('modelInput') ? el('modelInput').value.trim() : state.model;
      state.apiKey = el('apiKeyInput') ? el('apiKeyInput').value.trim() : state.apiKey;
      state.remote = el('remoteSelect') ? el('remoteSelect').value : state.remote;
      storageSet('opc_provider', state.provider);
      storageSet('opc_endpoint', state.endpoint);
      storageSet('opc_model', state.model);
      storageSet('opc_api_key', state.apiKey);
      storageSet('opc_remote', state.remote);
    }

    function renderResult(data, userText) {
      var score = Number(valueOr(deepGet(data, ['small_model', 'score'], 0), 0)).toFixed(2);
      var tier = valueOr(deepGet(data, ['small_model', 'tier'], '-'), '-');
      var smallBackend = valueOr(deepGet(data, ['small_model', 'backend'], 'heuristic'), 'heuristic');
      var experts = deepGet(data, ['selected_experts'], []);
      var fused = deepGet(data, ['fused_result'], {});
      var attribution = valueOr(data.output_attribution, {});
      var actions = valueOr(fused.fused_actions, []);
      var alerts = valueOr(fused.fused_alerts, []);
      var summary = valueOr(fused.fused_risk_summary, '已完成分析，请参考动作建议执行。');

      function sourceOf(key, fallback) {
        var item = attribution ? attribution[key] : null;
        return valueOr(item && item.source, fallback);
      }

      var cards = [
        {
          title: '复杂度分层',
          source: sourceOf('small_model', 'small-model-router'),
          brief: 'score=' + score + ' / tier=' + tier + ' / backend=' + smallBackend,
          detail: deepGet(data, ['small_model'], {})
        },
        {
          title: '选中专家',
          source: sourceOf('selected_experts', 'router-rule-engine'),
          brief: (experts || []).map(function (x) { return x.name; }).join('、') || '无',
          detail: experts || []
        },
        {
          title: '信息池命中',
          source: sourceOf('info_pool_hits', 'info-pool-retriever'),
          brief: String((data.info_pool_hits || []).length) + ' 条',
          detail: data.info_pool_hits || []
        },
        {
          title: '融合摘要',
          source: sourceOf('fused_result', 'rule-based-fuser'),
          brief: summary,
          detail: fused
        },
        {
          title: '候选排序',
          source: sourceOf('ranked_candidates', 'local-agent-simulator+pairrank'),
          brief: String((data.ranked_candidates || []).length) + ' 条',
          detail: data.ranked_candidates || []
        },
        {
          title: '远程摘要',
          source: sourceOf('remote_llm', data.remote_llm ? 'remote-llm' : 'not-invoked'),
          brief: data.remote_llm ? '已返回' : '未调用/无返回',
          detail: valueOr(data.remote_llm, 'None')
        }
      ];

      if (el('resultCards')) {
        var html = '';
        for (var c = 0; c < cards.length; c += 1) {
          var card = cards[c];
          html += '<details class="result-card">'
            + '<summary>'
            + '<div class="result-title-row">'
            + '<div class="result-title">' + esc(card.title) + '</div>'
            + '<span class="source-tag">' + esc(card.source) + '</span>'
            + '</div>'
            + '<div class="result-brief">' + esc(card.brief) + '</div>'
            + '</summary>'
            + '<div class="result-detail">' + esc(JSON.stringify(card.detail, null, 2)) + '</div>'
            + '</details>';
        }
        el('resultCards').innerHTML = html;
      }
      if (el('rawJson')) {
        el('rawJson').textContent = JSON.stringify(data, null, 2);
      }
      renderCollaborationGraph(valueOr(data.collaboration_plan, {}));
      if (el('chatMeta')) {
        el('chatMeta').innerHTML =
          '<span class="chip">tier: ' + esc(tier) + '</span>' +
          '<span class="chip">score: ' + esc(score) + '</span>' +
          '<span class="chip">small-model: ' + esc(smallBackend) + '</span>';
      }

      var actionLines = [];
      for (var i = 0; i < (actions || []).length; i += 1) {
        var a = actions[i] || {};
        actionLines.push((i + 1) + '. ' + valueOr(a.title, '未命名动作') + ' | owner=' + valueOr(a.owner, '-') + ' | eta=' + valueOr(a.eta, '-'));
      }
      for (var j = 0; j < (alerts || []).length; j += 1) {
        actionLines.push('预警: ' + alerts[j]);
      }
      if (el('chatActions')) {
        el('chatActions').textContent = actionLines.length ? actionLines.join('\\n') : '暂无动作';
      }

      var aiText = summary;
      if (actionLines.length) {
        aiText += '\\n\\n建议动作:\\n' + actionLines.join('\\n');
      }
      if (el('chatWindow')) {
        el('chatWindow').innerHTML =
          '<div class="chat-msg chat-user">你：' + esc(userText) + '</div>' +
          '<div class="chat-msg chat-ai">AI：' + esc(aiText) + '</div>';
      }
    }

    function renderError(errMsg, userText) {
      var msg = valueOr(errMsg, '请求失败');
      setStatus('运行失败: ' + msg);
      if (el('rawJson')) el('rawJson').textContent = 'ERROR: ' + msg;
      if (el('chatWindow')) {
        el('chatWindow').innerHTML =
          '<div class="chat-msg chat-user">你：' + esc(userText) + '</div>' +
          '<div class="chat-msg chat-ai">AI：请求失败：' + esc(msg) + '</div>';
      }
    }

    function renderNodes(names, nodes) {
      var html = '';
      for (var i = 0; i < names.length; i += 1) {
        var name = names[i];
        var role = '-';
        for (var j = 0; j < nodes.length; j += 1) {
          if (nodes[j] && nodes[j].name === name) {
            role = valueOr(nodes[j].role, '-');
            break;
          }
        }
        html += '<div class="collab-node">'
          + '<div class="collab-node-name">' + esc(name) + '</div>'
          + '<div class="collab-node-role">' + esc(role) + '</div>'
          + '</div>';
      }
      if (!html) {
        html = '<div class="collab-node"><div class="collab-node-name">暂无</div><div class="collab-node-role">-</div></div>';
      }
      return html;
    }

    function renderCollaborationGraph(plan) {
      var root = el('collabGraph');
      if (!root) return;

      var frontline = valueOr(plan.frontline, []);
      var execution = valueOr(plan.execution, []);
      var support = valueOr(plan.support, []);
      var nodes = valueOr(plan.nodes, []);
      var edges = valueOr(plan.edges, []);

      var edgeHtml = '';
      for (var i = 0; i < edges.length; i += 1) {
        var e = edges[i] || {};
        edgeHtml += '<div class="collab-edge">'
          + esc(valueOr(e.from, '?')) + ' → ' + esc(valueOr(e.to, '?'))
          + ' · ' + esc(valueOr(e.relation, 'coordination'))
          + '</div>';
      }
      if (!edgeHtml) edgeHtml = '<div class="collab-edge">暂无协作连线</div>';

      root.innerHTML = ''
        + '<div class="collab-lanes">'
        + '  <div class="collab-lane"><div class="collab-lane-title">前排分析</div>' + renderNodes(frontline, nodes) + '</div>'
        + '  <div class="collab-lane"><div class="collab-lane-title">执行落地</div>' + renderNodes(execution, nodes) + '</div>'
        + '  <div class="collab-lane"><div class="collab-lane-title">法务支撑</div>' + renderNodes(support, nodes) + '</div>'
        + '</div>'
        + '<div class="collab-edges">' + edgeHtml + '</div>';
    }

    function runPipeline() {
      state.runClicks += 1;
      setStatus('按钮已触发 #' + state.runClicks + '，准备请求...');

      var btn = el('runBtn');
      var userText = '';
      try {
        saveStateFromForm();
        userText = el('textInput') ? el('textInput').value.trim() : '';
        if (btn) btn.disabled = true;
        setStatus('运行中...');

        var payload = {
          text: userText,
          provider: state.provider,
          endpoint: state.endpoint,
          model: state.model,
          api_key: state.apiKey,
          remote: state.remote === 'true'
        };

        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/run', true);
        xhr.timeout = 45000;
        xhr.setRequestHeader('Content-Type', 'application/json');

        xhr.onload = function () {
          if (btn) btn.disabled = false;
          var parsed = null;
          try {
            parsed = JSON.parse(xhr.responseText || '{}');
          } catch (e) {
            parsed = null;
          }

          if (xhr.status >= 200 && xhr.status < 300 && parsed && !parsed.error) {
            renderResult(parsed, userText);
            setStatus('运行完成（HTTP ' + xhr.status + '）');
            return;
          }

          var err = parsed && parsed.error ? parsed.error : ('HTTP ' + xhr.status);
          renderError(err, userText);
        };

        xhr.ontimeout = function () {
          if (btn) btn.disabled = false;
          renderError('请求超时（45s）', userText);
        };

        xhr.onerror = function () {
          if (btn) btn.disabled = false;
          renderError('网络错误', userText);
        };

        xhr.send(JSON.stringify(payload));
      } catch (e) {
        if (btn) btn.disabled = false;
        renderError((e && e.message) || e, userText);
      }
    }

    function bind(id, eventName, handler) {
      var node = el(id);
      if (node) node.addEventListener(eventName, handler);
    }

    function onProviderChange() {
      var provider = el('providerSelect') ? el('providerSelect').value : 'deepseek';
      var endpoint = el('endpointInput');
      var model = el('modelInput');
      if (provider === 'deepseek') {
        if (endpoint && (!endpoint.value || endpoint.value.indexOf('10.7.88.150') >= 0)) endpoint.value = 'https://api.deepseek.com';
        if (model && (!model.value || model.value === 'test')) model.value = 'deepseek-chat';
      } else {
        if (endpoint && (!endpoint.value || endpoint.value.indexOf('deepseek') >= 0)) endpoint.value = 'http://10.7.88.150:8080';
        if (model && !model.value) model.value = 'test';
      }
      saveStateFromForm();
    }

    function init() {
      syncFormFromState();
      bind('runBtn', 'click', runPipeline);
      bind('providerSelect', 'change', onProviderChange);
      bind('endpointInput', 'change', saveStateFromForm);
      bind('modelInput', 'change', saveStateFromForm);
      bind('apiKeyInput', 'change', saveStateFromForm);
      bind('remoteSelect', 'change', saveStateFromForm);
      setStatus('就绪');
    }

    window.onerror = function (msg) {
      setStatus('前端异常');
      renderError(msg, el('textInput') ? el('textInput').value : '');
      return false;
    };

    init();
  </script>
  </body>
</html>"""
    return page.replace("__DEFAULT_API_KEY_JSON__", json.dumps(default_api_key or "", ensure_ascii=False))


class DashboardApp:
    def __init__(self, project_root: Path) -> None:
        DynamicRoutingPipeline = importlib.import_module("opc_router").DynamicRoutingPipeline
        extract_text = importlib.import_module("opc_router.service_client").extract_text
        self.DynamicRoutingPipeline = DynamicRoutingPipeline
        self.extract_text = extract_text
        self.project_root = project_root

    def run(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        provider = str(payload.get("provider") or os.getenv("LLM_PROVIDER") or "qianfan").strip().lower()
        endpoint = str(payload.get("endpoint") or payload.get("host") or "").strip()
        model = str(payload.get("model") or "").strip()
        api_key = payload.get("api_key") or payload.get("api-key") or None
        remote = bool(payload.get("remote", True))
        text = str(payload.get("text") or "").strip()

        if provider == "deepseek":
            service_host = os.getenv("QIANFAN_HOST") or "http://10.7.88.150:8080"
            service_base_url = endpoint or os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com"
            service_model = model or os.getenv("DEEPSEEK_MODEL") or "deepseek-chat"
        else:
            service_host = endpoint or os.getenv("QIANFAN_HOST") or "http://10.7.88.150:8080"
            service_base_url = None
            service_model = model or os.getenv("QIANFAN_MODEL") or "test"

        pipeline = self.DynamicRoutingPipeline(
            project_root=self.project_root,
            provider=provider,
            service_host=service_host,
            service_base_url=service_base_url,
            service_model=service_model,
            api_key=api_key,
        )
        result = pipeline.run(user_text=text, try_remote_llm=remote)
        return result


class Handler(BaseHTTPRequestHandler):
    server_version = "OPCDashboard/1.0"

    def _send(self, body: str, status: int = 200, content_type: str = "text/html; charset=utf-8") -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/" or parsed.path == "/index.html":
            self._send(build_dashboard_html(default_api_key=os.getenv("DEEPSEEK_API_KEY", "")))
            return
        if parsed.path == "/api/health":
            self._send(json.dumps({"ok": True}, ensure_ascii=False), content_type="application/json; charset=utf-8")
            return
        self._send("Not Found", status=404)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/run":
            self._send("Not Found", status=404)
            return

        length = int(self.headers.get("Content-Length", "0") or 0)
        payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}") if length else {}
        try:
            result = self.server.app.run(payload)  # type: ignore[attr-defined]
            self._send(json.dumps(result, ensure_ascii=False), content_type="application/json; charset=utf-8")
        except Exception as exc:  # pragma: no cover - local UI server
            self._send(json.dumps({"error": str(exc)}, ensure_ascii=False), status=500, content_type="application/json; charset=utf-8")

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return


def main() -> int:
    load_env_file(PROJECT_ROOT / ".env")

    parser = argparse.ArgumentParser(description="OPC structured result dashboard")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8501)
    args = parser.parse_args()

    app = DashboardApp(project_root=PROJECT_ROOT)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.app = app  # type: ignore[attr-defined]

    print(f"OPC dashboard running at http://{args.host}:{args.port}")
    print("Openclaw competition_router structured result dashboard ready.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
