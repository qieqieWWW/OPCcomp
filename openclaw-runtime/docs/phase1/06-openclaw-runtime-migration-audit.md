# OpenClaw Runtime 魔改检查报告

## 基本信息
- 检查时间：2026-04-03
- 项目路径：/Users/qieqieqie/Desktop/Start-up-Evaluation-and-AI-Routing/OPCcomp/openclaw-runtime
- OpenClaw参考路径：/Users/qieqieqie/Desktop/Start-up-Evaluation-and-AI-Routing/OPCcomp/openclaw
- 检查方法：基于当前仓库真实结构做差异审计（不是按外部模板硬对齐）

## 重要前提说明
本地参考仓库 openclaw 与模板中描述的 packages/runtime/src 结构不一致，无法进行 1:1 路径级对照。
因此本报告采用“目标能力对照法”：检查当前 openclaw-runtime 是否已具备五部门协同架构关键能力。

## 映射结论
当前阶段不应继续按“原始 OpenClaw 路径”硬对齐，而应按 `competition_router -> openclaw-runtime` 的能力映射推进：

- `competition_router` 负责：分层、协作计划、信息池召回、候选排序、结果融合、来源标注。
- `openclaw-runtime` 负责：五部门执行、依赖调度、黑板沉淀、技能调用、结果回传。
- 两者之间通过轻量适配层连接，而不是直接复制模块。

推荐接入顺序：
1. 先接 `tier / selected_experts / collaboration_plan` 到执行编排。
2. 再接 `fused_result` 到结果聚合。
3. 再接 `output_attribution / runtime_trace` 到执行监控。
4. 最后把 `info_pool_hits` 与技能路由接入黑板和技能层。

## 检查结果汇总

### ✅ 已完成项
- [x] 五部门Agent基础框架存在
- [x] 部门依赖关系声明存在
- [x] 基础并行/串行执行器存在
- [x] 上下文黑板接口（Mongo+Redis）存在
- [x] 部门技能配置文件存在（yaml）
- [x] BrainPlanAdapter 已落地（大脑输出到 TaskPlan 的协议转换）
- [x] DependencyManager 已落地（DAG 拓扑执行顺序）
- [x] ExecutionOrchestrator 已落地（统一执行编排入口）
- [x] ExecutionMonitor 已落地（任务/部门级执行事件采集）
- [x] OpenClawRuntime 已落地（统一 `runtime.execute(brainOutput)` facade）
- [x] ResultAggregator 已落地（部门输出结构化聚合）
- [x] 监控 trace 已增强（任务级事件流可导出）

### ⚠️ 部分完成项
- [ ] 协同执行恢复策略
  - 现状：统一启动入口已完成，但失败重试、降级与补偿策略仍未实现
  - 建议：补重试、幂等、降级和补偿链路

- [ ] 智能技能路由器
  - 现状：已有 SkillInvoker 调用能力，但缺部门级策略路由、重试熔断、调用监控
  - 建议：新增 SkillRouter 并增强 SkillInvoker 容错

- [ ] 增强上下文管理
  - 现状：ContextManager 已接 Mongo+Redis，并有依赖检查
  - 缺口：状态机、trace 字段、批量读写与一致性修复
  - 建议：补齐状态机与幂等策略

### ❌ 未完成项
- [ ] LLM-Blender 目录与执行链路集成
  - 缺失原因：当前目录未发现 blender 模块与聚合入口文件
  - 优先级：高
  - 预计完成时间：2-3天

- [ ] 共享黑板独立模块（blackboard-client/server）
  - 缺失原因：黑板能力内嵌于 ContextManager，未独立抽象为专用模块
  - 优先级：中
  - 预计完成时间：1-2天

- [ ] Runtime工程化配置本地化（openclaw-runtime 子目录）
  - 缺失原因：tests 目录仍未建立，工程化测试链路还未补齐
  - 优先级：中
  - 预计完成时间：1天

## 详细检查结果

## 0. 映射实施进展（增量）

