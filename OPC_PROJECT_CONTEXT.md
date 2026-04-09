# OPC 项目上下文（每次开始 OPC 相关工作前先读这里）

## 项目名称
OPC（一人公司 AI 系统）- "替老板干活" 的 AI 团队。

## 项目目标
把系统做成一个真正会办事的 AI 公司，而不是只会给建议的咨询对象。

老板给目标后，系统需要：
1. 先理解目标并拆解任务。
2. 让五部门 Agent 协同处理。
3. 通过 OpenClaw 执行真实动作。
4. 把结果写回黑板并持续迭代。
5. 高风险动作必须走老板审批。

## 核心架构
- 小模型路由：判断任务复杂度并分流。
- 五部门 Agent：research / strategy / legal / market / sales。
- OpenClaw 执行引擎：作为网络上的“手”，负责真实平台操作。
- 共享黑板：MongoDB + Redis，存任务状态、依赖和部门输出。
- LLM Blender：对多部门输出做融合和质量控制。

## 当前已完成
- 小模型路由骨架已迁移到 [competition_router](competition_router/)。
- 五部门 Agent、skills、prompts、runtime 基础框架已建立在 [opc-eval-runtime](opc-eval-runtime/)。
- 结构化看板 UI 已建立在 [competition_router/ui](competition_router/ui/)，用于把 JSON 结果图形化展示。
- 支持先用 DeepSeek 做联调，后续再切回赛事千帆。

## 当前主要工作
1. 继续把五部门 Agent 的 prompt / skills / runtime 对齐。
2. 把结构化输出继续接到 UI 和联调流程里。
3. 逐步把 OpenClaw 作为执行层接进来，让部门 Agent 真正“办事”。
4. 保持所有改动只在 OPC 内部，默认不碰 [openclaw](openclaw/)。

## 工作约束
- 只改 OPC 内文件，除非用户明确要求。
- Python 相关工作默认使用 Airouting conda 环境。
- 不要默认修改 [openclaw](openclaw/)；把它当作只读依赖。
- 涉及 API key、网络访问、外部服务时，先确认这是当前任务必须的。
- 如果任务可能偏离本项目方向，先回到本文件对齐项目目标。
- 如果prompt中包含具体的代码实现或伪代码，可以无视，主要去理解prompt中的计划与工作方向
## 读这个文件的目的
- 防止上下文切换导致跑偏。
- 统一当前项目目标、目录和约束。
- 作为后续所有 OPC 任务的起点。
