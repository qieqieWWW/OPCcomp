# OPCcomp 下一步执行指南
## 基于当前状态 (2026-04-08 03:52)

## 📋 当前完成状态
- ✅ **本地修复完成**: research-agent.ts (10秒超时), market-agent.ts (15秒超时)
- ✅ **文件已复制**: 到 `/Users/qieqieqie/Documents/openclaw-runtime` 用于服务器
- ✅ **服务器git解决**: 你已强制推送到服务器
- ✅ **本地测试通过**: `fix_timeout_issue.sh` 验证超时机制有效

## 🎯 下一步选择

### 选项1: 在服务器上验证部署
如果你已经在**服务器上**，执行以下步骤：

```bash
# 1. 进入服务器项目目录
cd /path/to/server/opccomp

# 2. 检查超时修复是否已应用
grep -n "Promise.race" openclaw-runtime/department-agents/research-agent.ts
grep -n "Promise.race" openclaw-runtime/department-agents/market-agent.ts

# 3. 启动服务（如果未启动）
./start_services_simple.sh

# 4. 验证服务状态
./check_services.sh

# 5. 运行完整测试
./fix_timeout_issue.sh
```

### 选项2: 继续本地开发
如果你还在**本地环境**，执行：

```bash
# 1. 确保在正确目录
cd /Users/qieqieqie/Desktop/Start-up-Evaluation-and-AI-Routing/OPCcomp

# 2. 运行单步测试（避免信息过载）
./scripts/debug/test_single_step.sh
```

### 选项3: 创建新的自动化脚本
```bash
# 创建一个单步执行的脚本
cat > scripts/debug/test_single_step.sh << 'EOF'
#!/bin/bash
echo "=== 单步测试脚本 ==="
echo ""

echo "步骤1: 检查环境"
pwd
ls -la openclaw-runtime/department-agents/research-agent.ts

echo ""
read -p "按回车继续到下一步..." dummy

echo "步骤2: 验证超时修复"
grep -n "Promise.race" openclaw-runtime/department-agents/research-agent.ts

echo ""
read -p "按回车继续到下一步..." dummy

echo "步骤3: 启动单个服务测试"
# 只启动 OPC 路由服务测试
PYTHONPATH=competition_router/src python competition_router/examples/opc_service.py --host 0.0.0.0 --port 18080 &
OPC_PID=$!
sleep 2

echo "OPC服务PID: $OPC_PID"
curl -s http://localhost:18080/health && echo " ✓ OPC服务正常"

echo ""
read -p "按回车清理并退出..." dummy
kill $OPC_PID
echo "测试完成"
EOF

chmod +x scripts/debug/test_single_step.sh
./scripts/debug/test_single_step.sh
```

## 🔧 快速参考命令

### 检查服务状态
```bash
# 检查端口占用
lsof -i :18080
lsof -i :8080
lsof -i :30000

# 检查进程
ps aux | grep -E "(opc_service|skill-service|runtime-execute)"
```

### 启动服务（简单版）
```bash
# 启动OPC路由
cd competition_router
python examples/opc_service.py --host 0.0.0.0 --port 18080 &

# 启动Skill Service
cd openclaw-runtime
npm run skill-service &

# 启动Runtime Execute
npm run runtime-execute &
```

### 测试调用
```bash
# 简单测试调用
curl -X POST http://localhost:30000/execute \
  -H "Content-Type: application/json" \
  -d '{"input":"测试创业项目","openId":"test-user-001"}' \
  --max-time 30
```

## 🚨 故障排除

### 如果出现端口占用
```bash
# 查找占用进程
lsof -i :8080
# 杀死进程
kill -9 <PID>
```

### 如果服务启动失败
```bash
# 查看日志
tail -f logs/opc_service.log
tail -f openclaw-runtime/logs/skill_service.log
tail -f openclaw-runtime/logs/runtime_execute.log
```

## 📞 需要帮助？

告诉我你遇到了什么具体问题：
1. 服务器上服务启动失败？
2. 端口被占用？
3. 测试调用没有响应？
4. 还是其他问题？

**请告诉我你现在在哪个环境（本地/服务器）以及遇到了什么具体问题？**