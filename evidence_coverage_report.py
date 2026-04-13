#!/usr/bin/env python
# coding: utf-8

"""
证据覆盖率报告生成器

对齐 accuracy_gate.py 的数据结构，输出:
1. 覆盖率/可回查率/冲突率/幻觉率统计
2. 决策分布与趋势
3. 与现有体系融合的改进建议
"""

from __future__ import annotations

import json
import statistics
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from accuracy_gate import AccuracyEvaluation, GateDecision


@dataclass
class EvidencePattern:
    pattern_type: str
    description: str
    impact_score: float
    metrics: Dict[str, Any] = field(default_factory=dict)
    suggestions: List[str] = field(default_factory=list)


@dataclass
class CoverageReport:
    report_id: str
    generated_at: str
    total_evaluations: int
    summary: Dict[str, Any]
    decision_distribution: Dict[str, int]
    patterns: List[EvidencePattern] = field(default_factory=list)
    recommendations: List[str] = field(default_factory=list)
    trends: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["patterns"] = [asdict(p) for p in self.patterns]
        return data


class EvidenceCoverageReporter:
    def __init__(self, output_dir: str = "reports/evidence_coverage"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def analyze_evaluations(self, evaluations: List[AccuracyEvaluation]) -> CoverageReport:
        if not evaluations:
            return CoverageReport(
                report_id=f"empty_{int(time.time())}",
                generated_at=datetime.now().isoformat(),
                total_evaluations=0,
                summary={
                    "avg_evidence_coverage": 0.0,
                    "avg_evidence_recall_rate": 0.0,
                    "avg_confidence_score": 0.0,
                    "avg_hallucination_score": 0.0,
                    "avg_conflict_score": 0.0,
                    "total_statements": 0,
                    "verified_statements": 0,
                    "unverified_statements": 0,
                },
                decision_distribution={},
                recommendations=["无评估数据，先执行 accuracy gate 评测"],
            )

        n = len(evaluations)
        summary = {
            "avg_evidence_coverage": statistics.mean(e.evidence_coverage for e in evaluations),
            "avg_evidence_recall_rate": statistics.mean(e.evidence_recall_rate for e in evaluations),
            "avg_confidence_score": statistics.mean(e.confidence_score for e in evaluations),
            "avg_hallucination_score": statistics.mean(e.hallucination_score for e in evaluations),
            "avg_conflict_score": statistics.mean(e.conflict_score for e in evaluations),
            "total_statements": sum(e.total_statements for e in evaluations),
            "verified_statements": sum(e.verified_statements for e in evaluations),
            "unverified_statements": sum(e.unverified_statements for e in evaluations),
        }

        decision_distribution: Dict[str, int] = {}
        for e in evaluations:
            key = e.gate_decision.value if isinstance(e.gate_decision, GateDecision) else str(e.gate_decision)
            decision_distribution[key] = decision_distribution.get(key, 0) + 1

        report = CoverageReport(
            report_id=f"cov_{int(time.time())}",
            generated_at=datetime.now().isoformat(),
            total_evaluations=n,
            summary=summary,
            decision_distribution=decision_distribution,
        )

        report.patterns = self._analyze_patterns(evaluations)
        report.trends = self._analyze_trends(evaluations)
        report.recommendations = self._build_recommendations(report)

        return report

    def _analyze_patterns(self, evaluations: List[AccuracyEvaluation]) -> List[EvidencePattern]:
        patterns: List[EvidencePattern] = []

        coverages = [e.evidence_coverage for e in evaluations]
        recalls = [e.evidence_recall_rate for e in evaluations]
        halls = [e.hallucination_score for e in evaluations]
        conflicts = [e.conflict_score for e in evaluations]

        if len(coverages) >= 2:
            cov_std = statistics.pstdev(coverages)
            if cov_std > 0.15:
                patterns.append(
                    EvidencePattern(
                        pattern_type="coverage_volatility",
                        description="证据覆盖率波动较大，上游证据编排稳定性不足",
                        impact_score=min(1.0, cov_std * 2),
                        metrics={"coverage_std": cov_std, "coverage_mean": statistics.mean(coverages)},
                        suggestions=[
                            "在融合层固定 claim -> evidence_ids 生成规则",
                            "按 agent 维度补齐 evidence_trace",
                        ],
                    )
                )

        high_hall_count = sum(1 for v in halls if v > 0.05)
        if high_hall_count > 0:
            patterns.append(
                EvidencePattern(
                    pattern_type="hallucination_risk",
                    description="存在无证据硬结论风险",
                    impact_score=min(1.0, high_hall_count / max(1, len(evaluations))),
                    metrics={"high_hallucination_samples": high_hall_count},
                    suggestions=[
                        "把 REJECT / REQUIRES_REVISION 接入主输出链路的降级分支",
                        "用户侧仅展示降级说明，内部保留证据缺口细节",
                    ],
                )
            )

        low_recall_count = sum(1 for v in recalls if v < 0.95)
        if low_recall_count > 0:
            patterns.append(
                EvidencePattern(
                    pattern_type="evidence_recall_gap",
                    description="evidence_id 可回查率未达95%",
                    impact_score=min(1.0, low_recall_count / max(1, len(evaluations))),
                    metrics={"low_recall_samples": low_recall_count},
                    suggestions=[
                        "统一 evidence_id 生成器，避免多命名体系",
                        "上线前做 evidence_lookup 批量回查",
                    ],
                )
            )

        high_conflict_count = sum(1 for v in conflicts if v > 0.0)
        if high_conflict_count > 0:
            patterns.append(
                EvidencePattern(
                    pattern_type="conflict_exposure",
                    description="存在冲突声明，需要强制显式提示",
                    impact_score=min(1.0, high_conflict_count / max(1, len(evaluations))),
                    metrics={"conflict_samples": high_conflict_count},
                    suggestions=[
                        "冲突时固定输出: 冲突说明 + 待验证项",
                        "禁止冲突场景单边拍板结论",
                    ],
                )
            )

        return patterns

    def _analyze_trends(self, evaluations: List[AccuracyEvaluation]) -> Dict[str, Any]:
        if len(evaluations) < 3:
            return {}

        def direction(series: List[float], higher_is_better: bool = True) -> str:
            first = statistics.mean(series[: len(series) // 2])
            second = statistics.mean(series[len(series) // 2 :])
            if higher_is_better:
                if second > first * 1.05:
                    return "improving"
                if second < first * 0.95:
                    return "declining"
            else:
                if second < first * 0.95:
                    return "improving"
                if second > first * 1.05:
                    return "declining"
            return "stable"

        coverage_series = [e.evidence_coverage for e in evaluations]
        recall_series = [e.evidence_recall_rate for e in evaluations]
        hall_series = [e.hallucination_score for e in evaluations]
        conflict_series = [e.conflict_score for e in evaluations]

        return {
            "coverage": direction(coverage_series, higher_is_better=True),
            "recall": direction(recall_series, higher_is_better=True),
            "hallucination": direction(hall_series, higher_is_better=False),
            "conflict": direction(conflict_series, higher_is_better=False),
            "series_tail": {
                "coverage": coverage_series[-5:],
                "recall": recall_series[-5:],
                "hallucination": hall_series[-5:],
                "conflict": conflict_series[-5:],
            },
        }

    def _build_recommendations(self, report: CoverageReport) -> List[str]:
        recs: List[str] = []
        s = report.summary
        n = max(1, report.total_evaluations)

        reject_rate = report.decision_distribution.get(GateDecision.REJECT.value, 0) / n
        warning_rate = report.decision_distribution.get(GateDecision.PASS_WITH_WARNING.value, 0) / n

        if s["avg_evidence_coverage"] < 0.9:
            recs.append("证据覆盖率低于90%，优先修复 claim 与 evidence_id 的绑定")
        if s["avg_evidence_recall_rate"] < 0.95:
            recs.append("可回查率低于95%，上线前必须跑 evidence_lookup 回查清单")
        if s["avg_hallucination_score"] > 0.05:
            recs.append("无证据硬结论比例偏高，建议加严 reject 门槛")
        if s["avg_conflict_score"] > 0.0:
            recs.append("存在冲突输出，需将冲突显式率拉到100%")
        if reject_rate > 0.3:
            recs.append("拒绝率超过30%，应先提升证据编排质量再扩流")
        if warning_rate > 0.4:
            recs.append("警告通过比例较高，建议在融合层做预检去除低质样本")

        if not recs:
            recs.append("指标整体健康，可进入更大样本量回归")

        recs.append("保持竞赛侧 agent 结构不变，只做评分增强与证据补强")
        return recs

    def save_report(self, report: CoverageReport, file_name: Optional[str] = None) -> str:
        if not file_name:
            file_name = f"evidence_coverage_{int(time.time())}.json"
        out_file = self.output_dir / file_name
        out_file.write_text(json.dumps(report.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        return str(out_file)

    def generate_report(self, evaluations: List[AccuracyEvaluation]) -> Dict[str, Any]:
        report = self.analyze_evaluations(evaluations)
        path = self.save_report(report)
        data = report.to_dict()
        data["saved_path"] = path
        return data


# 兼容旧调用

def generate_evidence_coverage_report(evaluations: List[AccuracyEvaluation], output_dir: str = "reports") -> Dict[str, Any]:
    reporter = EvidenceCoverageReporter(output_dir=output_dir)
    return reporter.generate_report(evaluations)


def _demo() -> None:
    now = time.time()
    sample = [
        AccuracyEvaluation(
            evaluation_id="e1",
            output_id="o1",
            timestamp=now,
            total_statements=5,
            verified_statements=5,
            unverified_statements=0,
            conflicting_statements=0,
            hallucinated_statements=0,
            expired_evidence_statements=0,
            evidence_coverage=1.0,
            evidence_recall_rate=1.0,
            confidence_score=0.95,
            hallucination_score=0.0,
            conflict_score=0.0,
            gate_decision=GateDecision.PASS,
            decision_reason="ok",
        ),
        AccuracyEvaluation(
            evaluation_id="e2",
            output_id="o2",
            timestamp=now,
            total_statements=5,
            verified_statements=3,
            unverified_statements=2,
            conflicting_statements=1,
            hallucinated_statements=1,
            expired_evidence_statements=0,
            evidence_coverage=0.6,
            evidence_recall_rate=0.7,
            confidence_score=0.62,
            hallucination_score=0.2,
            conflict_score=0.2,
            gate_decision=GateDecision.REQUIRES_REVISION,
            decision_reason="conflict",
        ),
    ]

    reporter = EvidenceCoverageReporter()
    result = reporter.generate_report(sample)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    _demo()
