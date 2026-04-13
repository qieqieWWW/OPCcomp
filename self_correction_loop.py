#!/usr/bin/env python
# coding: utf-8

"""
自修正迭代循环 - 基于互联网证据的观点修正

功能：
1. 检测原始观点与互联网证据的冲突
2. 生成修正指令给大模型重新生成答案
3. 验证修正后的答案是否通过质量门
4. 支持多轮迭代直到通过或达到上限
5. 集成信息池作为补充证据源
6. 完整记录整个过程便于审计

时效性支持：
- 基于知识库/模型更新周期决定是否查询
- 知识库（180天）、图谱（90天）、模型（120天）
- 当前时间指定，支持灵活的时效判断

工作流：
    
    初始输出（来自fusion layer）
         ↓
    [时效性检查] 决定是否需要互联网证据
         ↓
    [收集证据] 信息池 + web_retriever
         ↓
    [冲突分析] 检测矛盾点
         ↓
    [判断] 需要修正？
         ├─ 否 → 直接返回原输出
         └─ 是 → [修正指令生成]
                  ↓
              [调用LLM] 生成修正答案
                  ↓
              [gate验证] 检测新答案质量
                  ↓
              [判断] 通过？
                  ├─ 是 → 返回修正答案
                  └─ 否 & 迭代<N → 循环修正
                      ↓
                    返回最后一次结果
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

# 假设这些模块已存在
from accuracy_gate import AccuracyEvaluation, GateDecision, Evidence, EvidenceStatus, ConfidenceLevel
from evidence_orchestrator import EvidenceOrchestrator, EvidenceRequest, OrchestrationResult


# =========================
# Enum & Data Models
# =========================

class CorrectionReason(str, Enum):
    """修正原因"""
    NO_CORRECTION_NEEDED = "no_correction_needed"
    LOW_COVERAGE = "low_evidence_coverage"
    HIGH_HALLUCINATION = "high_hallucination_risk"
    INTERNAL_CONFLICT = "internal_conflict_detected"
    EXTERNAL_CONFLICT = "external_conflict_detected"
    OUTDATED_KNOWLEDGE = "outdated_knowledge"


class FreshnessLevel(str, Enum):
    """信息新鲜度"""
    VERY_FRESH = "very_fresh"  # < 1 month
    FRESH = "fresh"  # 1-3 months
    STALE = "stale"  # 3-6 months
    VERY_STALE = "very_stale"  # > 6 months


@dataclass
class KnowledgeSourceMetadata:
    """知识源元数据"""
    source_name: str  # "knowledge_base", "knowledge_graph", "model", "rules"
    last_update_date: str  # ISO format: "2025-10-13"
    update_cycle_days: int  # How often it's updated
    freshness_threshold_days: int  # When to consider it stale

    def get_freshness(self, reference_date: str) -> FreshnessLevel:
        """
        基于参考日期评估新鲜度
        Args:
            reference_date: ISO format "2026-04-13"
        """
        try:
            last = datetime.fromisoformat(self.last_update_date).date()
            ref = datetime.fromisoformat(reference_date).date()
            days_old = (ref - last).days
        except Exception:
            return FreshnessLevel.STALE

        if days_old <= 30:
            return FreshnessLevel.VERY_FRESH
        elif days_old <= 90:
            return FreshnessLevel.FRESH
        elif days_old <= 180:
            return FreshnessLevel.STALE
        else:
            return FreshnessLevel.VERY_STALE


@dataclass
class ConflictReport:
    """冲突分析报告"""
    has_conflict: bool
    conflict_type: str  # "no_conflict", "internal", "external", "outdated"
    conflict_points: List[str] = field(default_factory=list)
    supporting_evidence: List[str] = field(default_factory=list)
    contradicting_evidence: List[str] = field(default_factory=list)
    confidence_in_conflict: float = 0.5  # 0-1 冲突置信度
    suggestions: List[str] = field(default_factory=list)


@dataclass
class CorrectionIteration:
    """修正迭代记录"""
    iteration_number: int
    original_output: str
    correction_reason: CorrectionReason
    conflict_report: ConflictReport
    correction_prompt: str  # 发给LLM的修正指令
    corrected_output: str
    gate_evaluation: Optional[AccuracyEvaluation]
    success: bool  # 是否通过gate验证
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["gate_evaluation"] = asdict(self.gate_evaluation) if self.gate_evaluation else None
        return data


@dataclass
class SelfCorrectionResult:
    """自修正最终结果"""
    original_output: str
    final_output: str
    iterations: List[CorrectionIteration] = field(default_factory=list)
    total_iterations: int = 0
    correction_applied: bool = False
    final_gate_decision: GateDecision = GateDecision.PASS
    web_evidence_used: bool = False
    info_pool_evidence_used: bool = False
    execution_time_ms: float = 0.0


# =========================
# Core Components
# =========================

class TemporalFreshnessChecker:
    """时效性检查器 - 基于更新周期决定何时查询互联网"""

    def __init__(self, reference_date: Optional[str] = None):
        """
        Args:
            reference_date: ISO format, e.g., "2026-04-13"
                          如果为None，使用当前日期
        """
        self.reference_date = reference_date or datetime.now().strftime("%Y-%m-%d")

        # 定义知识源的更新周期
        self.knowledge_sources = {
            "knowledge_base": KnowledgeSourceMetadata(
                source_name="knowledge_base",
                last_update_date="2025-10-13",  # 假设上次更新
                update_cycle_days=180,  # 半年更新一次
                freshness_threshold_days=180
            ),
            "knowledge_graph": KnowledgeSourceMetadata(
                source_name="knowledge_graph",
                last_update_date="2026-01-13",
                update_cycle_days=90,  # 三个月更新
                freshness_threshold_days=90
            ),
            "model": KnowledgeSourceMetadata(
                source_name="model",
                last_update_date="2025-12-13",
                update_cycle_days=120,  # 四个月训练周期
                freshness_threshold_days=120
            ),
            "rules": KnowledgeSourceMetadata(
                source_name="rules",
                last_update_date="2026-03-13",
                update_cycle_days=60,  # 两个月更新
                freshness_threshold_days=60
            )
        }

    def check_freshness(self, topic: str = "general") -> Tuple[bool, Dict[str, Any]]:
        """
        检查知识新鲜度，决定是否需要互联网查询
        
        Returns:
            (should_query_web, freshness_report)
        """
        freshness_report = {}
        should_query = False

        for source_name, metadata in self.knowledge_sources.items():
            freshness = metadata.get_freshness(self.reference_date)
            freshness_report[source_name] = {
                "freshness": freshness.value,
                "last_update": metadata.last_update_date,
                "update_cycle_days": metadata.update_cycle_days,
            }

            # 如果任何源过期，建议查询
            if freshness in [FreshnessLevel.STALE, FreshnessLevel.VERY_STALE]:
                should_query = True

        return should_query, freshness_report

    def get_recommendation(self) -> str:
        """获取人类可读的建议"""
        should_query, report = self.check_freshness()

        if should_query:
            stale_sources = [
                s for s, r in report.items()
                if r["freshness"] in ["stale", "very_stale"]
            ]
            return f"以下知识源已过期：{', '.join(stale_sources)}，建议查询互联网获取最新信息"
        else:
            return "当前知识源足够新鲜，可以直接使用本地数据"


class ConflictAnalyzer:
    """冲突分析器 - 检测原始观点与证据的矛盾"""

    def __init__(self, logger: Optional[logging.Logger] = None):
        self.logger = logger or logging.getLogger(__name__)

    def analyze(
        self,
        original_output: str,
        evidence_list: List[Evidence],
        info_pool_evidence: Optional[List[Dict[str, Any]]] = None,
    ) -> ConflictReport:
        """
        分析冲突
        
        Args:
            original_output: 原始观点/答案
            evidence_list: Web 证据列表
            info_pool_evidence: 信息池证据
            
        Returns:
            ConflictReport
        """
        supporting = []
        contradicting = []
        conflict_points = []

        # 简单的冲突检测：关键词匹配
        output_lower = original_output.lower()

        for ev in evidence_list:
            if not ev.content:
                continue

            ev_lower = ev.content.lower()

            # 检查是否支持或矛盾
            support_score = self._calculate_support_score(output_lower, ev_lower)

            if support_score > 0.7:
                supporting.append(ev.evidence_id)
                self.logger.debug(
                    f"Supporting evidence: {ev.evidence_id} (score: {support_score:.2f})"
                )
            elif support_score < 0.3:
                contradicting.append(ev.evidence_id)
                conflict_points.append(
                    f"{ev.evidence_id}: 互联网信息与观点不符"
                )
                self.logger.warning(
                    f"Contradicting evidence: {ev.evidence_id} (score: {support_score:.2f})"
                )

        # 信息池证据检查
        if info_pool_evidence:
            for pool_ev in info_pool_evidence:
                guideline = str(pool_ev.get("guideline", "")).lower()
                if guideline:
                    pool_support = self._calculate_support_score(output_lower, guideline)
                    if pool_support > 0.7:
                        supporting.append(f"pool_{pool_ev.get('title', 'unknown')}")

        has_conflict = len(contradicting) > 0

        return ConflictReport(
            has_conflict=has_conflict,
            conflict_type="external_conflict" if contradicting else "no_conflict",
            conflict_points=conflict_points,
            supporting_evidence=supporting,
            contradicting_evidence=contradicting,
            confidence_in_conflict=len(contradicting) / max(1, len(evidence_list)),
            suggestions=self._generate_suggestions(contradicting, supporting),
        )

    @staticmethod
    def _calculate_support_score(output: str, evidence: str) -> float:
        """简单的支持度打分（基于关键词重叠）"""
        output_words = set(w for w in output.split() if len(w) > 3)
        evidence_words = set(w for w in evidence.split() if len(w) > 3)

        if not output_words or not evidence_words:
            return 0.5

        overlap = len(output_words & evidence_words)
        support = overlap / max(len(output_words), len(evidence_words))
        return support

    @staticmethod
    def _generate_suggestions(contradicting: List[str], supporting: List[str]) -> List[str]:
        """生成修正建议"""
        suggestions = []

        if contradicting:
            suggestions.append(
                f"互联网上有{len(contradicting)}条信息与你的观点不符，需要修正"
            )
        if not supporting and contradicting:
            suggestions.append("当前没有足够的支持证据，强烈建议重新考虑观点")
        if len(supporting) > 0 and len(contradicting) > 0:
            suggestions.append("对比观点与互联网信息，寻找折衷方案")

        return suggestions


class CorrectionInstructor:
    """修正指令生成器 - 为LLM生成修正prompt"""

    def generate(
        self,
        original_output: str,
        conflict_report: ConflictReport,
        evidence_list: List[Evidence],
        freshness_check: Dict[str, Any],
    ) -> str:
        """
        生成修正指令
        
        Returns:
            修正prompt
        """
        instruction = f"""
