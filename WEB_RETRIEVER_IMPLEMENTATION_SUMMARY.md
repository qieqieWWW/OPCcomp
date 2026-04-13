#!/usr/bin/env python
# coding: utf-8

"""
联网检索与时效增强 - 实现方案总结

=================================================================
核心架构：三层融合模型
=================================================================

1. 第一层：证据源管理（web_retriever.py）
   - 联网搜索引擎（WebRetriever）
   - 来源可靠性评分（SourceReliabilityRanker）
   - 证据去重和白名单过滤（DuplicateDetector）
   
2. 第二层：证据编排（evidence_orchestrator.py）
   - 充分性分析（EvidenceSufficiencyAnalyzer）
   - 按需触发网络搜索
   - 证据优先级排序（内部优先、外部补盲）
   - 统一输出格式
   
3. 第三层：融合集成（pipeline.py + accuracy_gate.py）
   - pipeline.py：在主路由中创建编排器，获取编排结果
   - accuracy_gate.py：提供编排结果集成接口
   - 返回值包含编排元数据用于可视化和调试

=================================================================
使用流程
=================================================================

【流程 1】证据不足时触发搜索：
  
  用户查询 
    ↓
  小模型意图分类 
    ↓
  候选 expert 推理 → 初始证据覆盖率评估
    ↓
  [编排器] 检测覆盖率 < 70% 
    ↓
  触发 [WebRetriever] 网络搜索
    ↓
  [SourceReliabilityRanker] 打分 + [DuplicateDetector] 去重
    ↓
  生成结构化网络证据（Evidence 对象）
    ↓
  融合到候选项中
    ↓
  融合层（pairrank + fuse_rule_based）
    ↓
  最终输出

【流程 2】格式转换：

  WebSearchResult（原始搜索）
    ↓
  StructuredWebEvidence（结构化摘要）
    ↓
  Evidence（标准对象，可直接入证据库）
    ↓
  OrchestrationResult（编排结果）
    ↓
  融合层消费格式（Dict）

=================================================================
数据结构映射
=================================================================

Evidence（通用证据对象）：
  - evidence_id: "WEB_ABC123" 或"EV-KS-2025-MARKET"
  - content: 摘要（非原文）
  - source_type: "web_search" | "internal_kb" | "info_pool"
  - source_name: 域名或来源名
  - source_url: URL（可选）
  - timestamp: 抓取/创建时间
  - expiration_days: 有效期（网络证据7天，内部180-365天）
  - confidence: "high" | "medium" | "low"
  - metadata: {"reliability_score": 0.95, "risk_label": "trusted", ...}

OrchestrationResult：
  - internal_evidence: List[Evidence]  # 知识库/规则证据
  - external_evidence: List[Evidence]  # 网络搜索证据
  - total_evidence: List[Evidence]     # 合并+排序后
  - coverage_score: 0.0-1.0           # 证据覆盖率
  - orchestration_quality: 0.0-1.0    # 编排质量评分
  - search_triggered: bool            # 是否触发网络搜索
  - notes: List[str]                  # 日志

=================================================================
关键参数与阈值
=================================================================

【搜索触发条件】
  - 证据覆盖率 < 0.60
  - 幻觉风险 > 0.30
  - → OR 关系：任一条件满足即触发

【来源可靠性评分】
  - 高信度（0.85-0.95）: GitHub、ArXiv、官方机构
  - 中信度（0.60-0.75）: 业界媒体、企业博客
  - 低信度（0.45-0.50）: UGC 平台（知乎、微博、Reddit）
  - 用于：
    a) 排序（高信度优先）
    b) 置信度标签
    c) 融合层权重调整

【去重策略】
  1. URL 规范化（移除参数、fragment、大小写）
  2. 内容 Hash 去重（MD5）
  3. 重复第二条开始标记为重复

【编排质量评分】
  综合因素：
  - 30% 来源多样性（3+ 来源最优）
  - 40% 内外평衡（内部 60-95% 最优）
  - 30% 可信度（高信度占比）

=================================================================
与融合层的交界
=================================================================

【输入】
  pipeline.run() 返回的 fused_result 包含：
    - fused_risk_summary
    - fused_actions
    - fused_alerts
    - pairrank 评分

【处理】
  EvidenceOrchestrator.orchestrate(request)：
    1. 分析输出声明中的证据覆盖率
    2. 如果不足，调用 web_retriever.search_for_evidence()
    3. 返回 OrchestrationResult

【输出】
  pipeline.run() 返回值新增：
    - evidence_orchestration_result: OrchestrationResult
    - fused_result.evidence_orchestration_metadata: 
        {
          "search_triggered": bool,
          "internal_count": int,
          "external_count": int,
          "coverage": float,
          "quality": float
        }

=================================================================
与 accuracy_gate 的交界
=================================================================

【集成函数】
  integrate_evidence_orchestration(gate, orchestration_result)
    → 将编排结果中的证据添加到 gate.evidence_store
    → 供后续 gate.check_output() 调用时回查

【工作流】
  1. evidence_orchestrator 生成 Evidence 列表
  2. 转换为 dict（serialize）
  3. 通过 pipeline 返回
  4. 若需要检测输出准确性，调用 integrate_evidence_orchestration()
  5. accuracy_gate 使用扩展后的推据库进行检测

=================================================================
环境配置
=================================================================

【可选配置】
  ENABLE_WEB_SEARCH: "false" | "true"  (默认: false)
  SERPER_API_KEY: "sk-xxx"             (如需真实搜索)
  WEB_ENGINE: "serper" | "mock"        (默认: mock)
  WEB_CACHE_DIR: "./web_cache"         (缓存目录)

【开发模式】
  - WEB_ENGINE=mock: 使用虚拟搜索结果（无外网依赖）
  - ENABLE_WEB_SEARCH=false: 关闭搜索，仅用内部证据

【生产模式】
  - ENABLE_WEB_SEARCH=true
  - WEB_ENGINE=serper
  - SERPER_API_KEY=<valid_key>

=================================================================
测试与验证
=================================================================

【验证脚本】
  web_retriever_validation.py
  
  包含 5 个测试：
  1. ✓ web_retriever 模块功能
  2. ✓ evidence_orchestrator 编排功能
  3. ✓ accuracy_gate 集成接口
  4. ✓ pipeline 集成方案
  5. ✓ 统一输出格式

【运行方式】
  cd /Users/qieqieqie/Desktop/Start-up-Evaluation-and-AI-Routing/OPCcomp
  python3 web_retriever_validation.py

【预期输出】
  ✓ 所有验证通过! 联网检索与时效增强已完整集成

=================================================================
最佳实践
=================================================================

1. **何时触发搜索**
   - 内部证据少于 3 条
   - 覆盖率低于 60%
   - 幻觉风险检测高于 30%
   → 避免不必要的外网调用

2. **证据优先级**
   - 知识图谱（KB）> info_pool（规则）> 网络搜索
   - 新鲜度：同源中，越新越优先
   - 可靠性：高信度标签影响后续融合权重

3. **性能优化**
   - 启用缓存（./web_cache）
   - 缓存有效期遵循 expiration_days
   - 批量请求时合并查询

4. **错误处理**
   - 网络搜索失败：降级到 mock 引擎、使用缓存
   - 证据转换失败：记录日志但继续处理
   - API 超时：自动重试或跳过

5. **监控指标**
   - 搜索触发率（应 < 40%）
   - 平均证据覆盖率（应 > 70%）
   - 外部证据占比（应 < 30%）
   - 来源可靠性均值（应 > 0.75）

=================================================================
已知限制与未来扩展
=================================================================

【当前限制】
  1. mock 搜索引擎不能真正的网络检索
     → 需配置真实 SERPER_API_KEY
  
  2. 摘要提取基于搜索引擎 snippet
     → 未实现深度 HTML 解析
  
  3. 去重基于 URL + 内容 Hash
     → 不能识别合法的重写内容

【未来扩展】
  1. [ ] 多搜索引擎支持（Google、Bing、百度）
  2. [ ] 知识库融合（维基百科、行业数据库）
  3. [ ] 因果链路追踪（证据←→声明）
  4. [ ] A/B 测试（不同编排策略的效果对比）
  5. [ ] 自适应阈值（根据历史命中率调整触发值）

=================================================================
文件清单
=================================================================

新增文件：
  - OPCcomp/web_retriever.py              (联网搜索核心)
  - OPCcomp/evidence_orchestrator.py      (编排引擎)
  - OPCcomp/web_retriever_validation.py  (验证脚本)
  - OPCcomp/PIPELINE_INTEGRATION_PATCH.py (集成补丁说明)

修改文件：
  - OPCcomp/accuracy_gate.py              (新增集成接口)
  - OPCcomp/competition_router/src/opc_router/pipeline.py
                                          (新增编排器初始化)

可选同步（openclaw-runtime）：
  - /Users/qieqieqie/Documents/openclaw-runtime/OPCcomp/
    web_retriever.py
    evidence_orchestrator.py

=================================================================
"""

print(__doc__)
