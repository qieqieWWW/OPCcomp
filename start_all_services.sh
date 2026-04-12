#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"
NPM_BIN="$(command -v npm || true)"
# 当前仓库 runtime 脚本位于根目录 package.json，只有在子目录确实存在 package.json 时才切换。
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
OPC_ROUTER_URL="${OPC_ROUTER_URL:-http://127.0.0.1:${OPC_ROUTER_PORT}/route}"

run_node_service() {
	local npm_script="$1"
	if [[ -z "$NPM_BIN" ]]; then
		echo "未找到 npm，请先在 Airouting 环境安装 Node.js/npm。"
		return 1
	fi
	(
		cd "$RUNTIME_DIR"
		export OPC_ROUTER_URL="$OPC_ROUTER_URL"
		"$NPM_BIN" run "$npm_script"
	) &
}

OPC_PID=""
RUNTIME_PID=""
FEISHU_PID=""

is_listening() {
	local port="$1"
	lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

cleanup() {
	echo ""
	echo "正在停止所有服务..."
	[[ -n "$FEISHU_PID" ]] && kill "$FEISHU_PID" 2>/dev/null || true
	[[ -n "$RUNTIME_PID" ]] && kill "$RUNTIME_PID" 2>/dev/null || true
	[[ -n "$OPC_PID" ]] && kill "$OPC_PID" 2>/dev/null || true
	echo "所有服务已停止"
}

trap cleanup SIGINT SIGTERM

echo "========================================="
echo "启动 OPCcomp 本地全链路服务"
echo "========================================="

echo ""
echo "1) 启动 OPC Router (${OPC_ROUTER_PORT})..."
if [[ -z "$ROUTER_ROOT" ]]; then
	echo "   未找到 competition_router，跳过启动 OPC Router"
elif is_listening "$OPC_ROUTER_PORT"; then
	echo "   端口 ${OPC_ROUTER_PORT} 已被占用，跳过启动 OPC Router"
else
	conda run -n Airouting bash -lc "cd '$ROUTER_ROOT' && PYTHONPATH=competition_router/src python competition_router/examples/opc_service.py --host 0.0.0.0 --port ${OPC_ROUTER_PORT}" &
	OPC_PID=$!
	sleep 3
fi

echo ""
echo "2) 启动 Runtime Execute (30000)..."
if is_listening 30000; then
	echo "   端口 30000 已被占用，跳过启动 Runtime Execute"
else
	run_node_service "runtime-execute"
	RUNTIME_PID=$!
	sleep 3
fi

echo ""
echo "3) 启动 Feishu Longlink..."
run_node_service "feishu-long"
FEISHU_PID=$!

echo ""
echo "========================================="
echo "已发起全链路启动"
echo "OPC Router PID: $OPC_PID"
echo "Runtime Execute PID: $RUNTIME_PID"
echo "Feishu Longlink PID: $FEISHU_PID"
echo ""
echo "验证端口: lsof -iTCP:${OPC_ROUTER_PORT} -sTCP:LISTEN"
echo "验证端口: lsof -iTCP:30000 -sTCP:LISTEN"
echo "运行时 OPC 地址: ${OPC_ROUTER_URL}"
echo "按 Ctrl+C 停止本脚本拉起的所有服务"
echo "========================================="

wait