【自修正任务】
你之前给出的观点需要根据最新信息进行修正。

【原始观点】
{original_output}

【冲突分析】
{self._format_conflict_report(conflict_report)}

【最新互联网信息】
{self._format_evidence_list(evidence_list)}

【知识新鲜度状态】
{self._format_freshness_check(freshness_check)}

【修正要求】
1. 基于上述冲突信息，重新审视你的观点
2. 如果互联网信息更新鲜，优先采纳
3. 保留原观点中正确的部分，修正错误的部分
4. 说明修正的原因和依据
5. 确保最终答案更加准确、可信、可执行

【修正输出格式】
修正版观点：[新的观点]
修正原因：[为什么要修正]
关键变化：[与原观点的主要差异]
"""
        return instruction

    @staticmethod
    def _format_conflict_report(report: ConflictReport) -> str:
        if not report.has_conflict:
            return "✓ 没有检测到冲突，观点基本可信"

        text = f"""⚠️ 检测到冲突：
- 冲突类型：{report.conflict_type}
- 冲突点数：{len(report.conflict_points)}
- 支持证据：{len(report.supporting_evidence)} 条
- 矛盾证据：{len(report.contradicting_evidence)} 条
- 冲突置信度：{report.confidence_in_conflict:.1%}

冲突详情：
"""
        for point in report.conflict_points[:5]:  # 最多显示5个
            text += f"  - {point}\n"

        text += "\n建议：\n"
        for suggestion in report.suggestions[:3]:
            text += f"  - {suggestion}\n"

        return text

    @staticmethod
    def _format_evidence_list(evidence_list: List[Evidence]) -> str:
        if not evidence_list:
            return "（无新信息）"

        text = ""
        for i, ev in enumerate(evidence_list[:5], 1):  # 最多显示5条
            reliability = ev.metadata.get("reliability_score", 0.5)
            text += f"\n[证据{i}] {ev.source_name}\n"
            text += f"  来源：{ev.source_url or 'N/A'}\n"
            text += f"  可靠性：{'高' if reliability > 0.8 else '中' if reliability > 0.6 else '低'}\n"
            text += f"  内容：{ev.content[:100]}...\n"

        return text

    @staticmethod
    def _format_freshness_check(freshness_check: Dict[str, Any]) -> str:
        text = ""
        for source, info in freshness_check.items():
            freshness = info.get("freshness", "unknown")
            text += f"- {source}: {freshness} (上次更新：{info.get('last_update', 'N/A')})\n"
        return text


class WebSearchLogger:
    """透明日志系统 - 记录所有互联网查询活动"""

    def __init__(self, log_dir: str = "./web_search_logs"):
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)

        # 配置日志
        self.logger = logging.getLogger("WebSearchLogger")
        self.logger.setLevel(logging.DEBUG)

        # 文件处理器 - 记录详细日志
        log_file = self.log_dir / f"web_search_{datetime.now().strftime('%Y%m%d')}.log"
        fh = logging.FileHandler(log_file, encoding="utf-8")
        fh.setLevel(logging.DEBUG)

        # 控制台处理器
        ch = logging.StreamHandler()
        ch.setLevel(logging.INFO)

        # 格式器
        formatter = logging.Formatter(
            "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
        )
        fh.setFormatter(formatter)
        ch.setFormatter(formatter)

        self.logger.addHandler(fh)
        self.logger.addHandler(ch)

    def log_freshness_check(self, report: Dict[str, Any], reference_date: str):
        """记录新鲜度检查"""
        self.logger.info(f"=== 时效性检查 ({reference_date}) ===")
        for source, info in report.items():
            self.logger.info(f"{source}: {info['freshness']} (最后更新: {info['last_update']})")

    def log_web_search_triggered(self, reason: str, evidence_count: int):
        """记录网络搜索触发"""
        self.logger.info(f">>> 触发互联网查询 | 原因: {reason} | 获取证据: {evidence_count}条")

    def log_conflict_analysis(self, report: ConflictReport):
        """记录冲突分析"""
        self.logger.info(f">>> 冲突分析 | 结果: {report.conflict_type} | 支持: {len(report.supporting_evidence)}, 矛盾: {len(report.contradicting_evidence)}")

    def log_correction_iteration(self, iteration: CorrectionIteration):
        """记录修正迭代"""
        status = "✓ 通过" if iteration.success else "✗ 未通过"
        self.logger.info(
            f">>> 修正迭代 #{iteration.iteration_number} | 原因: {iteration.correction_reason.value} | 结果: {status}"
        )

    def log_final_result(self, result: SelfCorrectionResult):
        """记录最终结果"""
        self.logger.info("=" * 60)
        self.logger.info("最终结果")
        self.logger.info("=" * 60)
        self.logger.info(f"修正应用: {'是' if result.correction_applied else '否'}")
        self.logger.info(f"总迭代数: {result.total_iterations}")
        self.logger.info(f"最终决策: {result.final_gate_decision.value}")
        self.logger.info(f"执行时间: {result.execution_time_ms:.2f}ms")
        self.logger.info(f"Web证据: {'是' if result.web_evidence_used else '否'}")
        self.logger.info(f"信息池: {'是' if result.info_pool_evidence_used else '否'}")

    def export_json(self, result: SelfCorrectionResult, filename: Optional[str] = None):
        """导出为JSON用于审计"""
        if not filename:
            filename = f"correction_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"

        filepath = self.log_dir / filename

        export_data = {
            "timestamp": datetime.now().isoformat(),
            "original_output": result.original_output,
            "final_output": result.final_output,
            "iterations": [it.to_dict() for it in result.iterations],
            "summary": {
                "total_iterations": result.total_iterations,
                "correction_applied": result.correction_applied,
                "final_decision": result.final_gate_decision.value,
                "execution_time_ms": result.execution_time_ms,
                "web_evidence": result.web_evidence_used,
                "info_pool": result.info_pool_evidence_used,
            }
        }

        with filepath.open("w", encoding="utf-8") as f:
            json.dump(export_data, f, ensure_ascii=False, indent=2)

        self.logger.info(f"✓ 审计日志已导出: {filepath}")


class SelfCorrectionLoop:
    """自修正迭代循环 - 主控制器"""

    def __init__(
        self,
        gate,  # AccuracyGate instance
        orchestrator: Optional[EvidenceOrchestrator] = None,
        llm_corrector: Optional[Callable] = None,  # 调用大模型的函数
        info_pool_retriever: Optional[Callable] = None,  # 信息池检索函数
        max_iterations: int = 3,
        reference_date: Optional[str] = None,
    ):
        """
        Args:
            gate: AccuracyGate 实例
            orchestrator: EvidenceOrchestrator 实例
            llm_corrector: Callable(prompt) -> corrected_output
            info_pool_retriever: Callable(query, top_k) -> List[Dict]
            max_iterations: 最大迭代次数
            reference_date: 参考日期 ISO format，用于时效性检查
        """
        self.gate = gate
        self.orchestrator = orchestrator
        self.llm_corrector = llm_corrector
        self.info_pool_retriever = info_pool_retriever
        self.max_iterations = max_iterations
        self.reference_date = reference_date or datetime.now().strftime("%Y-%m-%d")

        # 组件初始化
        self.freshness_checker = TemporalFreshnessChecker(self.reference_date)
        self.conflict_analyzer = ConflictAnalyzer()
        self.correction_instructor = CorrectionInstructor()
        self.logger = WebSearchLogger()

    def run(
        self,
        initial_output: str,
        query: str,
        output_id: Optional[str] = None,
        request_type: str = "task",
    ) -> SelfCorrectionResult:
        """
        执行自修正循环
        
        Args:
            initial_output: 初始输出
            query: 用户查询
            output_id: 输出ID
            request_type: 请求类型，task 表示任务请求，chat 表示闲聊/非任务请求
            
        Returns:
            SelfCorrectionResult
        """
        start_time = time.time()
        output_id = output_id or f"output_{int(time.time())}"

        result = SelfCorrectionResult(
            original_output=initial_output,
            final_output=initial_output,
        )

        # Step 1: 时效性检查 + 请求类型策略
        should_query, freshness_report = self.freshness_checker.check_freshness()
        normalized_request_type = (request_type or "task").strip().lower()
        if normalized_request_type in {"task", "task_request", "request", "work"}:
            should_query = True
            search_policy = "task_forces_web_search"
        else:
            search_policy = "chat_on_demand"
        self.logger.log_freshness_check(freshness_report, self.reference_date)

        self.logger.logger.info(f"请求类型: {normalized_request_type or 'task'} | 搜索策略: {search_policy}")

        if not should_query and not self.orchestrator:
            self.logger.logger.info("知识足够新鲜，且无编排器，跳过修正")
            result.execution_time_ms = (time.time() - start_time) * 1000
            return result

        # Step 2: 收集证据（信息池 + 互联网）
        evidence_list = []
        info_pool_evidence = []

        # 从信息池获取
        if self.info_pool_retriever:
            try:
                info_pool_evidence = self.info_pool_retriever(query, top_k=5)
                result.info_pool_evidence_used = len(info_pool_evidence) > 0
                self.logger.logger.info(f"从信息池获取 {len(info_pool_evidence)} 条证据")
            except Exception as e:
                self.logger.logger.warning(f"信息池检索失败: {e}")

        # 从互联网获取
        if should_query and self.orchestrator:
            try:
                request = EvidenceRequest(
                    query=query,
                    query_category="general",
                    allow_web_search=True,
                )
                orch_result = self.orchestrator.orchestrate(request)
                evidence_list = orch_result.total_evidence
                result.web_evidence_used = len(evidence_list) > 0
                if normalized_request_type in {"task", "task_request", "request", "work"}:
                    trigger_reason = "任务请求默认联网佐证与修正"
                else:
                    trigger_reason = f"知识过期（{', '.join([s for s, r in freshness_report.items() if r['freshness'] in ['stale', 'very_stale']])}）"
                self.logger.log_web_search_triggered(trigger_reason, len(evidence_list))
            except Exception as e:
                self.logger.logger.warning(f"互联网搜索失败: {e}")

        # Step 3: 冲突分析
        conflict_report = self.conflict_analyzer.analyze(
            initial_output,
            evidence_list,
            info_pool_evidence,
        )
        self.logger.log_conflict_analysis(conflict_report)

        if not conflict_report.has_conflict and not should_query:
            self.logger.logger.info("无冲突且知识足够新鲜，不需要修正")
            result.execution_time_ms = (time.time() - start_time) * 1000
            return result

        # Step 4: 决定是否需要修正
        needs_correction = conflict_report.has_conflict or should_query

        if not needs_correction or not self.llm_corrector:
            result.execution_time_ms = (time.time() - start_time) * 1000
            self.logger.logger.info("不需要修正或LLM不可用")
            return result

        # Step 5: 迭代修正
        current_output = initial_output
        result.correction_applied = True

        for iteration_num in range(1, self.max_iterations + 1):
            # 生成修正指令
            correction_prompt = self.correction_instructor.generate(
                current_output,
                conflict_report,
                evidence_list,
                freshness_report,
            )

            # 调用LLM
            try:
                corrected_output = self.llm_corrector(correction_prompt)
            except Exception as e:
                self.logger.logger.error(f"LLM调用失败: {e}")
                break

            # 验证修正后的答案
            try:
                gate_eval = self.gate.check_output(corrected_output, output_id)
            except Exception as e:
                self.logger.logger.warning(f"Gate验证失败: {e}")
                gate_eval = None

            success = gate_eval and gate_eval.gate_decision in [
                GateDecision.PASS,
                GateDecision.PASS_WITH_WARNING,
            ]

            # 记录迭代
            iteration = CorrectionIteration(
                iteration_number=iteration_num,
                original_output=current_output,
                correction_reason=CorrectionReason.EXTERNAL_CONFLICT if conflict_report.has_conflict else CorrectionReason.OUTDATED_KNOWLEDGE,
                conflict_report=conflict_report,
                correction_prompt=correction_prompt,
                corrected_output=corrected_output,
                gate_evaluation=gate_eval,
                success=success,
            )
            result.iterations.append(iteration)
            self.logger.log_correction_iteration(iteration)

            if success:
                current_output = corrected_output
                result.final_output = corrected_output
                result.final_gate_decision = gate_eval.gate_decision
                break
            else:
                current_output = corrected_output
                result.final_output = corrected_output
                if gate_eval:
                    result.final_gate_decision = gate_eval.gate_decision

        result.total_iterations = len(result.iterations)
        result.execution_time_ms = (time.time() - start_time) * 1000

        # 记录最终结果
        self.logger.log_final_result(result)
        self.logger.export_json(result)

        return result
