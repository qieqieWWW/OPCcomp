# OPCcomp 技术资产全景清单

> 为产品报告/PPT 准备，从启动脚本 `start_server_feishu_debug.sh` 出发，逐层梳理所有原创技术方案。

---

## 一、系统架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                      用户（飞书消息）                         │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  飞书长连接网关 (startup-longlink.ts) :9090                    │
│  - 消息去重 + 并发竞态防护                                     │
│  - tenant_access_token 自动刷新                               │
└──────────────────────────┬──────────────────────────────────┘
                           │ POST /execute
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Runtime Execute Server (runtime-execute-server.ts) :30000    │
│  - 接收指令 → 调用 Python OPC Router                          │
│  - 接收路由结果 → 调用 TypeScript 多Agent执行引擎               │
│  - 融合聚合 → 生成证据锚点报告 → 返回飞书                       │
└──────────────────────────┬──────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
┌─────────────────────┐     ┌─────────────────────────────────┐
│  Python 层          │     │  TypeScript 层                 │
│  OPC Router :18081  │     │  OpenClawRuntime                │
│                     │     │  ├─ 4部门 Agent 协作              │
│  ┌───────────────┐  │     │  ├─ PairRank 融合               │
│  │ 意图识别      │  │     │  ├─ 质量评分体系                │
│  │ (小模型+LoRA) │  │     │  └─ 证据绑定输出                │
│  ├───────────────┤  │     └─────────────────────────────────┘
│  │ 专家路由      │  │
│  │ (Tier分级)   │  │
│  ├───────────────┤  │
│  │ 信息池检索    │  │
│  │ (Bigram向量) │  │
│  ├───────────────┤  │
│  │ LLM推理       │  │
│  │ (千帆4-Agent) │  │
│  ├───────────────┤  │
│  │ PairRank融合  │  │
│  └───────────────┘  │
└─────────────────────┘
```

**核心设计哲学**：Python 负责"想"（路由+推理+知识），TypeScript 负责"做"（多Agent协作执行+融合+展示）。

---

## 二、原创技术方案详解

### 2.1 🧠 意图识别与复杂度分级（M7 - 小模型路由）

| 项目 | 内容 |
|------|------|
| **文件** | `competition_router/src/opc_router/small_model.py` + `scripts/classifier/` |
| **核心类** | `SmallModelRouter`, `ComplexityClassifier` |
| **技术方案** | **Qwen3-1.7B 本地小模型 + LoRA 微调适配器** |
| **工作原理** | 加载本地 Qwen3-1.7B，叠加自定义 LoRA 适配器（`scripts/training/output/adapter/adapter_model`），对用户输入进行复杂度评分 → 输出 L1/L2/L3 三级分级 |
| **L1/L2/L3 含义** | L1=简单任务(快速通道)，L2=标准分析(全流程)，L3=复杂项目(深度评估) |
| **创新点** | 用 1.7B 参数量本地部署小模型替代传统关键词分类，实现零样本零成本意图理解；LoRA 适配器让通用 Qwen3 变成领域专家 |

---

### 2.2 🔀 专家路由系统（M8 - Tier 分级调度）

| 项目 | 内容 |
|------|------|
| **文件** | `competition_router/src/opc_router/router.py` |
| **核心函数** | `route_experts_by_tier()`, `_forced_agents_from_text()`, `_need_legal_agent()` |
| **技术方案** | **基于复杂度分级的专家选择 + 关键词强制拉入** |
| **4个专家Agent** | ① `evidence_agent` 证据与对标部（前线）② `feasibility_agent` 可行性评估部（前线）③ `risk_agent` 风险评估部（执行）④ `legal_agent` 法律合规部（支持） |
| **路由规则** | - L1/L2/L3 均启动 evidence + feasibility 作为前线<br>- risk_agent 在 execution 阶段加入<br>- legal_agent 作为 support，当输入包含法律关键词时被**强制拉入**<br>- 用户显式提及部门名称时通过别名映射强制激活 |
| **法律关键词白名单** | "合规"、"法规"、"监管"、"资质"、"许可"、"跨境"、legal/compliance/regulatory/license/cross-border |
| **创新点** | 三层路由策略：Tier基础规则 → 文本关键词强制覆盖 → 法律专项检测；避免纯LLM路由的不确定性 |

---

### 2.3 🔍 信息池检索引擎

| 项目 | 内容 |
|------|------|
| **文件** | `competition_router/src/opc_router/info_pool.py` |
| **核心函数** | `retrieve_from_info_pool()`, `_ngrams()`, `_vec()`, `_cos()` |
| **技术方案** | **轻量级 Bigram 向量 + 余弦相似度** 无需嵌入模型 |
| **工作原理** | 将查询文本和池中记录都转为 bigram（二元语法）向量 → 计算余弦相似度 → 返回 Top-K 匹配记录 |
| **信息池内容** | 4条行业知识规则：现金流安全边际基准、B2B SaaS留存优先策略、跨境业务政策波动应对、里程碑化执行管理 |
| **字段匹配** | 标题(title) + 行业(industry) + 关键词(keywords) + 指导原则(guideline) 四维拼接后计算相似度 |
| **创新点** | 零依赖的向量检索——不需要 numpy 以外的任何库，bigram在短文本场景下比tf-idf更稀疏区分度更高；为每个路由请求提供"隐性知识"上下文增强 |

---

### 2.4 🤖 LLM 推理层（千帆多Agent调用）

| 项目 | 内容 |
|------|------|
| **文件** | `competition_router/src/opc_router/service_client.py`, `pipeline.py` |
| **核心类** | `QianfanAgentClient`, `AISV2Client` |
| **技术方案** | **百度千帆平台多Agent对话 API** |
| **已发布4个Agent** | ① `feasibility-agent`(可行性) ② `evidence-agent`(证据收集) ③ `legal-agent`(法律合规-自主规划) ④ `risk-agent`(风险评估) |
| **会话管理** | 自动管理 conversation_id（7天有效期），同一会话内上下文连续 |
| **调用模式** | 工作流Agent（开始→大模型→结束）：pipeline 构建 system_prompt + user message 发给对应 agent 的 app_id |
| **legal-agent 特殊处理** | 使用自主规划模式（角色指令+Prompt），非固定工作流 |
| **创新点** | 每个Agent有独立app_id和system prompt，通过千帆平台的Agent能力实现"一模型多角色"；conversation复用让多轮修正成为可能 |

---

### 2.5 📊 PairRank 融合算法

| 项目 | 内容 |
|------|------|
| **文件** | `competition_router/src/opc_router/blender.py` |
| **核心函数** | `pairrank()`, `_quality()`, `normalize_agent_outputs()` |
| **技术方案** | **两两对比排序（Pairwise Comparison）+ 质量加权混合** |
| **评分公式** | `final_score = 0.55 × base_quality + 0.45 × pairwise_wins_ratio` |
| **质量因子(base_quality)** | 有摘要(+0.25) + 有行动项(+0.08×数量) + 有告警(+0.05×数量)，基础分0.2，上限1.0 |
| **两两对比(wins)** | 对所有候选进行 O(n²) 两两比较，base_quality高者得1 win，最终 wins/(n-1) 作为相对胜率 |
| **输出规范化** | `normalize_agent_outputs()` 将各Agent原始输出统一为 `{expert, parsed: {risk_summary, actions, alerts, grounding}, raw, evidence}` 格式 |
| **创新点** | 不依赖额外LLM做排序——用启发式质量函数+两两对比替代，延迟<10ms；55%/45%权重配比经过调优，既尊重单候选绝对质量也考虑相对优劣 |

---

### 2.6 🕸️ 知识图谱系统（M12）

| 项目 | 内容 |
|------|------|
| **文件** | `graph_schema.py`, `graph_index_builder.py`, `scripts/m7/m7_knowledge_graph.py` |
| **核心类** | `NodeType`, `EdgeType`, `Node`, `Edge`, `GraphIndexBuilder`, `KnowledgeGraphEngine` |
| **6种节点类型** | Project（项目）、RiskFactor（风险因子）、Rule（规则）、Scenario（场景）、Evidence（证据）、Metric（指标） |
| **4种边关系** | triggers（触发）、supports（支持）、contradicts（矛盾）、derived_from（派生自） |
| **数据来源** | M12报告CSV / Kickstarter项目数据 / 完整预测数据（full_prediction.csv） |
| **图谱构建** | `GraphIndexBuilder` 批量解析CSV → 导出 nodes.csv + edges.csv + evidence_index.json 到 graph_exports/ |
| **检索能力(v2)** | `KnowledgeGraphEngine` 提供：<br>① **边关键词检索**(权重1.0) ② **snippet包含检索**(0.5) ③ **节点文本检索**(0.3) ④ **属性检索**(0.15)<br>⑤ **因果链BFS路径查找** ⑥ **反义词矛盾检测** ⑦ **证据种子自动生成** ⑧ **相似项目风险分布匹配** |
| **嵌入位置** | 推理前：m7_inference_runner Prompt L3 增强（注入因果规律+相似项目上下文）；推理后：accuracy_gate.py EvidenceStore种子自动填充+图谱矛盾冲突检测 |
| **创新点** | 从历史项目报告(M12)自动抽取结构化图谱，而非手工构建；多维度检索加权让模糊查询也能命中；因果链+BFS让风险评估有"推理路径"可追溯 |

---

### 2.7 🛡️ 准确性闸门系统（AccuracyGate）

| 项目 | 内容 |
|------|------|
| **文件** | `accuracy_gate.py`（1371行，系统最大的单文件） |
| **核心类** | `AccuracyGate`, `Evidence`, `AccuracyEvaluation`, `EvidenceStatus`, `ConfidenceLevel`, `GateDecision` |
| **闸门决策** | PASS / PASS_WITH_WARNING / REJECT / REQUIRES_REVISION / NEEDS_REFRESH 五级 |
| **证据状态机** | VERIFIED → PENDING → EXPIRED(30天TTL) / CONFLICTING / UNKNOWN |
| **置信等级** | HIGH / MEDIUM / LOW / VERY_LOW / REJECTED |
| **检测维度** | ① 证据覆盖率(evidence_coverage) ② 可回查率(recall_rate) ③ 冲突率(conflict_score) ④ 幻觉检测(hallucination_score)<br>⑤ 证据新鲜度(freshness) ⑥ 内部一致性 ⑦ 外部一致性 |
| **融合入口** | `evaluate_router_payload()` 直接评估路由payload / `to_runtime_gate_packet()` 输出标准化闸门包给runtime |
| **创新点** | 不只是pass/fail——五级决策让下游能差异化处理（警告继续 vs 拒绝重修 vs 需要刷新证据）；Evidence TTL机制防止过期知识污染决策 |

---

### 2.8 🔄 自修正迭代循环（Self-Correction Loop）

| 项目 | 内容 |
|------|------|
| **文件** | `self_correction_loop.py`, `self_correction_adapter.py` |
| **核心类** | `SelfCorrectionLoop`, `SelfCorrectionAdapter`, `TemporalFreshnessChecker`, `ConflictAnalyzer`, `CorrectionInstructor` |
| **修正原因枚举** | NO_CORRECTION_NEEDED / LOW_COVERAGE / HIGH_HALLUCINATION / INTERNAL_CONFLICT / EXTERNAL_CONFLICT / OUTDATED_KNOWLEDGE |
| **新鲜度等级** | VERY_FRESH(<1月) / FRESH(1-3月) / STALE(3-6月) / VERY_STALE(>6月) |
| **时效性判断依据** | 知识库(180天) / 图谱(90天) / 模型(120日) 三种不同更新周期 |
| **最大迭代轮数** | 3轮（可配置） |
| **工作流** | 初始输出 → 时效性检查 → 收集证据(信息池+Web) → 冲突分析 → 需要修正？→ LLM生成修正答案 → Gate验证 → 通过/再循环 |
| **集成方式** | 通过 `SelfCorrectionAdapter` 适配器无缝接入 pipeline 和 m9 |
| **创新点** | 类似RLHF的思维链——不是一次生成而是"生成→验证→修正"的反馈环路；TemporalFreshnessChecker根据不同知识源的不同更新周期决定是否需要联网，避免不必要的API开销 |

---

### 2.9 🎯 证据编排器（EvidenceOrchestrator）

| 项目 | 内容 |
|------|------|
| **文件** | `evidence_orchestrator.py` |
| **核心类** | `EvidenceOrchestrator`, `EvidenceSufficiencyAnalyzer`, `EvidenceRequest`, `OrchestrationResult` |
| **证据来源层级** | INTERNAL_KB(知识图谱, 最高优) > INFO_POOL(规则池) > WEB_SEARCH(网络搜索) > INFERENCE(推断, 最低) |
| **编排逻辑** | 内部证据优先使用 → 检测充分性(coverage ≥ 0.65?) → 不足时触发网络检索 → 融合内外部证据 → 按来源优先级排序 |
| **网络检索实现** | 千帆平台Agent检索（将query发给多个agent返回结构化证据）/ WebRetriever(Serper/Tavily API)/ Mock模式 |
| **去重** | 基于URL+snippet哈希的去重 + 来源可靠性排名 |
| **输出** | `OrchestrationResult`: internal_evidence + external_evidence + total_evidence + coverage_score + search_triggered |
| **创新点** | "内部优先、外部补盲"策略——先用自有知识（免费+快+可信），不够再联网（慢+贵+不可控），成本和质量的最优平衡点 |

---

### 2.10 🏗️ TypeScript 多智能体执行引擎（OpenClawRuntime）

| 项目 | 内容 |
|------|------|
| **文件** | `modified-runtime/runtime.ts`, `execution-orchestrator.ts`, `dependency-manager.ts` |
| **核心类** | `OpenClawRuntime`, `ExecutionOrchestrator`, `DependencyManager`, `InMemoryBlackboard` |
| **4个部门Agent** | ① EvidenceAgent（研究/证据部）② FeasibilityAgent（战略/可行性部）③ RiskAgent（市场/风险部）④ LegalAgent（法务部） |
| **依赖拓扑** | evidence(无依赖) → feasibility(依赖evidence) → risk(依赖evidence+feasibility) → legal(依赖evidence+risk) |
| **执行模式** | **DAG批次并行**：DependencyManager拓扑排序 → 同一批次内Promise.all并行 → 批次间串行等待 |
| **黑板架构(InMemoryBlackboard)** | 所有Agent共享状态板——task注册、部门输出写入、依赖检查、状态更新 |
| **审批门(L3)** | 复杂任务自动启用审批闸门，高风险操作需确认后才执行 |
| **环检测+自愈** | DependencyManager检测依赖环→自动降解为线性顺序→强制推进（不会因为配置错误卡死） |
| **创新点** | 真正的DAG执行引擎而非简单流水线——依赖满足即并行，无依赖的Agent同批启动；环检测自愈保证鲁棒性 |

---

### 2.11 📈 质量评分体系（ResultAggregator）

| 项目 | 内容 |
|------|------|
| **文件** | `aggregation/result-aggregator.ts`（1100+行，TS侧最大文件） |
| **四维评分模型** | completeness(完整性, 35%) + depth(深度, 25%) + consistency(一致性, 20%) + actionable(可操作性, 20%) |
| **部门权重** | evidence(0.28) + feasibility(0.32) + risk(0.20) + legal(0.20) |
| **评级映射** | A(85-100) / B(70-84) / C(55-69) / D(<55) |
| **ExecutiveSummary** | 自动生成：headline(一句话结论) + overview(概述) + departmentCount + qualityScore(综合评分) + feasibilityScore(可行性分) + feasibilityVerdict(推进/谨慎/暂停) + businessValueRating(商业价值) + riskLevel(低/中/高) + highlights(亮点) + businessValue + riskView + nextStep |
| **证据绑定输出(EvidenceBoundOutput)** | claims(声明列表) + evidence_registry(证据登记簿) + conflicts(冲突列表) + actions(行动建议) + output_meta(覆盖率/冲突/降级标记) |
| **claim决策类型** | factual(KG事实) / reference(Web引用) / contextural(INFO上下文) / estimate(LLM聚合判断) / fact / recommendation |
| **创新点** | 四维评分不是平均——completeness占35%强调"有没有回答完整问题"；部门权重向feasibility倾斜(32%)因为创业评估最核心问题是"能不能成"；decision_type区分事实vs判断让读者知道哪些可信哪些需谨慎参考 |

---

### 2.12 🎭 LLM Blender 融合引擎

| 项目 | 内容 |
|------|------|
| **文件** | `blender/blender-adapter.ts`, `fusion-strategies.ts`, `prompts.ts` |
| **核心类** | `LLMBlenderAdapter`, 4种 FusionStrategy |
| **4种融合策略** | ① consensus(共识): 四部门一致观点优先，冲突并列说明<br>② weighted(加权): evidence+feasibility权重1.2<br>③ priority(优先级): 严格 evidence→feasibility→risk→legal 顺序<br>④ comprehensive(全面): 尽可能保留全部重要观点 |
| **双阶段融合** | PairRanker(排序) + GenFuser(生成)：先排序确定各部门贡献优先级，再用LLM生成融合文本 |
| **本地回退** | 当LLM API不可用时，按priority策略拼接原始输出（降级但不中断） |
| **FusedResult元数据** | 记录融合方法、置信度、来源部门、排名详情、token消耗、延时等完整审计信息 |
| **创新点** | Rank-then-Fuse两阶段设计——先机器排序（快、确定性）再LLM融合（慢、创造性），兼顾效率和效果；4种策略适应不同业务场景（快速决策用priority，审慎评估用comprehensive） |

---

### 2.13 📱 飞书集成层

| 项目 | 内容 |
|------|------|
| **文件** | `integrations/startup-longlink.ts`(624行), `integrations/feishu-gateway.ts`(382行) |
| **技术方案** | 飞书开放平台长连接(@larksuiteoapi/node-sdk) + WebSocket消息中继 |
| **消息生命周期** | 接收飞书事件 → 去重(5min窗口) → 并发竞态防护 → 调用runtime-execute → 结构化回复飞书 |
| **Token管理** | tenant_access_token 自动获取+缓存(提前60s刷新) |
| **回复格式** | 证据优先报告体：证据锚点 → 快速结论 → 关键发现 → 分部门分析 → 风险与不确定性 → 建议与下一步 |
| **部署架构** | 本地开发：feishu-long直连localhost:30000<br>服务器部署：通过Sakurafrp内网穿透 frp-try.com:20203 → runtime-execute<br>PM2进程管理：fork模式+内存限制1200MB+自动重启 |
| **创新点** | 消息去重窗口扩大到5分钟（飞书常延迟重投）；processingKeys集合防并发竞态（同一条消息不会被两个worker同时处理）；stale_event_tolerance容忍10秒内的旧事件不丢弃 |

---

### 2.14 🛠️ 技能服务（Skill Service）

| 项目 | 内容 |
|------|------|
| **文件** | `skill-service/mock-skill-service.cjs`, `skills/*.yaml` |
| **技能配置(YAML)** | ① research-skills.yaml(研发部): pdf-parser, web-scraper, patent-analysis, tech-feasibility, prototype-evaluator<br>② market-skills.yaml(市场部): competitor-analysis, pricing-research, market-sizing, channel-analysis, trend-detector<br>③ strategy-skills.yaml(战略部): business-model-canvas, go-to-market, financial-projection, partnership-scouting<br>④ legal-skills.yaml(法务部): ip-audit, compliance-check, contract-review, regulatory-mapping<br>⑤ sales-skills.yaml(销售部): pitch-deck-builder, conversion-funnel, customer-profile, pricing-strategy |
| **技能调用** | 通过 SkillInvoker 统一调用 `/skills/invoke` REST API |
| **Mock/真实切换** | SKILL_SERVICE_MOCK_MODE=false 启用 Playwright 浏览器执行真实技能（网页抓取/百度搜索等） |
| **创新点** | YAML声明式技能定义——新增技能只需加YAML不改代码；每个技能有参数定义+使用示例+输出示例，既是运行时配置也是文档 |

---

### 2.15 📋 协作计划图（Collaboration Plan）

| 项目 | 内容 |
|------|------|
| **文件** | `pipeline.py` → `_build_collaboration_plan()` |
| **协作边(Edges)** | ① feasibility↔evidence: question-refine / evidence-feedback（双向细化）<br>② feasibility→risk: handoff-feasibility（可行性交接给风险）<br>③ evidence→risk: handoff-evidence（证据交接给风险）<br>④ {evidence,feasibility,risk}→legal: compliance-request（合规审查） |
| **三阶段划分** | frontline(前线:evidence+feasibility) → execution(执行:risk) → support(支持:legal) |
| **动态bypass** | mode=dynamic-bypass-enabled：前端Agent可直接跳过某些中间步骤加速响应 |
| **传递到TS层** | collaboration_plan.edges 被 BrainPlanAdapter 解析为 DepartmentName 级别的依赖关系，驱动 ExecutionOrchestrator 的 DAG 执行 |
| **创新点** | Python侧定义的协作语义图无损传递到TypeScript侧执行——两边共享同一个edges结构，但各自用各自的语义层表达 |

---

## 三、数据流全景

```
用户输入 "帮我评估这个AI创业项目"
        │
        ▼
┌───────────────────────────────────────────┐
│  ① SmallModelRouter (Qwen3-1.7B+LoRA)    │  ← 本地 MPS 推理
│     → tier=L2, score=6.8                  │
│     → intent="project_evaluation"         │
└───────────────────┬───────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────┐
│  ② route_experts_by_tier(tier=L2)        │
│     → [evidence_agent, feasibility_agent,  │
│         risk_agent, legal_agent]          │
│     → info_pool_retrieve("AI创业项目")    │  ← Bigram向量检索
│     → 命中2条行业规则                      │
└───────────────────┬───────────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
┌────────────────┐    ┌────────────────────┐
│ ③ QianfanAgent │    │  KnowledgeGraphEngine│
│    Client       │    │  (可选，若图谱可用)    │
│    ×4 Agents    │    │  → KG命中 + 因果链   │
│    并行调用      │    │  + 相似项目匹配      │
└───────┬────────┘    └──────────┬─────────┘
        │                         │
        ▼                         ▼
┌───────────────────────────────────────────┐
│  ④ PairRank 融合排序                     │  ← O(n²) 两两对比
│     → 4个候选按质量+胜率排序             │
│     → normalize_agent_outputs() 规范化    │
└───────────────────┬───────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────┐
│  ⑤ EvidenceOrchestrator (可选)            │
│     → 内部KG + info_pool 优先            │
│     → 覆盖率<0.65? → 触发千帆Web检索      │
│     → 融合排序后的统一证据列表             │
└───────────────────┬───────────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
┌────────────────┐    ┌────────────────────┐
│ ⑥ SelfCorrection│    │  AccuracyGate       │
│    Loop (可选)   │    │  证据状态机+冲突检测  │
│    最多3轮修正   │    │  5级闸门决策        │
└───────┬────────┘    └──────────┬─────────┘
        │                         │
        ▼                         ▼
┌───────────────────────────────────────────┐
│  ⑦ pipeline.run() 返回结果               │
│  { selected_experts, fused_output,        │
│    info_pool_hits, knowledge_graph_hits,   │
│    runtime_trace, collaboration_plan }     │
└───────────────────┬───────────────────────┘
                    │ HTTP → runtime-execute-server
                    ▼
┌───────────────────────────────────────────┐
│  ⑧ OpenClawRuntime.execute()              │  ← TypeScript
│     ├─ BrainPlanAdapter → TaskPlan       │
│     │   └─ edges → DAG依赖图              │
│     ├─ ExecutionOrchestrator             │
│     │   ├─ Batch1: [evidence] // 并行     │
│     │   ├─ Batch2: [feasibility] // 依赖  │
│     │   ├─ Batch3: [risk] // 依赖前两个   │
│     │   └─ Batch4: [legal] // 支持        │
│     └─ ResultAggregator.aggregate()        │
│         ├─ buildDepartmentResultCards()   │
│         ├─ buildQualityAssessment()        │  ← 四维评分
│         ├─ buildExecutiveSummary()        │  ← 自动摘要
│         ├─ LLMBlenderAdapter.fuse()       │  ← PairRank+GenFuser
│         └─ buildEvidenceBoundOutput()     │  ← 证据锚点
│             ├─ extractKnowledgeGraphEvidence│
│             ├─ extractWebEvidence()        │
│             ├─ extractInfoPoolEvidence()    │
│             └─ ExecutiveSummary兜底       │
└───────────────────┬───────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────┐
│  ⑨ buildReplyText() → 飞书结构化报告       │
│  ┌─────────────────────────────────────┐  │
│  │ 📊 系统工作状态：信息池命中4条        │  │
│  │ 一、证据锚点（🔍KG / 📎WEB / 📋INFO）│  │
│  │ 二、快速结论                        │  │
│  │ 三、关键发现                        │  │
│  │ 四、分部门分析（×4部门详细）         │  │
│  │ 五、风险与不确定性                  │  │
│  │ 六、建议与下一步（含负责人+时限）    │  │
│  └─────────────────────────────────────┘  │
└───────────────────────────────────────────┘
```

---

## 四、部署架构

```
┌──────────────────┐       ┌──────────────────┐
│  开发机 (Mac)     │       │  服务器 (Linux)   │
│                  │       │                  │
│ OPC Router :18081│◄─────►│  (git push部署)  │
│ Runtime   :30000 │       │                  │
│ feishu-long :9090│       │  PM2 管理:       │
│                  │       │  ├── feishu-long  │
└──────────────────┘       │  ├── opc-router  │
   Sakurafrp 内网穿透      │  └── runtime-exec│
   frp-try.com:20203       │                  │
                            └──────────────────┘
```

---

## 五、关键技术指标汇总

| 指标 | 数值 |
|------|------|
| 代码总量 | ~15,000行（Python ~8,000 + TypeScript ~7,000） |
| Agent数量 | 4（千帆平台发布）+ 5（TS执行层含sales）|
| 小模型参数量 | 1.7B (Qwen3 + LoRA) |
| 最大自修正轮数 | 3 |
| 证据TTL | 30天 |
| 部门DAG最大深度 | 4层（evidence→feasibility/risk→legal）|
| 质量评分维度 | 4维（completeness/depth/consistency/actionable）|
| 融合策略 | 4种（consensus/weighted/priority/comprehensive）|
| 知识图谱节点类型 | 6种 |  
| 图谱边关系类型 | 4种 |  
| PairRank权重配比 | 55% base_quality + 45% pairwise_wins |  

---

*文档生成时间：2026-04-14*
*适用于产品报告PPT、演示文稿、技术答辩*
