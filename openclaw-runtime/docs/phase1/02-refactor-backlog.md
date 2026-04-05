# OpenClaw Runtime 阶段1改造点清单

## 1. 改造策略

采用“**融合化**”而非“重写”：

- 保留：`DepartmentAgentRuntime`、五部门 Agent、`ContextManager`、`SkillInvoker`。
- 新增薄层：`orchestrator`、`dependency-manager`、`result-aggregator`、`execution-monitor`。
- 修改少量关键点：执行器调度逻辑、上下文字段、错误策略。

## 2. 详细改造点（按模块）

## 2.1 执行引擎（高优先级）

### 现状
- 支持 `executeParallel` / `executeSequential`，无依赖图。

### 改造
- 新增 `ExecutionOrchestrator`：接收 `brainPlan` 和任务上下文。
- 新增 `DependencyManager`：根据部门依赖生成 DAG，按拓扑调度。
- 执行策略改为“分层并发”：同层并发，跨层串联。

### 影响范围
- `modified-runtime/execution/agent-executor.ts`（扩展/重构）
- 新增 `modified-runtime/orchestration/*`

## 2.2 技能调度（高优先级）

### 现状
- `SkillInvoker` 仅透传 HTTP 调用。

### 改造
- 接入部门技能白名单（从 `skills/*.yaml` 读取）。
- 增加 skill 级限流、超时、重试、熔断。
- 支持“脑控路由提示”：由 `brainPlan` 指定优先技能。

### 影响范围
- `modified-runtime/tools/skill-invoker.ts`
- 新增 `modified-runtime/tools/skill-router.ts`

## 2.3 上下文管理（高优先级）

### 现状
- 已有 Mongo+Redis 黑板，依赖检查基于状态键。

### 改造
- 统一状态机：`pending -> processing -> completed/failed -> compensated`。
- 增加 `traceId / correlationId / source` 字段。
- 增加批量读接口，减少 N 次依赖查询。

### 影响范围
- `modified-runtime/context/context-manager.ts`
- `department-agents/base-agent.ts`（上下文字段扩展）

## 2.4 错误处理（中优先级）

### 改造
- 错误分类：依赖未就绪、技能超时、外部 API、数据校验。
- 策略矩阵：重试/降级/跳过/中断。
- 增加失败后补偿回调。

### 影响范围
- `base-agent.ts` + 新增 `modified-runtime/error/*`

## 2.5 结果聚合（高优先级）

### 改造
- 新增 `ResultAggregator`：按部门输出构造融合输入。
- 新增 `BlenderAdapter`：对接 `competition_router` 的 fused 结构。
- 增加质量评分（完整性、一致性、可执行性）。

### 影响范围
- 新增 `modified-runtime/aggregation/*`

## 2.6 执行监控（中优先级）

### 改造
- 新增 `ExecutionMonitor`：任务级、部门级状态与耗时指标。
- 输出 Prometheus 风格指标或 JSON 事件流。

### 影响范围
- 新增 `modified-runtime/monitoring/*`

## 3. 依赖关系矩阵

| 模块 | 依赖模块 | 说明 |
|---|---|---|
| ExecutionOrchestrator | DependencyManager, AgentExecutor, ContextManager | 主调度入口 |
| DependencyManager | 部门依赖声明 | 生成执行顺序 |
| AgentExecutor | DepartmentAgentRuntime | 具体执行单元 |
| ResultAggregator | ContextManager, BlenderAdapter | 汇总输出并对接大脑融合 |
| ExecutionMonitor | Orchestrator, ContextManager | 监控状态与指标 |

## 4. 优先级排序

### P0（必须）
1. Orchestrator + DependencyManager。
2. ResultAggregator + BlenderAdapter。
3. ContextManager 状态机与 trace 字段。
4. SkillInvoker 超时重试熔断。

### P1（推荐）
1. ExecutionMonitor。
2. 错误分类与补偿。
3. 批量读写优化。

### P2（优化）
1. 智能缓存（skills 结果短期缓存）。
2. 调试工具与可视化面板。

## 5. “从头写 vs 融合化”决策

| 能力 | 决策 | 理由 |
|---|---|---|
| 五部门 Agent | 融合化 | 已有依赖关系与结构化输出 |
| 执行器 | 融合化重构 | 仅缺 DAG 与监控，不必推倒 |
| 上下文黑板 | 融合化增强 | Mongo+Redis 已具雏形 |
| 聚合器/监控器 | 从头新增 | 当前缺失，适合薄层新增 |
