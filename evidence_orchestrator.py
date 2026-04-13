#!/usr/bin/env python
# coding: utf-8

"""
证据编排器 - 内部优先、外部补盲

核心逻辑：
1. 内部证据池（知识图谱 + info_pool）优先使用
2. 检测证据充分性 → 不足时触发网络检索
3. 融合内部外部证据 → 生成统一 Evidence List
4. 按来源优先级排序，供融合层消费

工作流：
    orchestrator = EvidenceOrchestrator(
        kb_retriever=retrieve_from_knowledge_graph,  # 内部KB检索
        info_pool_retriever=retrieve_from_info_pool,  # info_pool检索
        web_retriever=WebRetriever(...)  # 外部网络检索
    )
    
    evidence_list = orchestrator.orchestrate(
        query="Kickstarter融资成功率",
        output_claims=["成功率约为37%", "融资主要来自..."],
        context={"domain": "crowdfunding", "risk_level": "medium"}
    )
    # returns: List[Evidence] - 已排序，内部优先
"""

from __future__ import annotations

import hashlib
import time
from collections import Counter
from dataclasses import dataclass, asdict
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Tuple

from accuracy_gate import Evidence, EvidenceStatus


class EvidenceSource(str, Enum):
    """证据来源层级"""
    INTERNAL_KB = "internal_kb"  # 内部知识库 - 优先级最高
    INFO_POOL = "info_pool"  # 规则/指南池 - 优先级次高
    WEB_SEARCH = "web_search"  # 网络搜索 - 优先级最低
    INFERENCE = "inference"  # 推断 - 风险最高


@dataclass
class EvidenceRequest:
    """证据编排请求"""
    query: str
    output_claims: List[str] = None
    query_category: str = "general"  # "financial", "legal", "technical", etc.
    required_evidence_count: int = 3
    min_evidence_coverage: float = 0.7
    allow_web_search: bool = True
    context: Dict[str, Any] = None


@dataclass
class OrchestrationResult:
    """编排结果"""
    internal_evidence: List[Evidence]
    external_evidence: List[Evidence]
    total_evidence: List[Evidence]
    coverage_score: float
    orchestration_quality: float
    search_triggered: bool
    notes: List[str]


class EvidenceSufficiencyAnalyzer:
    """证据充分性分析 - 判断是否需要补充外部证据"""

    def __init__(self):
        self.min_for_high_confidence = 4
        self.min_for_medium_confidence = 2
        self.min_coverage = 0.65

    def analyze_sufficiency(
        self,
        internal_evidence: List[Evidence],
        output_claims: Optional[List[str]] = None,
        query_category: str = "general",
    ) -> Tuple[bool, float, str]:
        """
        分析证据是否充分
        
        Returns:
            (should_search, coverage_score, reason)
        """
        if not internal_evidence:
            return True, 0.0, "无内部证据，建议网络搜索"

        # 计算覆盖率：内部证据数量 / 输出声明数量
        claim_count = len(output_claims) if output_claims else 3
        coverage = min(1.0, len(internal_evidence) / max(1, claim_count))

        # 根据类别调整阈值
        if query_category in ["legal", "financial"]:
            min_required = self.min_for_high_confidence
            min_coverage = 0.75
        elif query_category in ["technical"]:
            min_required = self.min_for_medium_confidence
            min_coverage = 0.65
        else:
            min_required = self.min_for_medium_confidence
            min_coverage = self.min_coverage

        # 判断是否需要补充
        should_search = (
            len(internal_evidence) < min_required
            or coverage < min_coverage
        )

        if should_search:
            reason = (
                f"覆盖率{coverage:.1%}<{min_coverage:.1%} "
                f"(内部证据{len(internal_evidence)}/{min_required})"
            )
        else:
            reason = f"证据充分: 覆盖率{coverage:.1%}, 计数{len(internal_evidence)}/{min_required}"

        return should_search, coverage, reason

    def estimate_coverage(self, evidence: List[Evidence]) -> float:
        """估算证据覆盖率 0-1"""
        if not evidence:
            return 0.0

        # 来源多样性得分
        sources = set(ev.source_name for ev in evidence)
        source_diversity = min(1.0, len(sources) / 3.0)

        # 时效性得分
        now = time.time()
        recency_scores = []
        for ev in evidence:
            age_days = (now - ev.timestamp) / (24 * 3600)
            if age_days <= 7:
                recency_scores.append(1.0)
            elif age_days <= 30:
                recency_scores.append(0.7)
            elif age_days <= 365:
                recency_scores.append(0.4)
            else:
                recency_scores.append(0.2)
        recency = sum(recency_scores) / len(recency_scores) if recency_scores else 0.5

        # 综合覆盖率
        coverage = 0.4 * min(1.0, len(evidence) / 4) + 0.3 * source_diversity + 0.3 * recency
        return round(coverage, 3)


