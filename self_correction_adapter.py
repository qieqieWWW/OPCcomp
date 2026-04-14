#!/usr/bin/env python
# coding: utf-8

"""
自修正适配器 - 与pipeline/m9的集成接口

职责：
1. 提供易用的API给m9.py直接调用
2. 适配大模型调用接口（service_client）
3. 集成信息池检索
4. 管理self_correction_loop和相关组件的生命周期
"""

from __future__ import annotations

import os
import importlib
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from self_correction_loop import SelfCorrectionLoop, SelfCorrectionResult


class SelfCorrectionAdapter:
    """自修正适配器 - 简化API"""

    def __init__(
        self,
        gate,  # AccuracyGate
        service_client: Optional[Any] = None,  # service_client for LLM calls
        orchestrator: Optional[Any] = None,  # EvidenceOrchestrator
        info_pool: Optional[List[Dict[str, Any]]] = None,  # Info pool data
        max_iterations: int = 3,
        reference_date: Optional[str] = None,
    ):
        """
        Args:
            gate: AccuracyGate 实例
            service_client: 服务客户端（用于LLM调用）
            orchestrator: 证据编排器
            info_pool: 信息池数据
            max_iterations: 最大迭代次数
            reference_date: 参考日期 ISO format
        """
        self.gate = gate
        self.service_client = service_client
        self.orchestrator = orchestrator
        self.info_pool = info_pool or []
        self.max_iterations = max_iterations
        self.reference_date = reference_date

        # 定义信息池检索函数
        def retrieve_from_info_pool(query: str, top_k: int = 5) -> List[Dict[str, Any]]:
            """从信息池中检索相关信息；在缺少检索模块时安全退化为空列表。"""
            # 尝试动态导入 info_pool 检索实现，避免静态导入导致 IDE 报错
            _cos = None
            _vec = None
            try:
                imp = importlib.import_module("info_pool")
                _cos = getattr(imp, "_cos", None)
                _vec = getattr(imp, "_vec", None)
            except Exception:
                try:
                    imp = importlib.import_module("competition_router.src.opc_router.info_pool")
                    _cos = getattr(imp, "_cos", None)
                    _vec = getattr(imp, "_vec", None)
                except Exception:
                    _cos = None
                    _vec = None

            if not callable(_cos) or not callable(_vec):
                # 无法找到检索实现，返回空（安全退化）
                return []

            qv = _vec(query)
            scored: List[tuple] = []

            for rec in self.info_pool:
                text = " ".join([
                    str(rec.get("title", "")),
                    str(rec.get("industry", "")),
                    " ".join(str(k) for k in rec.get("keywords", []) if isinstance(k, str)),
                    str(rec.get("guideline", "")),
                ])
                try:
                    score = _cos(qv, _vec(text))
                except Exception:
                    score = 0
                if score > 0:
                    scored.append((score, rec))

            scored.sort(key=lambda x: x[0], reverse=True)
            return [{"score": round(float(s), 4), "record": r} for s, r in scored[:top_k]]

        self.info_pool_retriever = retrieve_from_info_pool

        # 定义LLM调用函数
        def llm_corrector(prompt: str) -> str:
            """调用大模型进行修正"""
            if not self.service_client:
                raise RuntimeError("Service client not configured")

            try:
                messages = [
                    {
                        "role": "system",
                        "content": "你是一个专业的答案修正助手，基于新信息对观点进行准确修正。",
                    },
                    {"role": "user", "content": prompt},
                ]
                response = self.service_client.chat(messages)
                
                # 适配不同的response格式
                if isinstance(response, str):
                    return response
                elif isinstance(response, dict):
                    return response.get("content", "") or response.get("text", "")
                else:
                    return str(response)
            except Exception as e:
                raise RuntimeError(f"LLM call failed: {e}")

        self.llm_corrector = llm_corrector

        # 创建自修正循环
        self.loop = SelfCorrectionLoop(
            gate=self.gate,
            orchestrator=self.orchestrator,
            llm_corrector=self.llm_corrector,
            info_pool_retriever=self.info_pool_retriever,
            max_iterations=max_iterations,
            reference_date=reference_date,
        )

    def correct(
        self,
        output: str,
        query: str,
        output_id: Optional[str] = None,
    ) -> SelfCorrectionResult:
        """
        执行自修正
        
        Args:
            output: 初始输出
            query: 用户查询
            output_id: 输出ID
            
        Returns:
            SelfCorrectionResult - 包含修正过程和最终结果
        """
        return self.loop.run(
            initial_output=output,
            query=query,
            output_id=output_id,
        )

    def should_trigger_correction(
        self,
        gate_evaluation: Any,
        enable_web_search: bool = True,
    ) -> bool:
        """
        判断是否应该触发自修正
        
        Args:
            gate_evaluation: AccuracyEvaluation 对象
            enable_web_search: 是否启用互联网搜索
            
        Returns:
            是否应该触发
        """
        from accuracy_gate import GateDecision

        # 条件1：gate检测到问题
        if gate_evaluation.gate_decision in [
            GateDecision.REJECT,
            GateDecision.REQUIRES_REVISION,
        ]:
            return True

        # 条件2：证据覆盖率低
        if gate_evaluation.evidence_coverage < 0.6:
            return True

        # 条件3：幻觉风险高
        if gate_evaluation.hallucination_score > 0.3:
            return True

        # 条件4：需要互联网（如果启用）
        if enable_web_search:
            should_query, _ = self.loop.freshness_checker.check_freshness()
            if should_query:
                return True

        return False


def create_adapter_for_m9(
    gate,
    service_client: Optional[Any] = None,
    orchestrator: Optional[Any] = None,
    info_pool: Optional[List[Dict[str, Any]]] = None,
    reference_date: Optional[str] = None,
) -> SelfCorrectionAdapter:
    """
    为 m9.py 创建自修正适配器
    
    Usage in m9.py:
        from self_correction_adapter import create_adapter_for_m9
        
        adapter = create_adapter_for_m9(
            gate=self.gate,
            service_client=self.client,
            orchestrator=self.orchestrator,
            info_pool=self.info_pool,
        )
        
        result = adapter.correct(output, query)
        final_output = result.final_output
        
        # 可选：记录修正过程
        if result.correction_applied:
            logger.info(f"修正成功，迭代{result.total_iterations}次")
    """
    return SelfCorrectionAdapter(
        gate=gate,
        service_client=service_client,
        orchestrator=orchestrator,
        info_pool=info_pool,
        reference_date=reference_date,
    )
