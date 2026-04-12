#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

NPM_BIN="$(command -v npm || true)"
if [[ -f "$ROOT_DIR/opc-eval-runtime/package.json" ]]; then
  RUNTIME_DIR="$ROOT_DIR/opc-eval-runtime"
else
  RUNTIME_DIR="$ROOT_DIR"
fi

if [[ -d "$ROOT_DIR/competition_router" ]]; then
  ROUTER_ROOT="$ROOT_DIR"
else
  ROUTER_ROOT=""
fi

OPC_ROUTER_PORT="${OPC_ROUTER_PORT:-18081}"
RUNTIME_PORT="${RUNTIME_PORT:-30000}"
OPC_ROUTER_URL="${OPC_ROUTER_URL:-http://127.0.0.1:${OPC_ROUTER_PORT}/route}"
OPC_ROUTER_TIMEOUT_MS="${OPC_ROUTER_TIMEOUT_MS:-120000}"
RUNTIME_FORCE_RESTART="${RUNTIME_FORCE_RESTART:-1}"
USE_REAL_SMALL_MODEL="${USE_REAL_SMALL_MODEL:-true}"
QWEN3_BASE_PATH="${QWEN3_BASE_PATH:-models/Qwen3-1.7B}"
ROUTER_ADAPTER_PATH="${ROUTER_ADAPTER_PATH:-scripts/training/output/adapter/adapter_model}"
AIR_PY="${AIR_PY:-/opt/miniconda3/envs/Airouting/bin/python}"

OPC_PID=""
RUNTIME_PID=""
STARTED_OPC="0"
STARTED_RUNTIME="0"