class EvidenceOrchestrator:
    """
    证据编排 - 统一管理多源证据的检索和融合
    """

    def __init__(
        self,
        kb_retriever: Optional[Callable] = None,
        info_pool_retriever: Optional[Callable] = None,
        web_retriever: Optional[Any] = None,  # WebRetriever instance
        enable_deduplication: bool = True,
    ):
        """
        Args:
            kb_retriever: Callable(query: str, top_k: int) -> List[Evidence]
            info_pool_retriever: Callable(query: str, top_k: int) -> List[Evidence]
            web_retriever: WebRetriever instance
        """
        self.kb_retriever = kb_retriever
        self.info_pool_retriever = info_pool_retriever
        self.web_retriever = web_retriever
        self.enable_dedup = enable_deduplication
        self.sufficiency_analyzer = EvidenceSufficiencyAnalyzer()

    def orchestrate(
        self,
        request: EvidenceRequest,
    ) -> OrchestrationResult:
        """
        执行证据编排 - 完整流程
        
        Args:
            request: EvidenceRequest
            
        Returns:
            OrchestrationResult
        """
        notes = []

        # Step 1: 检索内部证据
        internal_evidence = self._retrieve_internal_evidence(
            request.query,
            request.query_category
        )
        notes.append(f"内部证据: {len(internal_evidence)}")

        # Step 2: 分析充分性
        should_search, coverage, reason = self.sufficiency_analyzer.analyze_sufficiency(
            internal_evidence,
            request.output_claims,
            request.query_category,
        )
        notes.append(reason)

        # Step 3: 必要时检索外部证据
        external_evidence = []
        search_triggered = False

        if should_search and request.allow_web_search and self.web_retriever:
            external_evidence = self._retrieve_external_evidence(
                request.query,
                len(internal_evidence),
                request.query_category,
            )
            search_triggered = True
            notes.append(f"触发网络检索: {len(external_evidence)}")

        # Step 4: 融合去重
        all_evidence = internal_evidence + external_evidence
        if self.enable_dedup:
            all_evidence = self._deduplicate_evidence(all_evidence)
            notes.append(f"去重后: {len(all_evidence)}")

        # Step 5: 排序 - 优先级排序
        all_evidence = self._rank_evidence(all_evidence)

        # Step 6: 计算质量指标
        final_coverage = self.sufficiency_analyzer.estimate_coverage(all_evidence)
        orchestration_quality = self._compute_quality_score(
            all_evidence,
            internal_evidence,
            external_evidence,
        )

        return OrchestrationResult(
            internal_evidence=internal_evidence,
            external_evidence=external_evidence,
            total_evidence=all_evidence,
            coverage_score=final_coverage,
            orchestration_quality=orchestration_quality,
            search_triggered=search_triggered,
            notes=notes,
        )

    def _retrieve_internal_evidence(
        self,
        query: str,
        category: str,
    ) -> List[Evidence]:
        """检索内部证据源"""
        evidence = []

        # 从知识库检索
        if self.kb_retriever:
            try:
                kb_results = self.kb_retriever(query, top_k=3)
                if isinstance(kb_results, list):
                    evidence.extend(kb_results)
            except Exception as e:
                pass

        # 从 info_pool 检索
        if self.info_pool_retriever:
            try:
                pool_results = self.info_pool_retriever(query, top_k=3)
                if isinstance(pool_results, list):
                    evidence.extend(pool_results)
            except Exception as e:
                pass

        return evidence

    def _retrieve_external_evidence(
        self,
        query: str,
        internal_count: int,
        category: str,
    ) -> List[Evidence]:
        """检索外部证据（网络搜索）"""
        if not self.web_retriever:
            return []

        try:
            # 根据内部证据数量调整外部检索数量
            if internal_count == 0:
                top_k = 5
            elif internal_count < 2:
                top_k = 3
            else:
                top_k = 2

            evidence = self.web_retriever.search_for_evidence(
                query=query,
                evidence_coverage=self.sufficiency_analyzer.estimate_coverage([]),
                evidence_type=category,
                top_k=top_k,
                force_refresh=False,
            )
            return evidence or []
        except Exception as e:
            return []

    def _deduplicate_evidence(self, evidence_list: List[Evidence]) -> List[Evidence]:
        """证据去重 - 基于内容相似度和URL"""
        if not evidence_list:
            return []

        # 按 source_url 去重（完全重复）
        seen_urls = set()
        deduped = []

        for ev in evidence_list:
            url_key = (ev.source_url or ev.source_name, ev.evidence_id)
            if url_key not in seen_urls:
                seen_urls.add(url_key)
                deduped.append(ev)

        # 基于内容相似度的近似去重（简单版）
        final = []
        seen_hashes = set()

        for ev in deduped:
            # 内容哈希
            content_hash = hashlib.md5(
                (ev.content[:100] + ev.source_name).encode("utf-8")
            ).hexdigest()

            if content_hash not in seen_hashes:
                seen_hashes.add(content_hash)
                final.append(ev)

        return final

    def _rank_evidence(self, evidence_list: List[Evidence]) -> List[Evidence]:
        """按优先级排序证据"""
        def priority_key(ev: Evidence) -> Tuple[int, float, float]:
            # 优先级 1: 来源 (KB > info_pool > web_search)
            source_priority = {
                EvidenceSource.INTERNAL_KB.value: 0,
                EvidenceSource.INFO_POOL.value: 1,
                EvidenceSource.WEB_SEARCH.value: 2,
                "internal_kb": 0,
                "info_pool": 1,
                "web_search": 2,
                "knowledge_graph": 0,
                "rules": 1,
            }
            source_rank = source_priority.get(
                ev.metadata.get("source_category", ev.source_type),
                2
            )

            # 优先级 2: 可信度
            confidence_priority = {
                "high": 0,
                "medium": 1,
                "low": 2,
                "very_low": 3,
            }
            confidence_rank = confidence_priority.get(
                ev.confidence.value if hasattr(ev.confidence, 'value') else str(ev.confidence).lower(),
                2
            )

            # 优先级 3: 时效性（新的优先）
            age_hours = (time.time() - ev.timestamp) / 3600
            recency_score = max(0, 100 - age_hours / 24)  # 越新越好

            return (source_rank, confidence_rank, -recency_score)

        return sorted(evidence_list, key=priority_key)

    def _compute_quality_score(
        self,
        total: List[Evidence],
        internal: List[Evidence],
        external: List[Evidence],
    ) -> float:
        """计算编排质量分数"""
        if not total:
            return 0.0

        # 来源多样性
        sources = Counter(ev.source_type for ev in total)
        diversity = min(1.0, len(sources) / 3)

        # 内外平衡
        if len(total) > 0:
            internal_ratio = len(internal) / len(total)
            # 优先内部证据，但也需要外部补充
            balance = 1.0 if 0.6 <= internal_ratio <= 0.95 else 0.7

        # 可信度
        high_confidence = sum(
            1 for ev in total
            if hasattr(ev.confidence, 'value') and ev.confidence.value == 'high'
            or str(ev.confidence).lower() == 'high'
        )
        confidence_score = min(1.0, high_confidence / max(1, len(total) * 0.8))

        # 综合评分
        quality = 0.3 * diversity + 0.4 * balance + 0.3 * confidence_score
        return round(quality, 3)


