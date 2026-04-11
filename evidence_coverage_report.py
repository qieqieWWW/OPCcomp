#!/usr/bin/env python
# coding: utf-8

"""
证据覆盖率报告生成器
===================

功能：
1. 分析多个准确性评估结果，生成证据覆盖率报告
2. 识别证据使用模式和问题
3. 提供改进建议和趋势分析
4. 集成M5和M12模块进行深度分析

输出：
- 证据覆盖率统计报告
- 问题声明分析
- 改进建议
- 趋势图表（如果matplotlib可用）
"""

import os
import sys
import json
import time
import statistics
from pathlib import Path
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass, asdict, field
from collections import defaultdict
import hashlib

# 导入准确性闸门
sys.path.insert(0, str(Path(__file__).parent))

try:
    from accuracy_gate import AccuracyGate, generate_evidence_coverage_report, AccuracyEvaluation, GateDecision
    print("✓ 准确性闸门模块导入成功")
except ImportError as e:
    print(f"⚠️ 准确性闸门导入失败: {e}")
    # 创建基本实现
    class AccuracyEvaluation:
        def __init__(self):
            self.evidence_coverage = 0.0
            self.confidence_score = 0.0
            self.hallucination_score = 0.0
            self.conflict_score = 0.0
            self.gate_decision = "unknown"
    
    class GateDecision:
        PASS = "pass"
    
    def generate_evidence_coverage_report(evaluations, output_dir):
        return {"status": "fallback", "message": "使用基本实现"}

# ============ 数据类定义 ============

@dataclass
class EvidencePattern:
    """证据使用模式"""
    pattern_type: str  # "frequent_source", "time_based", "type_distribution", "quality_trend"
    description: str
    metrics: Dict[str, Any]
    impact_score: float  # 0-1，影响程度
    suggestions: List[str] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

@dataclass
class CoverageReport:
    """覆盖率报告"""
    report_id: str
    generated_at: datetime = field(default_factory=datetime.now)
    time_period: Optional[Tuple[datetime, datetime]] = None
    
    # 统计摘要
    total_evaluations: int = 0
    total_statements: int = 0
    total_verified_statements: int = 0
    total_problematic_statements: int = 0
    
    # 质量指标
    avg_evidence_coverage: float = 0.0
    avg_confidence_score: float = 0.0
    avg_hallucination_score: float = 0.0
    avg_conflict_score: float = 0.0
    
    # 决策分布
    decision_distribution: Dict[str, int] = field(default_factory=dict)
    
    # 模式分析
    evidence_patterns: List[EvidencePattern] = field(default_factory=list)
    
    # 问题分析
    common_issues: List[Dict[str, Any]] = field(default_factory=list)
    
    # 改进建议
    recommendations: List[str] = field(default_factory=list)
    
    # 趋势分析
    trends: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        result = asdict(self)
        result["generated_at"] = self.generated_at.isoformat()
        
        if self.time_period:
            result["time_period"] = {
                "start": self.time_period[0].isoformat(),
                "end": self.time_period[1].isoformat()
            }
        
        return result

# ============ 报告生成器 ============