is_listening() {
  local port="$1"
  lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

get_listening_pids() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

is_healthy() {
  local url="$1"
  curl -fsS --max-time 3 "$url" >/dev/null 2>&1
}

wait_for_health() {
  local url="$1"
  local retries="${2:-20}"
  local interval="${3:-1}"
  local i
  for ((i=1; i<=retries; i++)); do
    if is_healthy "$url"; then
      return 0
    fi
    sleep "$interval"
  done
  return 1
}

kill_listening_processes() {
  local port="$1"
  local pids
  pids="$(get_listening_pids "$port")"
  if [[ -z "$pids" ]]; then
    return 0
  fi
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    kill "$pid" 2>/dev/null || true
  done <<< "$pids"
}

run_runtime_execute() {
  if [[ -z "$NPM_BIN" ]]; then
    echo "未找到 npm，请先激活 Airouting 环境并确保 node/npm 可用。"
    return 1
  fi
  (
    cd "$RUNTIME_DIR"
    export OPC_ROUTER_URL="$OPC_ROUTER_URL"
    export OPC_ROUTER_TIMEOUT_MS="$OPC_ROUTER_TIMEOUT_MS"
    export RUNTIME_PORT="$RUNTIME_PORT"
    "$NPM_BIN" run runtime-execute
  ) &
}

cleanup() {
  echo ""
  echo "正在停止本地 AI 执行链..."
  [[ -n "$RUNTIME_PID" ]] && kill "$RUNTIME_PID" 2>/dev/null || true
  [[ -n "$OPC_PID" ]] && kill "$OPC_PID" 2>/dev/null || true

  # 关键：conda/bash 包裹进程被 kill 后，子进程可能仍存活。
  # 仅当本脚本本次拉起了对应服务时，按端口精准清理监听进程。
  if [[ "$STARTED_RUNTIME" == "1" ]]; then
    kill_listening_processes "$RUNTIME_PORT"
  fi
  if [[ "$STARTED_OPC" == "1" ]]; then
    kill_listening_processes "$OPC_ROUTER_PORT"
  fi
  echo "本地 AI 执行链已停止"
}

trap cleanup SIGINT SIGTERM

echo "========================================="
echo "启动服务器飞书联调（本地仅 AI 执行链）"
echo "========================================="

echo ""
echo "1) 启动 OPC Router (${OPC_ROUTER_PORT})..."
if [[ -z "$ROUTER_ROOT" ]]; then
  echo "   未找到 competition_router，无法启动 OPC Router"
  exit 1
elif is_listening "$OPC_ROUTER_PORT"; then
  if is_healthy "http://127.0.0.1:${OPC_ROUTER_PORT}/health"; then
    echo "   端口 ${OPC_ROUTER_PORT} 已被占用，复用现有 OPC Router"
  else
    echo "   端口 ${OPC_ROUTER_PORT} 已占用但健康检查失败，清理旧进程后重启 OPC Router"
    kill_listening_processes "$OPC_ROUTER_PORT"
    sleep 1
    bash -lc "cd '$ROUTER_ROOT' && USE_REAL_SMALL_MODEL='${USE_REAL_SMALL_MODEL}' QWEN3_BASE_PATH='${QWEN3_BASE_PATH}' ROUTER_ADAPTER_PATH='${ROUTER_ADAPTER_PATH}' PYTHONPATH=competition_router/src '$AIR_PY' competition_router/examples/opc_service.py --host 0.0.0.0 --port ${OPC_ROUTER_PORT}" &
    OPC_PID=$!
    STARTED_OPC="1"
    sleep 1
  fi
else
  bash -lc "cd '$ROUTER_ROOT' && USE_REAL_SMALL_MODEL='${USE_REAL_SMALL_MODEL}' QWEN3_BASE_PATH='${QWEN3_BASE_PATH}' ROUTER_ADAPTER_PATH='${ROUTER_ADAPTER_PATH}' PYTHONPATH=competition_router/src '$AIR_PY' competition_router/examples/opc_service.py --host 0.0.0.0 --port ${OPC_ROUTER_PORT}" &
  OPC_PID=$!
  STARTED_OPC="1"
  sleep 1
fi

echo ""
echo "2) 启动 Runtime Execute (${RUNTIME_PORT})..."
if is_listening "$RUNTIME_PORT"; then
  if is_healthy "http://127.0.0.1:${RUNTIME_PORT}/health" && [[ "$RUNTIME_FORCE_RESTART" != "1" ]]; then
    echo "   端口 ${RUNTIME_PORT} 已被占用，复用现有 Runtime Execute (RUNTIME_FORCE_RESTART=0)"
  else
    echo "   重启 Runtime Execute（确保使用最新代码与 OPC_ROUTER_TIMEOUT_MS=${OPC_ROUTER_TIMEOUT_MS}）"
    kill_listening_processes "$RUNTIME_PORT"
    sleep 1
    run_runtime_execute
    RUNTIME_PID=$!
    STARTED_RUNTIME="1"
    sleep 3
  fi
else
  run_runtime_execute
  RUNTIME_PID=$!
  STARTED_RUNTIME="1"
  sleep 3
fi

if ! wait_for_health "http://127.0.0.1:${OPC_ROUTER_PORT}/health" 30 1; then
  echo "   OPC Router 健康检查失败，请检查日志后重试"
  exit 1
fi

if ! wait_for_health "http://127.0.0.1:${RUNTIME_PORT}/health" 15 1; then
  echo "   Runtime Execute 健康检查失败，请检查日志后重试"
  exit 1
fi

echo ""
echo "========================================="
echo "本地执行链启动完成"
echo "OPC Router PID: ${OPC_PID:-existing}"
echo "Runtime Execute PID: ${RUNTIME_PID:-existing}"
echo ""
echo "本地验证:"
echo "  curl http://127.0.0.1:${OPC_ROUTER_PORT}/health"
echo "  curl http://127.0.0.1:${RUNTIME_PORT}/health"
echo "  curl -s http://127.0.0.1:${OPC_ROUTER_PORT}/health | cat"
echo ""
echo "服务器需配置: FEISHU_RUNTIME_EXECUTE_URL=<你的本地可访问 execute 地址>"
echo "当前本地 execute 地址: http://127.0.0.1:${RUNTIME_PORT}/execute"
echo "注意：本脚本不会启动 feishu-long，避免与服务器重复消费飞书消息。"
echo "按 Ctrl+C 停止本脚本拉起的本地进程"
echo "========================================="

wait