已新增：
- `modified-runtime/orchestration/types.ts`
- `modified-runtime/orchestration/brain-plan-adapter.ts`
- `modified-runtime/orchestration/dependency-manager.ts`
- `modified-runtime/orchestration/execution-orchestrator.ts`
- `modified-runtime/monitoring/execution-monitor.ts`
- `modified-runtime/orchestration/result-aggregator.ts`
- `modified-runtime/runtime.ts`

能力变化：
- 大脑输出（tier/selected_experts/collaboration_plan）已可转换为 runtime 执行计划（TaskPlan）。
- 已支持按依赖图生成分批执行顺序。
- 已支持统一记录任务与部门执行事件。
- 已支持 `runtime.execute(brainOutput)` 一步执行。
- 已支持把五部门输出聚合为结构化最终结果。

## 1. 目录结构对比

### 当前 openclaw-runtime 结构（关键）
- department-agents/
  - base-agent.ts
  - research-agent.ts
  - strategy-agent.ts
  - legal-agent.ts
  - market-agent.ts
  - sales-agent.ts
- modified-runtime/
  - execution/agent-executor.ts
  - context/context-manager.ts
  - tools/skill-invoker.ts
- skills/
  - research-skills.yaml
  - strategy-skills.yaml
  - legal-skills.yaml
  - market-skills.yaml
  - sales-skills.yaml
- prompts/
- types/（当前为空）

### 参考 openclaw 结构说明
- 当前 openclaw 仓库未出现模板所述 packages/runtime/src 树形结构
- 说明模板假设与本地 reference 存在版本/分支差异

## 2. 核心文件检查

- 执行器：modified-runtime/execution/agent-executor.ts
  - 已有 executeParallel 与 executeSequential
  - 已有基础状态记录
  - 无依赖图调度器

- 上下文管理：modified-runtime/context/context-manager.ts
  - 已有 Mongo tasks + department_outputs 存储
  - 已有 Redis 状态写入与依赖检查
  - 无统一状态机与补偿机制

- 技能调用：modified-runtime/tools/skill-invoker.ts
  - 已有批量调用与技能列表获取
  - 无重试/超时/熔断

## 3. 五部门Agent检查

- 部门Agent文件齐全
- 全部继承自 DepartmentAgentRuntime
- 依赖关系完整：
  - research: 无依赖
  - strategy: 依赖 research
  - legal: 依赖 research
  - market: 依赖 strategy + legal
  - sales: 依赖 market
- 具备跨部门输出读取能力（通过 base-agent assembleContext 实现）

## 4. 技能包检查

- 已有部门技能配置 yaml（5个）
- 未发现按目录拆分的部门技能包实现（如 research-skills/pdf-parser 等）
- 结论：配置层已建立，执行层仍偏轻量

## 5. 集成点检查

- LLM-Blender：未发现 blender.ts / scorer.ts / aggregator.ts，二次融合仍待接入
- 黑板独立模块：未发现 blackboard-client.ts / blackboard-server.ts，仍内嵌在 ContextManager / runtime facade
- 结论：聚合与总控层仍需补齐

## 6. 依赖与测试检查

- 已存在 package.json 与 tsconfig.json
- 未在 openclaw-runtime 子目录发现 tests 目录

## 问题清单

| 问题ID | 问题描述 | 严重程度 | 建议解决方案 |
|--------|----------|----------|--------------|
| 1 | 统一入口已完成，但缺少失败重试/降级/补偿策略 | 中 | 补充 runtime facade 的恢复链路 |
| 2 | DependencyManager 已实现，状态机仍未统一 | 中 | 补充 ContextManager 状态机定义与恢复策略 |
| 3 | 缺 Blender 二次融合对接 | 高 | 新增 BlenderAdapter 并接入 result-aggregator 输出 |
| 4 | SkillInvoker 容错不足 | 中 | 加入超时、重试、熔断、幂等键 |
| 5 | 子目录测试链路缺失 | 中 | 补 tests 目录、单测与集成测试 |

## 总体评估
- 完成度：80%
- 质量评分：8.1/10
- 风险等级：中高

## 下一步建议
1. 接入 `ResultAggregator` 后的 Blender 二次融合层。
2. 给 runtime facade 补重试、降级和补偿策略。
3. 将 blackboard 和 skill 路由拆成可独立部署模块。
