#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"
NPM_BIN="$(command -v npm || true)"

run_node_service() {
	local npm_script="$1"
	if [[ -n "$NPM_BIN" ]]; then
		bash -lc "cd '$ROOT_DIR/openclaw-runtime' && '$NPM_BIN' run $npm_script" &
	else
		conda run -n Airouting npm --prefix "$ROOT_DIR/openclaw-runtime" run "$npm_script" &
	fi
}

OPC_PID=""
SKILL_PID=""
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
	[[ -n "$SKILL_PID" ]] && kill "$SKILL_PID" 2>/dev/null || true
	[[ -n "$OPC_PID" ]] && kill "$OPC_PID" 2>/dev/null || true
	echo "所有服务已停止"
}

trap cleanup SIGINT SIGTERM

echo "========================================="
echo "启动 OPCcomp 本地全链路服务"
echo "========================================="

echo ""
echo "1) 启动 OPC Router (18080)..."
if is_listening 18080; then
	echo "   端口 18080 已被占用，跳过启动 OPC Router"
else
	conda run -n Airouting bash -lc "cd '$ROOT_DIR' && PYTHONPATH=competition_router/src python competition_router/examples/opc_service.py --host 0.0.0.0 --port 18080" &
	OPC_PID=$!
	sleep 3
fi

echo ""
echo "2) 启动 Skill Service (8080)..."
if is_listening 8080; then
	echo "   端口 8080 已被占用，跳过启动 Skill Service"
else
	run_node_service "skill-service"
	SKILL_PID=$!
	sleep 3
fi

echo ""
echo "3) 启动 Runtime Execute (30000)..."
if is_listening 30000; then
	echo "   端口 30000 已被占用，跳过启动 Runtime Execute"
else
	run_node_service "runtime-execute"
	RUNTIME_PID=$!
	sleep 3
fi

echo ""
echo "4) 启动 Feishu Longlink..."
run_node_service "feishu-long"
FEISHU_PID=$!

echo ""
echo "========================================="
echo "已发起全链路启动"
echo "OPC Router PID: $OPC_PID"
echo "Skill Service PID: $SKILL_PID"
echo "Runtime Execute PID: $RUNTIME_PID"
echo "Feishu Longlink PID: $FEISHU_PID"
echo ""
echo "验证端口: lsof -iTCP:18080 -sTCP:LISTEN"
echo "验证端口: lsof -iTCP:8080 -sTCP:LISTEN"
echo "验证端口: lsof -iTCP:30000 -sTCP:LISTEN"
echo "按 Ctrl+C 停止本脚本拉起的所有服务"
echo "========================================="

wait
