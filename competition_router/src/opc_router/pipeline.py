from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from .blender import fuse_rule_based, pairrank
from .info_pool import load_records, retrieve_from_info_pool
from .router import load_experts, route_experts_by_tier
from .service_client import build_client
from .small_model import SmallModelRouter


@dataclass
class DynamicRoutingPipeline:
    project_root: Path
    provider: str = "qianfan"
    service_host: str = "http://10.7.88.150:8080"
    service_base_url: Optional[str] = None
    service_model: str = "test"
    api_key: Optional[str] = None

    def __post_init__(self) -> None:
        self.small_model = SmallModelRouter()
        self.experts_path = self.project_root / "config" / "experts.json"
        self.prompts_dir = self.project_root.parent / "openclaw-runtime" / "prompts"
        self.info_pool_path = self.project_root / "config" / "info_pool.json"
        self.experts = load_experts(str(self.experts_path), prompts_dir=str(self.prompts_dir))
        self.info_pool = load_records(str(self.info_pool_path))
        self.client = build_client(
            self.provider,
            host=self.service_host,
            base_url=self.service_base_url,
            api_key=self.api_key,
            model=self.service_model,
        )

    def _build_local_candidate(self, expert: Dict[str, Any], user_text: str, info_hits: List[Dict[str, Any]]) -> Dict[str, Any]:
        top_guidelines = [str(x.get("record", {}).get("guideline", "")) for x in info_hits[:2]]
        top_guidelines = [x for x in top_guidelines if x]
        expert_name = str(expert.get("name", "unknown"))
        deps = expert.get("depends_on") if isinstance(expert.get("depends_on"), list) else []
        dep_text = "、".join(str(x) for x in deps) if deps else "无"

        parsed = {
            "risk_summary": f"{expert.get('role', '专家')}建议优先处理与输入相关的关键风险（依赖：{dep_text}）。",
            "actions": [
                {"title": "梳理关键风险清单", "owner": expert_name, "eta": "3d"},
                {"title": "制定分阶段执行计划", "owner": "strategy_agent", "eta": "7d"},
            ],
            "alerts": ["若关键指标连续下滑，需触发紧急复盘"],
            "grounding": top_guidelines,
            "source_input": user_text,
            "dependencies": deps,
        }
        return {"expert": expert, "parsed": parsed}

    def _build_collaboration_plan(self, selected_experts: List[Dict[str, Any]]) -> Dict[str, Any]:
        names = [str(e.get("name", "")) for e in selected_experts]
        nodes = [
            {
                "name": str(e.get("name", "")),
                "role": str(e.get("role", "")),
                "phase": str(e.get("collab_phase", "")),
                "depends_on": e.get("depends_on", []),
            }
            for e in selected_experts
        ]

        edges: List[Dict[str, str]] = []

        def add_edge(source: str, target: str, relation: str) -> None:
            if source in names and target in names:
                edges.append({"from": source, "to": target, "relation": relation})

        add_edge("strategy_agent", "research_agent", "co-analyze")
        add_edge("research_agent", "strategy_agent", "feasibility-feedback")
        add_edge("strategy_agent", "market_agent", "handoff-plan")
        add_edge("research_agent", "market_agent", "handoff-product-insight")
        add_edge("market_agent", "sales_agent", "execute-go-to-market")

        if "legal_agent" in names:
            for upstream in ["strategy_agent", "research_agent", "market_agent", "sales_agent"]:
                add_edge(upstream, "legal_agent", "compliance-request")

        return {
            "mode": "dynamic-bypass-enabled",
            "frontline": [x for x in ["strategy_agent", "research_agent"] if x in names],
            "execution": [x for x in ["market_agent", "sales_agent"] if x in names],
            "support": [x for x in ["legal_agent"] if x in names],
            "nodes": nodes,
            "edges": edges,
        }

    def _build_output_attribution(self, remote_called: bool, remote_available: bool) -> Dict[str, Any]:
        return {
            "small_model": {
                "source": "small-model-router",
                "description": "由 SmallModelRouter 计算复杂度分数与分层 tier",
            },
            "selected_experts": {
                "source": "router-rule-engine",
                "description": "由分层路由与协作规则选择执行 agents",
            },
            "collaboration_plan": {
                "source": "router-rule-engine",
                "description": "由协作规则生成前排/执行/支撑结构与协作边",
            },
            "info_pool_hits": {
                "source": "info-pool-retriever",
                "description": "由本地信息池检索召回 grounding",
            },
            "ranked_candidates": {
                "source": "local-agent-simulator+pairrank",
                "description": "由本地 agent 候选生成与 PairRank 排序得到",
            },
            "fused_result": {
                "source": "rule-based-fuser",
                "description": "由规则融合器整合多个候选结果",
            },
            "remote_llm": {
                "source": "remote-llm" if remote_available else "not-invoked",
                "description": "可选远程大模型摘要（仅 try_remote_llm=true 时调用）",
                "called": remote_called,
            },
        }

    def run(self, user_text: str, try_remote_llm: bool = False) -> Dict[str, Any]:
        small_model_result = self.small_model.route(user_text)
        score = float(small_model_result.get("score", 0.0))
        tier = str(small_model_result.get("tier", "L1"))
        selected_experts = route_experts_by_tier(tier, self.experts, user_text=user_text)

        info_hits = retrieve_from_info_pool(user_text, self.info_pool, top_k=3)

        candidates = [self._build_local_candidate(e, user_text, info_hits) for e in selected_experts]
        ranked = pairrank(candidates)
        fused = fuse_rule_based(ranked)

        remote = None
        remote_called = bool(try_remote_llm)
        if try_remote_llm:
            messages = [
                {"role": "system", "content": "你是路由融合助手，请根据给定融合结果输出简明决策建议。"},
                {"role": "user", "content": str(fused)},
            ]
            remote = self.client.chat(messages)

        return {
            "small_model": {
                "score": score,
                "tier": tier,
                "backend": small_model_result.get("backend", "heuristic"),
                "backend_reason": small_model_result.get("backend_reason", ""),
            },
            "selected_experts": selected_experts,
            "collaboration_plan": self._build_collaboration_plan(selected_experts),
            "info_pool_hits": info_hits,
            "ranked_candidates": ranked,
            "fused_result": fused,
            "remote_llm": remote,
            "output_attribution": self._build_output_attribution(remote_called=remote_called, remote_available=remote is not None),
            "runtime_trace": {
                "small_model_called": True,
                "small_model_callsite": "pipeline.run -> SmallModelRouter.route",
                "small_model_backend": small_model_result.get("backend", "heuristic"),
                "small_model_backend_reason": small_model_result.get("backend_reason", ""),
                "remote_llm_called": remote_called,
                "remote_llm_callsite": "pipeline.run -> self.client.chat",
                "provider": self.provider,
                "model": self.service_model,
            },
        }
