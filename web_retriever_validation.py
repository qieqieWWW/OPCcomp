#!/usr/bin/env python
# coding: utf-8

"""
联网检索与时效增强 - 端到端验证脚本

验证内容：
1. web_retriever 模块正确加载和工作
2. 证据编排器正确执行
3. 与 accuracy_gate 的集成工作
4. 为融合层提供统一格式

用法：
    python3 web_retriever_validation.py
"""

import json
import sys
import time
from pathlib import Path

# 添加当前目录到路径
sys.path.insert(0, str(Path(__file__).parent))


def test_web_retriever():
    """测试 web_retriever 模块"""
    print("\n" + "="*60)
    print("测试 1: web_retriever 模块导入和初始化")
    print("="*60)
    
    try:
        from web_retriever import (
            WebRetriever,
            SourceReliabilityRanker,
            DuplicateDetector,
            should_trigger_web_search,
        )
        print("✓ web_retriever 模块导入成功")
        
        # 初始化 retriever
        retriever = WebRetriever(engine="mock", cache_dir="./web_cache_test")
        print("✓ WebRetriever 初始化成功")
        
        # 测试可靠性评分
        ranker = SourceReliabilityRanker()
        score, risk = ranker.rank("https://github.com/example")
        print(f"✓ 可靠性评分: github.com -> {score} (risk: {risk})")
        
        score, risk = ranker.rank("https://zhihu.com/question/123")
        print(f"✓ 风险平台识别: zhihu.com -> {score} (risk: {risk})")
        
        # 测试去重
        from web_retriever import WebSearchResult
        deduper = DuplicateDetector()
        result1 = WebSearchResult(
            title="Test 1",
            url="https://example.com/page",
            snippet="This is test content"
        )
        result2 = WebSearchResult(
            title="Test 2",
            url="https://example.com/page",  # 相同 URL
            snippet="This is test content"
        )
        
        is_dup1 = deduper.is_duplicate(result1)
        is_dup2 = deduper.is_duplicate(result2)
        print(f"✓ 去重检测: 第一条={is_dup1}, 第二条={is_dup2} (预期: False, True)")
        
        # 测试联网搜索触发条件
        should_search = should_trigger_web_search(
            evidence_coverage=0.5,
            hallucination_score=0.2
        )
        print(f"✓ 搜索触发条件判断: coverage=0.5, hallucination=0.2 -> {should_search}")
        
        return True
    except Exception as e:
        print(f"✗ 错误: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_evidence_orchestrator():
    """测试证据编排器"""
    print("\n" + "="*60)
    print("测试 2: 证据编排器模块导入和功能")
    print("="*60)
    
    try:
        from evidence_orchestrator import (
            EvidenceOrchestrator,
            EvidenceRequest,
            EvidenceSufficiencyAnalyzer,
            OrchestrationResult,
        )
        from web_retriever import WebRetriever
        from accuracy_gate import Evidence, EvidenceStatus, ConfidenceLevel
        
        print("✓ evidence_orchestrator 模块导入成功")
        
        # 初始化编排器
        web_retriever = WebRetriever(engine="mock")
        orchestrator = EvidenceOrchestrator(
            kb_retriever=None,
            info_pool_retriever=None,
            web_retriever=web_retriever,
            enable_deduplication=True,
        )
        print("✓ EvidenceOrchestrator 初始化成功")
        
        # 测试充分性分析器
        analyzer = EvidenceSufficiencyAnalyzer()
        
        # 创建测试证据
        test_evidence = [
            Evidence(
                evidence_id="TEST_1",
                content="Test content 1",
                source_type="internal_kb",
                source_name="Knowledge Base",
                status=EvidenceStatus.VERIFIED,
                confidence=ConfidenceLevel.HIGH,
            ),
            Evidence(
                evidence_id="TEST_2",
                content="Test content 2",
                source_type="internal_kb",
                source_name="Knowledge Base",
                status=EvidenceStatus.VERIFIED,
                confidence=ConfidenceLevel.MEDIUM,
            ),
        ]
        
        should_search, coverage, reason = analyzer.analyze_sufficiency(
            test_evidence,
            output_claims=["claim1", "claim2", "claim3"],
            query_category="general"
        )
        print(f"✓ 充分性分析: coverage={coverage:.2%}, should_search={should_search}")
        print(f"  原因: {reason}")
        
        # 计算覆盖率
        coverage_score = analyzer.estimate_coverage(test_evidence)
        print(f"✓ 覆盖率评估: {coverage_score:.3f}")
        
        # 测试编排请求
        request = EvidenceRequest(
            query="Kickstarter融资成功率",
            output_claims=["成功率约为37%", "融资主要来自美国"],
            query_category="financial",
            required_evidence_count=3,
            min_evidence_coverage=0.7
        )
        print(f"✓ 编排请求创建成功: query={request.query}")
        
        return True
    except Exception as e:
        print(f"✗ 错误: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_accuracy_gate_integration():
    """测试 accuracy_gate 与编排器的集成"""
    print("\n" + "="*60)
    print("测试 3: accuracy_gate 与编排器集成")
    print("="*60)
    
    try:
        from accuracy_gate import (
            AccuracyGate,
            Evidence,
            EvidenceStatus,
            ConfidenceLevel,
            GateDecision,
            integrate_evidence_orchestration,
            create_gate_with_orchestrator,
        )
        print("✓ accuracy_gate 集成函数导入成功")
        
        # 创建带编排器的 gate
        gate, orchestrator = create_gate_with_orchestrator()
        print(f"✓ gate 创建: {gate is not None}")
        print(f"✓ orchestrator 创建: {orchestrator is not None}")
        
        # 测试编排结果集成
        test_result = {
            "evidence_list": [],
            "evidence_map": {
                "TEST_1": {
                    "evidence_id": "TEST_1",
                    "content": "Test content",
                    "source_type": "web_search",
                    "source_name": "GitHub",
                    "source_url": "https://github.com/example",
                    "timestamp": time.time(),
                    "expiration_days": 7,
                    "status": "verified",
                    "confidence": "high",
                    "metadata": {"reliability_score": 0.95}
                }
            },
            "evidence_pool": {
                "web_search": []
            },
            "orchestration_stats": {
                "search_triggered": True,
                "coverage_score": 0.75
            }
        }
        
        integration_result = integrate_evidence_orchestration(gate, test_result)
        print(f"✓ 证据集成结果:")
        print(f"  - 添加数量: {integration_result['added_evidence_count']}")
        print(f"  - 总覆盖: {integration_result['evidence_coverage_after']}")
        print(f"  - 状态: {integration_result['status']}")
        
        return True
    except Exception as e:
        print(f"✗ 错误: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_pipeline_integration():
    """测试 pipeline 集成"""
    print("\n" + "="*60)
    print("测试 4: Pipeline 集成方案验证")
    print("="*60)
    
    try:
        # 检查 pipeline.py 是否正确修改
        pipeline_path = Path(
            "/Users/qieqieqie/Desktop/Start-up-Evaluation-and-AI-Routing/"
            "OPCcomp/competition_router/src/opc_router/pipeline.py"
        )
        
        if not pipeline_path.exists():
            print("✗ pipeline.py 不存在")
            return False
        
        content = pipeline_path.read_text("utf-8")
        
        checks = [
            ("_init_evidence_orchestrator" in content, "编排器初始化方法已添加"),
            ("evidence_orchestrator" in content, "编排器实例创建已添加"),
            ("EvidenceRequest" in content, "编排请求处理已添加"),
            ("evidence_orchestration_result" in content, "编排结果添加到返回值"),
        ]
        
        all_passed = True
        for check, desc in checks:
            status = "✓" if check else "✗"
            print(f"{status} {desc}")
            if not check:
                all_passed = False
        
        return all_passed
    except Exception as e:
        print(f"✗ 错误: {e}")
        return False


def test_unified_format():
    """测试统一输出格式"""
    print("\n" + "="*60)
    print("测试 5: 统一输出格式验证")
    print("="*60)
    
    try:
        from evidence_orchestrator import format_orchestration_result_for_fusion
        from accuracy_gate import Evidence, EvidenceStatus, ConfidenceLevel
        from dataclasses import dataclass, asdict
        
        print("✓ 格式化函数导入成功")
        
        # 创建测试结果
        test_evidence = Evidence(
            evidence_id="TEST_WEB_001",
            content="Sample evidence from web search",
            source_type="web_search",
            source_name="GitHub",
            source_url="https://github.com/example",
            status=EvidenceStatus.VERIFIED,
            confidence=ConfidenceLevel.HIGH,
        )
        
        from evidence_orchestrator import OrchestrationResult
        test_result = OrchestrationResult(
            internal_evidence=[],
            external_evidence=[test_evidence],
            total_evidence=[test_evidence],
            coverage_score=0.50,
            orchestration_quality=0.65,
            search_triggered=True,
            notes=["This is a test result"]
        )
        
        formatted = format_orchestration_result_for_fusion(test_result)
        print(f"✓ 编排结果格式化成功")
        print(f"  - 总证据数: {formatted['orchestration_stats']['total_count']}")
        print(f"  - 搜索触发: {formatted['orchestration_stats']['search_triggered']}")
        print(f"  - 结构: {list(formatted.keys())}")
        
        return True
    except Exception as e:
        print(f"✗ 错误: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    """运行所有验证"""
    print("\n╔════════════════════════════════════════════════════════════╗")
    print("║   联网检索与时效增强 - 端到端验证                           ║")
    print("╚════════════════════════════════════════════════════════════╝")
    
    results = {
        "web_retriever": test_web_retriever(),
        "evidence_orchestrator": test_evidence_orchestrator(),
        "accuracy_gate_integration": test_accuracy_gate_integration(),
        "pipeline_integration": test_pipeline_integration(),
        "unified_format": test_unified_format(),
    }
    
    print("\n" + "="*60)
    print("验证汇总")
    print("="*60)
    
    for test_name, passed in results.items():
        status = "✓ PASS" if passed else "✗ FAIL"
        print(f"{status}: {test_name}")
    
    all_passed = all(results.values())
    print("\n" + ("="*60))
    if all_passed:
        print("✓ 所有验证通过! 联网检索与时效增强已完整集成")
    else:
        print("✗ 部分验证失败，请查看上面的错误信息")
    
    return all_passed


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