# =========================
# Integration Helpers
# =========================

def create_orchestrator_for_pipeline(
    pipeline_config: Dict[str, Any],
) -> EvidenceOrchestrator:
    """
    为 DynamicRoutingPipeline 创建编排器
    
    Args:
        pipeline_config: 包含 kb_retriever, info_pool_retriever 等配置
        
    Returns:
        EvidenceOrchestrator.orchestrate 可直接调用
    """
    from web_retriever import WebRetriever

    web_retriever = None
    if pipeline_config.get("enable_web_search", True):
        web_retriever = WebRetriever(
            api_key=pipeline_config.get("web_api_key"),
            engine=pipeline_config.get("web_engine", "mock"),
            cache_dir=pipeline_config.get("web_cache_dir", "./web_cache"),
        )

    return EvidenceOrchestrator(
        kb_retriever=pipeline_config.get("kb_retriever"),
        info_pool_retriever=pipeline_config.get("info_pool_retriever"),
        web_retriever=web_retriever,
        enable_deduplication=True,
    )


def format_orchestration_result_for_fusion(
    result: OrchestrationResult,
) -> Dict[str, Any]:
    """
    格式化编排结果供融合层使用
    
    Returns:
        {
            "evidence_list": [Evidence dict],
            "evidence_map": {evidence_id: Evidence},
            "evidence_pool": {source_type: [Evidence]},
            "stats": {coverage, quality, search_triggered, ...}
        }
    """
    from accuracy_gate import asdict

    evidence_map = {ev.evidence_id: ev for ev in result.total_evidence}
    evidence_pool = {}

    for ev in result.total_evidence:
        source_type = ev.source_type
        if source_type not in evidence_pool:
            evidence_pool[source_type] = []
        evidence_pool[source_type].append(ev)

    return {
        "evidence_list": [asdict(ev) for ev in result.total_evidence],
        "evidence_map": {k: asdict(v) for k, v in evidence_map.items()},
        "evidence_pool": {
            k: [asdict(ev) for ev in v]
            for k, v in evidence_pool.items()
        },
        "orchestration_stats": {
            "total_count": len(result.total_evidence),
            "internal_count": len(result.internal_evidence),
            "external_count": len(result.external_evidence),
            "coverage_score": result.coverage_score,
            "orchestration_quality": result.orchestration_quality,
            "search_triggered": result.search_triggered,
            "notes": result.notes,
        }
    }
