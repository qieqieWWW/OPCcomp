# 🚀 服务器部署专门步骤
## 当前任务：将超时修复部署到服务器

## 📋 当前完成状态
1. ✅ **本地修复完成** - research-agent.ts (10秒超时), market-agent.ts (15秒超时)
2. ✅ **文件已复制** - 到 `/Users/qieqieqie/Documents/openclaw-runtime`
3. ✅ **服务器git推送** - 你已强制推送到服务器仓库
4. ✅ **本地测试通过** - 验证超时机制有效

## 🎯 服务器端需要执行的操作

### 步骤 1: 登录服务器并检查
```bash
# 1. SSH 登录服务器
ssh user@your-server-ip

# 2. 进入项目目录
cd /path/to/opccomp-on-server

# 3. 拉取最新代码（如果已推送）
git pull origin main
# 注意：如果之前有冲突，可能需要强制拉取
git fetch origin
git reset --hard origin/main
```

### 步骤 2: 验证服务器上的修复文件
```bash
# 1. 检查超时修复是否已更新
grep -n "Promise.race" openclaw-runtime/department-agents/research-agent.ts
grep -n "10000" openclaw-runtime/department-agents/research-agent.ts

grep -n "Promise.race" openclaw-runtime/department-agents/market-agent.ts
grep -n "15000" openclaw-runtime/department-agents/market-agent.ts

# 2. 检查文件修改时间
ls -la openclaw-runtime/department-agents/*.ts
```

### 步骤 3: 停止现有服务
```bash
# 1. 查找并停止所有相关服务
pkill -f 'opc_service.py'    # OPC路由服务
pkill -f 'skill-service'     # Skill服务
pkill -f 'runtime-execute'   # Runtime执行服务

# 2. 确认进程已停止
ps aux | grep -E "(opc_service|skill-service|runtime-execute)"

# 3. 检查端口是否释放
netstat -tlnp | grep -E "(18080|8080|30000)"
# 或者使用 lsof
lsof -i :18080
lsof -i :8080
lsof -i :30000
```

### 步骤 4: 启动更新后的服务
```bash
# 1. 启动 OPC 路由服务
cd competition_router
mkdir -p ../logs ../openclaw-runtime/logs
python examples/opc_service.py --host 0.0.0.0 --port 18080 > ../logs/opc_service.log 2>&1 &

# 2. 启动 Skill Service
cd ../openclaw-runtime
npm run skill-service > logs/skill_service.log 2>&1 &

# 3. 启动 Runtime Execute 服务
npm run runtime-execute > logs/runtime_execute.log 2>&1 &

# 4. 返回项目根目录
cd ..
```

### 步骤 5: 验证服务状态
```bash
# 1. 等待服务启动
sleep 5

# 2. 检查进程
ps aux | grep -E "(opc_service|skill-service|runtime-execute)" | grep -v grep

# 3. 测试服务连通性
echo "测试 OPC 服务..."
curl -s http://localhost:18080/health && echo " ✅ OPC服务正常"

echo "测试 Skill Service..."
curl -s http://localhost:8080 && echo " ✅ Skill服务正常"

echo "测试 Runtime Execute..."
curl -s http://localhost:30000/health && echo " ✅ Runtime服务正常" || echo " ⚠️ Runtime服务可能无/health端点"
```

### 步骤 6: 测试超时修复
```bash
# 执行一个测试调用，验证超时机制
curl -X POST http://localhost:30000/execute \
  -H "Content-Type: application/json" \
  -d '{"input":"测试服务器部署后的超时机制","openId":"server-test-001"}' \
  --max-time 30

echo ""
echo "如果这个调用在30秒内完成（而不是卡死），说明超时机制生效"
```

## 🔧 快速部署脚本

我已经为你创建了专门的服务器部署脚本，可以直接使用：

### 选项 A: 使用完整部署脚本
```bash
# 在服务器上运行
./deploy_to_server.sh --check    # 只检查环境
./deploy_to_server.sh --deploy   # 执行完整部署
```

### 选项 B: 使用极简脚本
```bash
# 在服务器上运行
./simple_deploy.sh
```

### 选项 C: 手动执行（推荐第一次）
```bash
# 复制这个脚本到服务器执行
cat > server_deploy.sh << 'EOF'
#!/bin/bash
echo "=== 服务器部署脚本 ==="
echo "1. 停止服务..."
pkill -f 'opc_service.py'
pkill -f 'skill-service'
pkill -f 'runtime-execute'
sleep 2

echo "2. 启动服务..."
cd competition_router
python examples/opc_service.py --host 0.0.0.0 --port 18080 &
cd ../openclaw-runtime
npm run skill-service &
npm run runtime-execute &
cd ..

echo "3. 等待启动..."
sleep 5

echo "4. 验证服务..."
curl -s http://localhost:18080/health && echo "✅ OPC服务正常"
curl -s http://localhost:8080 && echo "✅ Skill服务正常"

echo "=== 部署完成 ==="
EOF

chmod +x server_deploy.sh
./server_deploy.sh
```

## 🚨 故障排除

### 如果 git pull 有冲突
```bash
# 强制使用远程代码
git fetch origin
git reset --hard origin/main
# 注意：这会丢失本地未提交的修改
```

### 如果端口被占用
```bash
# 查找占用进程
lsof -i :18080
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

## 📞 下一步操作

**请告诉我：**

1. **你现在在哪个环境？**
   - 本地开发机
   - 服务器上

2. **服务器上已经执行了哪些步骤？**
   - git pull 是否成功？
   - 服务是否已经停止？

3. **遇到了什么具体问题？**

**我会根据你的回答提供具体的下一步指令！**