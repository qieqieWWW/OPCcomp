# OpenClaw Runtime 阶段1实施计划

## 1. 目标与验收

阶段1目标：完成从“模块雏形”到“可编排协同运行”的架构闭环，使 `competition_router` 作为大脑可稳定驱动 `openclaw-runtime` 手脚执行。

验收标准：
- 支持五部门依赖调度执行。
- 支持结果聚合并生成统一回传结构。
- 支持执行监控和失败降级。
- 保持 legacy 路径可回滚。

## 2. 分阶段计划（9天）

## Day 1：基线冻结与分支准备
- 冻结基线：记录当前 TS 文件快照。
- 建分支：`feat/orchestrated-runtime-phase1`。
- 补充最小运行说明与 smoke 命令。

## Day 2-3：协同执行引擎
- 新增 `ExecutionOrchestrator`。
- 新增 `DependencyManager`（DAG 生成 + 拓扑执行）。
- 将 `AgentExecutor` 从二选一执行升级为“分层并发执行”。

里程碑 M1：可执行五部门 DAG，输出每部门状态。

## Day 4：智能技能路由
- 新增 `SkillRouter` 读取 `skills/*.yaml`。
- 为 `SkillInvoker` 增加 timeout/retry/circuit-breaker。
- 加入脑控字段（优先技能建议）。

## Day 5：上下文与状态机增强
- `ContextManager` 增加状态机与 trace 字段。
- 增加批量依赖读接口。
- 定义统一 task lifecycle。

里程碑 M2：上下文可追踪，依赖检查稳定。

## Day 6：五部门 Agent 集成收口
- 统一部门输出 schema。
- 统一 metadata（依赖、耗时、来源）。
- 补充失败 fallback 输出。

## Day 7：对接大脑融合
- 新增 `ResultAggregator` 与 `BlenderAdapter`。
- 将五部门输出转换为 `competition_router` 可消费结构。

里程碑 M3：打通“脑计划 -> 手执行 -> 脑融合”。

## Day 8-9：测试与文档
- 单测：依赖调度、状态机、聚合器。
- 集成测试：正常/超时/依赖失败场景。
- 压测：并发任务与外部 skill 波动。
- 完善文档与回滚手册。

里程碑 M4：测试通过并具备上线条件。

## 3. 里程碑验收标准

| 里程碑 | 验收项 |
|---|---|
| M1 | 五部门 DAG 可执行，依赖顺序正确 |
| M2 | 状态机可追踪，Redis/Mongo 一致性可恢复 |
| M3 | 聚合输出结构稳定，可被大脑消费 |
| M4 | 通过回归、压测、回滚演练 |

## 4. 资源需求

- 开发：1 名 Runtime 工程师 + 1 名 Router 工程师。
- 测试：1 名 QA（接口回归 + 压测）。
- 环境：Mongo、Redis、OpenClaw skills 服务、Airouting Python 环境。

## 5. 测试策略

## 5.1 单元测试
- DependencyManager：环检测、拓扑序。
- ContextManager：状态机推进、依赖检查。
- SkillInvoker：重试与超时分支。

## 5.2 集成测试
- 场景 A：全成功。
- 场景 B：legal 超时，系统降级继续。
- 场景 C：market 失败，sales 自动跳过并回传原因。

## 5.3 回滚测试
- 开启 orchestratedMode 后故障，10 分钟内切回 legacyMode。

## 6. 目标架构图

```mermaid
flowchart LR
  BRAIN[competition_router 大脑]
  PLAN[brainPlan + collaborationPlan]
  ORC[ExecutionOrchestrator]
  DEP[DependencyManager]
  EXE[AgentExecutor]
  AG[Department Agents]
  SK[SkillInvoker/SkillRouter]
  BB[ContextManager(Mongo+Redis)]
  AGG[ResultAggregator]
  BLEND[BlenderAdapter]
  OUT[executionBundle]

  BRAIN --> PLAN --> ORC
  ORC --> DEP --> EXE --> AG
  AG --> SK
  AG --> BB
  BB --> AGG --> BLEND --> OUT --> BRAIN
```