class EvidenceCoverageReporter:
    """证据覆盖率报告生成器"""
    
    def __init__(self, accuracy_gate: Optional[AccuracyGate] = None):
        self.accuracy_gate = accuracy_gate
        self.reports_dir = Path("reports") / "evidence_coverage"
        self.reports_dir.mkdir(parents=True, exist_ok=True)
    
    def analyze_evaluations(self, evaluations: List[AccuracyEvaluation]) -> CoverageReport:
        """分析评估结果"""
        print(f"📊 分析 {len(evaluations)} 个评估结果")
        
        if not evaluations:
            return self._create_empty_report()
        
        # 计算基本统计
        total_statements = sum(e.total_statements for e in evaluations)
        total_verified = sum(e.verified_statements for e in evaluations)
        total_problematic = sum(
            e.unverified_statements + e.conflicting_statements + e.hallucinated_statements 
            for e in evaluations
        )
        
        # 计算平均值
        avg_coverage = statistics.mean([e.evidence_coverage for e in evaluations]) if evaluations else 0.0
        avg_confidence = statistics.mean([e.confidence_score for e in evaluations]) if evaluations else 0.0
        avg_hallucination = statistics.mean([e.hallucination_score for e in evaluations]) if evaluations else 0.0
        avg_conflict = statistics.mean([e.conflict_score for e in evaluations]) if evaluations else 0.0
        
        # 决策分布
        decision_dist = defaultdict(int)
        for e in evaluations:
            decision_dist[e.gate_decision.value] += 1
        
        # 创建报告
        report = CoverageReport(
            report_id=f"cov_rep_{int(time.time())}_{hashlib.md5(str(len(evaluations)).encode()).hexdigest()[:8]}",
            total_evaluations=len(evaluations),
            total_statements=total_statements,
            total_verified_statements=total_verified,
            total_problematic_statements=total_problematic,
            avg_evidence_coverage=avg_coverage,
            avg_confidence_score=avg_confidence,
            avg_hallucination_score=avg_hallucination,
            avg_conflict_score=avg_conflict,
            decision_distribution=dict(decision_dist)
        )
        
        # 分析证据模式
        report.evidence_patterns = self._analyze_evidence_patterns(evaluations)
        
        # 识别常见问题
        report.common_issues = self._identify_common_issues(evaluations)
        
        # 生成建议
        report.recommendations = self._generate_recommendations(report)
        
        # 趋势分析
        if len(evaluations) >= 5:
            report.trends = self._analyze_trends(evaluations)
        
        return report
    
    def _create_empty_report(self) -> CoverageReport:
        """创建空报告"""
        return CoverageReport(
            report_id=f"empty_rep_{int(time.time())}",
            total_evaluations=0,
            total_statements=0,
            total_verified_statements=0,
            total_problematic_statements=0,
            avg_evidence_coverage=0.0,
            avg_confidence_score=0.0,
            avg_hallucination_score=0.0,
            avg_conflict_score=0.0,
            decision_distribution={},
            recommendations=["无评估数据可分析，请先运行准确性评估"]
        )
    
    def _analyze_evidence_patterns(self, evaluations: List[AccuracyEvaluation]) -> List[EvidencePattern]:
        """分析证据使用模式"""
        patterns = []
        
        # 1. 覆盖率模式
        coverage_values = [e.evidence_coverage for e in evaluations]
        if coverage_values:
            avg_coverage = statistics.mean(coverage_values)
            std_coverage = statistics.stdev(coverage_values) if len(coverage_values) > 1 else 0.0
            
            if std_coverage > 0.2:
                patterns.append(EvidencePattern(
                    pattern_type="coverage_volatility",
                    description="证据覆盖率波动较大，表明证据使用不一致",
                    metrics={
                        "average_coverage": avg_coverage,
                        "std_deviation": std_coverage,
                        "volatility": std_coverage / avg_coverage if avg_coverage > 0 else 0.0
                    },
                    impact_score=min(1.0, std_coverage * 2),
                    suggestions=[
                        "建立统一的证据引用标准",
                        "提供证据引用模板和指南",
                        "增加证据验证检查点"
                    ]
                ))
        
        # 2. 决策模式
        pass_rate = sum(1 for e in evaluations if e.gate_decision == GateDecision.PASS) / len(evaluations)
        
        if pass_rate < 0.5:
            patterns.append(EvidencePattern(
                pattern_type="low_pass_rate",
                description="通过率较低，多数输出需要修改或拒绝",
                metrics={
                    "pass_rate": pass_rate,
                    "reject_rate": sum(1 for e in evaluations if e.gate_decision == GateDecision.REJECT) / len(evaluations),
                    "warning_rate": sum(1 for e in evaluations if e.gate_decision == GateDecision.PASS_WITH_WARNING) / len(evaluations)
                },
                impact_score=1.0 - pass_rate,
                suggestions=[
                    "加强证据收集和验证培训",
                    "优化输出生成模板",
                    "增加预检查环节"
                ]
            ))
        
        # 3. 幻觉问题模式
        avg_hallucination = statistics.mean([e.hallucination_score for e in evaluations]) if evaluations else 0.0
        if avg_hallucination > 0.3:
            patterns.append(EvidencePattern(
                pattern_type="high_hallucination",
                description="幻觉问题较严重，输出中虚构内容较多",
                metrics={
                    "average_hallucination_score": avg_hallucination,
                    "high_hallucination_count": sum(1 for e in evaluations if e.hallucination_score > 0.5)
                },
                impact_score=min(1.0, avg_hallucination * 2),
                suggestions=[
                    "增加事实核查环节",
                    "使用权威数据源验证",
                    "实施多轮验证机制"
                ]
            ))
        
        # 4. 冲突问题模式
        avg_conflict = statistics.mean([e.conflict_score for e in evaluations]) if evaluations else 0.0
        if avg_conflict > 0.3:
            patterns.append(EvidencePattern(
                pattern_type="high_conflict",
                description="内部冲突较多，输出一致性有待提高",
                metrics={
                    "average_conflict_score": avg_conflict,
                    "high_conflict_count": sum(1 for e in evaluations if e.conflict_score > 0.5)
                },
                impact_score=min(1.0, avg_conflict * 2),
                suggestions=[
                    "增加逻辑一致性检查",
                    "使用矛盾检测算法",
                    "建立事实核查数据库"
                ]
            ))
        
        return patterns
    
    def _identify_common_issues(self, evaluations: List[AccuracyEvaluation]) -> List[Dict[str, Any]]:
        """识别常见问题"""
        issues = []
        
        # 统计各类问题
        unverified_counts = sum(e.unverified_statements for e in evaluations)
        conflicting_counts = sum(e.conflicting_statements for e in evaluations)
        hallucinated_counts = sum(e.hallucinated_statements for e in evaluations)
        expired_counts = sum(e.expired_evidence_statements for e in evaluations)
        
        total_problems = unverified_counts + conflicting_counts + hallucinated_counts + expired_counts
        
        if total_problems > 0:
            # 无证据问题
            if unverified_counts > total_problems * 0.3:
                issues.append({
                    "issue_type": "lack_of_evidence",
                    "description": "大量声明缺乏证据支持",
                    "count": unverified_counts,
                    "percentage": unverified_counts / total_problems if total_problems > 0 else 0.0,
                    "severity": "high",
                    "examples": self._get_issue_examples(evaluations, "unverified")
                })
            
            # 冲突问题
            if conflicting_counts > total_problems * 0.2:
                issues.append({
                    "issue_type": "internal_conflicts",
                    "description": "输出内部存在矛盾声明",
                    "count": conflicting_counts,
                    "percentage": conflicting_counts / total_problems if total_problems > 0 else 0.0,
                    "severity": "medium",
                    "examples": self._get_issue_examples(evaluations, "conflicting")
                })
            
            # 幻觉问题
            if hallucinated_counts > total_problems * 0.2:
                issues.append({
                    "issue_type": "hallucinations",
                    "description": "检测到虚构或未经证实的内容",
                    "count": hallucinated_counts,
                    "percentage": hallucinated_counts / total_problems if total_problems > 0 else 0.0,
                    "severity": "critical",
                    "examples": self._get_issue_examples(evaluations, "hallucinated")
                })
            
            # 过期证据问题
            if expired_counts > 0:
                issues.append({
                    "issue_type": "expired_evidence",
                    "description": "使用过期证据",
                    "count": expired_counts,
                    "percentage": expired_counts / total_problems if total_problems > 0 else 0.0,
                    "severity": "medium",
                    "examples": self._get_issue_examples(evaluations, "expired")
                })
        
        return issues
    
    def _get_issue_examples(self, evaluations: List[AccuracyEvaluation], issue_type: str, max_examples: int = 3) -> List[str]:
        """获取问题示例"""
        examples = []
        
        for evaluation in evaluations:
            # 这里简化实现，实际可以从evaluation.statement_analysis中获取
            if issue_type == "unverified" and evaluation.unverified_statements > 0:
                examples.append(f"评估 {evaluation.output_id}: {evaluation.unverified_statements} 个未验证声明")
            elif issue_type == "conflicting" and evaluation.conflicting_statements > 0:
                examples.append(f"评估 {evaluation.output_id}: {evaluation.conflicting_statements} 个冲突声明")
            elif issue_type == "hallucinated" and evaluation.hallucinated_statements > 0:
                examples.append(f"评估 {evaluation.output_id}: {evaluation.hallucinated_statements} 个幻觉声明")
            elif issue_type == "expired" and evaluation.expired_evidence_statements > 0:
                examples.append(f"评估 {evaluation.output_id}: {evaluation.expired_evidence_statements} 个过期证据声明")
            
            if len(examples) >= max_examples:
                break
        
        return examples
    
    def _generate_recommendations(self, report: CoverageReport) -> List[str]:
        """生成改进建议"""
        recommendations = []
        
        # 基于覆盖率
        if report.avg_evidence_coverage < 0.5:
            recommendations.append("⚠️ 证据覆盖率严重不足（<50%），建议：1）增加证据收集；2）优化引用机制；3）提供证据模板")
        elif report.avg_evidence_coverage < 0.7:
            recommendations.append("⚠️ 证据覆盖率偏低（<70%），建议：1）加强证据验证；2）建立证据库；3）提供培训")
        else:
            recommendations.append("✅ 证据覆盖率良好（≥70%），继续保持")
        
        # 基于置信度
        if report.avg_confidence_score < 0.5:
            recommendations.append("⚠️ 置信度评分较低，建议：1）使用高质量证据源；2）增加交叉验证；3）降低不确定声明比例")
        
        # 基于幻觉评分
        if report.avg_hallucination_score > 0.3:
            recommendations.append("⚠️ 幻觉问题较严重，建议：1）加强事实核查；2）使用权威数据源；3）实施多层验证")
        
        # 基于冲突评分
        if report.avg_conflict_score > 0.3:
            recommendations.append("⚠️ 内部冲突较多，建议：1）增加一致性检查；2）建立事实核查数据库；3）优化输出生成逻辑")
        
        # 基于决策分布
        if report.decision_distribution.get(GateDecision.REJECT, 0) > len(report.decision_distribution) * 0.3:
            recommendations.append("⚠️ 拒绝率过高，建议：1）优化输出质量；2）增加预检查；3）提供具体反馈")
        
        # 基于问题分析
        if report.total_problematic_statements > report.total_statements * 0.3:
            recommendations.append("⚠️ 问题声明比例过高（>30%），建议全面审查输出质量流程")
        
        # 通用建议
        recommendations.append("💡 定期运行证据覆盖率报告，持续监控和改进输出质量")
        
        return recommendations
    
    def _analyze_trends(self, evaluations: List[AccuracyEvaluation]) -> Dict[str, Any]:
        """分析趋势"""
        # 按时间排序（假设evaluations已经按时间排序）
        if len(evaluations) < 3:
            return {}
        
        # 提取时间序列数据
        coverage_trend = [e.evidence_coverage for e in evaluations]
        confidence_trend = [e.confidence_score for e in evaluations]
        hallucination_trend = [e.hallucination_score for e in evaluations]
        conflict_trend = [e.conflict_score for e in evaluations]
        
        # 计算趋势
        def calculate_trend(values):
            if len(values) < 2:
                return "stable"
            
            first_half = values[:len(values)//2]
            second_half = values[len(values)//2:]
            
            avg_first = statistics.mean(first_half) if first_half else 0.0
            avg_second = statistics.mean(second_half) if second_half else 0.0
            
            if avg_second > avg_first * 1.1:
                return "improving"
            elif avg_second < avg_first * 0.9:
                return "declining"
            else:
                return "stable"
        
        trends = {
            "coverage_trend": calculate_trend(coverage_trend),
            "confidence_trend": calculate_trend(confidence_trend),
            "hallucination_trend": calculate_trend(hallucination_trend),
            "conflict_trend": calculate_trend(conflict_trend),
            "period_analysis": {
                "start_coverage": coverage_trend[0],
                "end_coverage": coverage_trend[-1],
                "change_percentage": ((coverage_trend[-1] - coverage_trend[0]) / coverage_trend[0] * 100) if coverage_trend[0] > 0 else 0.0
            }
        }
        
        return trends
    
    def generate_report(self, evaluations: List[AccuracyEvaluation], 
                       output_format: str = "json") -> Dict[str, Any]:
        """生成报告"""
        report = self.analyze_evaluations(evaluations)
        
        # 保存报告
        if output_format == "json":
            report_dict = report.to_dict()
            
            # 添加时间戳
            report_dict["analysis_timestamp"] = time.time()
            report_dict["analysis_date"] = datetime.now().isoformat()
            
            # 保存文件
            filename = f"evidence_coverage_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            filepath = self.reports_dir / filename
            
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(report_dict, f, indent=2, ensure_ascii=False)
            
            print(f"📄 报告已保存: {filepath}")
            
            return report_dict
        
        else:
            print("⚠️ 暂不支持其他格式，使用JSON格式")
            return report.to_dict()
    
    def generate_m5_integrated_report(self, evaluations: List[AccuracyEvaluation]) -> Dict[str, Any]:
        """生成M5集成报告"""
        if not self.accuracy_gate or not hasattr(self.accuracy_gate, 'm5_available') or not self.accuracy_gate.m5_available:
            print("⚠️ M5模块不可用，生成基本报告")
            return self.generate_report(evaluations)
        
        # 基本报告
        base_report = self.analyze_evaluations(evaluations)
        report_dict = base_report.to_dict()
        
        # 添加M5集成分析
        try:
            from accuracy_gate import M5_CLASSES
            
            TestCase = M5_CLASSES.get("TestCase")
            TestResult = M5_CLASSES.get("TestResult")
            
            if TestCase and TestResult:
                # 创建M5测试用例和结果
                m5_test_cases = []
                m5_test_results = []
                
                for i, evaluation in enumerate(evaluations[:5]):  # 限制数量
                    test_case = TestCase(
                        case_id=f"cov_rep_{evaluation.output_id}",
                        case_name=f"证据覆盖率测试-{evaluation.output_id}",
                        description=f"证据覆盖率: {evaluation.evidence_coverage:.1%}",
                        project_data={"evaluation": evaluation.to_dict()},
                        expected_risk_level="low" if evaluation.evidence_coverage > 0.7 else "medium",
                        tags=["coverage_report", "evidence_analysis"]
                    )
                    
                    test_result = TestResult(
                        case_id=test_case.case_id,
                        case_name=test_case.case_name,
                        status="passed" if evaluation.evidence_coverage > 0.7 else "failed",
                        actual_risk_level="low" if evaluation.evidence_coverage > 0.7 else "high",
                        expected_risk_level=test_case.expected_risk_level,
                        passed=evaluation.evidence_coverage > 0.7,
                        start_time=evaluation.timestamp - 1.0,
                        end_time=evaluation.timestamp,
                        duration=1.0,
                        metrics={
                            "evidence_coverage": evaluation.evidence_coverage,
                            "gate_decision": evaluation.gate_decision.value,
                            "confidence_score": evaluation.confidence_score
                        }
                    )
                    
                    m5_test_cases.append(test_case.to_dict() if hasattr(test_case, 'to_dict') else str(test_case))
                    m5_test_results.append(test_result.to_dict() if hasattr(test_result, 'to_dict') else str(test_result))
                
                report_dict["m5_integration"] = {
                    "test_case_count": len(m5_test_cases),
                    "test_result_count": len(m5_test_results),
                    "sample_test_cases": m5_test_cases,
                    "sample_test_results": m5_test_results,
                    "integration_status": "success"
                }
            else:
                report_dict["m5_integration"] = {
                    "integration_status": "partial",
                    "message": "M5类不完整"
                }
                
        except Exception as e:
            report_dict["m5_integration"] = {
                "integration_status": "error",
                "message": str(e),
                "error_type": type(e).__name__
            }
        
        return report_dict

# ============ 命令行接口 ============

def main():
    """主函数"""
    print("=" * 60)
    print("证据覆盖率报告生成器")
    print("=" * 60)
    
    # 创建报告器
    reporter = EvidenceCoverageReporter()
    
    # 示例数据（实际应从文件或API获取）
    print("📝 生成示例评估数据...")
    
    example_evaluations = []
    for i in range(10):
        evaluation = AccuracyEvaluation(
            evaluation_id=f"eval_example_{i}",
            output_id=f"output_{i}",
            total_statements=5 + i,
            verified_statements=3 + i,
            unverified_statements=2,
            conflicting_statements=0 if i < 5 else 1,
            hallucinated_statements=0 if i < 8 else 1,
            expired_evidence_statements=0 if i < 3 else 1,
            evidence_coverage=0.5 + i * 0.05,
            confidence_score=0.6 + i * 0.03,
            hallucination_score=0.1 if i < 8 else 0.3,
            conflict_score=0.05 if i < 5 else 0.2,
            gate_decision=GateDecision.PASS if i < 7 else GateDecision.PASS_WITH_WARNING,
            decision_reason="示例数据",
            warnings=["示例警告"] if i % 3 == 0 else [],
            required_actions=[],
            statement_analysis=[],
            evidence_analysis=[]
        )
        example_evaluations.append(evaluation)
    
    # 生成报告
    print("📊 生成证据覆盖率报告...")
    report = reporter.generate_report(example_evaluations)
    
    # 输出摘要
    print("\n📈 报告摘要:")
    print(f"  评估数量: {report['total_evaluations']}")
    print(f"  总声明数: {report['total_statements']}")
    print(f"  已验证声明: {report['total_verified_statements']}")
    print(f"  平均证据覆盖率: {report['avg_evidence_coverage']:.1%}")
    print(f"  平均置信度: {report['avg_confidence_score']:.2f}")
    print(f"  决策分布: {json.dumps(report['decision_distribution'], ensure_ascii=False)}")
    
    if report['evidence_patterns']:
        print("\n🔍 证据模式分析:")
        for pattern in report['evidence_patterns'][:3]:  # 显示前3个
            print(f"  • {pattern['description']} (影响度: {pattern['impact_score']:.2f})")
    
    if report['recommendations']:
        print("\n💡 改进建议:")
        for rec in report['recommendations'][:5]:  # 显示前5个
            print(f"  • {rec}")
    
    print("\n" + "=" * 60)
    print("✅ 证据覆盖率报告生成完成")
    print("=" * 60)

# ============ 使用示例 ============

if __name__ == "__main__":
    # 检查是否在虚拟环境中
    try:
        import pandas as pd
        print("✅ pandas可用")
    except ImportError:
        print("⚠️ pandas不可用，部分功能受限")
    
    # 运行主函数
    main()