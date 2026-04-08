# OPCcomp 框架部署指南

## 需要上传到服务器的改动

### 关键修复文件
以下文件包含了解决超时问题的关键修复，需要上传到服务器：

1. **超时修复**：
   - `openclaw-runtime/department-agents/research-agent.ts` - 添加10秒超时机制
   - `openclaw-runtime/department-agents/market-agent.ts` - 添加15秒超时机制
   
2. **调试日志**：
   - `openclaw-runtime/modified-runtime/runtime.ts`
   - `openclaw-runtime/modified-runtime/integrations/runtime-execute-server.ts`
   - `openclaw-runtime/modified-runtime/orchestration/execution-orchestrator.ts`

3. **配置更新**：
   - `openclaw-runtime/.env` - 环境变量配置
   - `openclaw-runtime/.env.example` - 环境变量示例

### 修复内容说明
1. **research-agent.ts**: 在调用skill-service的百度搜索时添加10秒超时
2. **market-agent.ts**: 在调用skill-service的视频生成时添加15秒超时
3. **runtime.ts**: 添加执行流程的详细日志
4. **runtime-execute-server.ts**: 添加OPC路由调用的详细日志

## 启动整个框架

### 服务架构
1. **OPC路由服务** (端口: 18080) - 小模型路由
2. **Skill Service** (端口: 8080) - 浏览器自动化服务
3. **Runtime Execute服务** (端口: 30000) - 多Agent执行引擎
4. **飞书长连接服务** - 飞书WebSocket连接

### 启动方式一：使用一键启动脚本
```bash
# 给脚本添加执行权限
chmod +x start_all_services.sh

# 启动所有服务
./start_all_services.sh
```

### 启动方式二：手动分终端启动
在4个不同的终端中分别执行：

**终端1 - OPC路由服务**:
```bash
cd /path/to/OPCcomp
PYTHONPATH=competition_router/src python competition_router/examples/opc_service.py --host 0.0.0.0 --port 18080
```

**终端2 - Skill Service**:
```bash
cd /path/to/OPCcomp/openclaw-runtime
npm run skill-service
```

**终端3 - Runtime Execute服务**:
```bash
cd /path/to/OPCcomp/openclaw-runtime
npm run runtime-execute
```

**终端4 - 飞书长连接服务**:
```bash
cd /path/to/OPCcomp/openclaw-runtime
npm run feishu-long
```

### 启动方式三：使用简化脚本
```bash
./start_services_simple.sh
```
这个脚本会显示每个服务的启动命令，你可以复制到不同的终端中执行。

## 环境变量配置

确保 `openclaw-runtime/.env` 文件包含以下配置：

```bash
# 飞书应用凭证
FEISHU_APP_ID=cli_a9587a4c10f8dcc7
FEISHU_APP_SECRET=t01L6rqtn8wQy32e4eDhZb8lYpZmCjmH

# runtime-execute 地址
FEISHU_RUNTIME_EXECUTE_URL=http://127.0.0.1:30000/execute
FEISHU_RUNTIME_TIMEOUT_MS=120000

# OPC 路由配置
OPC_ROUTER_URL=http://127.0.0.1:18080/route
OPC_ROUTER_TIMEOUT_MS=60000
OPC_ROUTER_TRY_REMOTE_LLM=false

# Skill Service 配置
OPENCLAW_SKILL_SERVICE_URL=http://127.0.0.1:8080
SKILL_SERVICE_MOCK_MODE=false
```

## 服务状态检查

```bash
# 检查所有服务状态
./check_services.sh

# 测试整个链路
curl -X POST http://localhost:30000/execute \
  -H "Content-Type: application/json" \
  -d '{"input": "测试创业项目评估", "openId": "test-user"}'
```

## 通过FRP隧道测试

如果配置了FRP隧道，可以通过以下地址测试：

```bash
curl -X POST https://frp-try.com:20203/execute \
  -H "Content-Type: application/json" \
  -d '{"input": "测试创业项目评估", "openId": "test-user"}'
```

## 故障排除

### 1. 服务启动失败
- 检查端口是否被占用：`lsof -i :18080`、`lsof -i :8080`、`lsof -i :30000`
- 检查Node.js和Python依赖是否安装：`node --version`、`python3 --version`

### 2. 超时问题
如果遇到超时，检查：
- skill-service是否正常运行
- 浏览器自动化是否正常工作
- 网络连接是否正常

### 3. OPC路由失败
检查OPC服务日志：
```bash
# 查看OPC服务日志
tail -f /path/to/logs/opc_service.log
```

### 4. 飞书连接失败
检查飞书应用配置：
- 应用ID和密钥是否正确
- 飞书开放平台配置是否正确
- 网络是否能访问飞书服务器

## PM2部署（生产环境）

如果需要使用PM2进行进程管理，可以使用以下配置：

```bash
# 安装PM2
npm install -g pm2

# 使用现有配置文件启动
cd /path/to/OPCcomp/openclaw-runtime
pm2 start ecosystem-feishu-long.config.js

# 查看进程状态
pm2 status
```

## 更新日志

### 2026-04-08 修复内容
1. **解决skill-service超时问题**：在research-agent和market-agent中添加Promise.race超时机制
2. **添加详细调试日志**：在关键执行路径添加console.log，便于问题排查
3. **修复语法错误**：修复runtime.ts中的`taskPlan.departments?.map(d => d.name).join(',')`错误
4. **优化错误处理**：market-agent在视频生成失败时降级处理，不阻断整个流程

### 2026-04-07 修复内容
1. **解决依赖循环问题**：DependencyManager检测到循环后自动降级为线性依赖
2. **解决market技能URL缺失问题**：缺少URL时降级为mock回执
3. **解决飞书消息重复问题**：去重窗口从2min扩大为5min
4. **解决.env加载路径问题**：支持多路径查找环境变量