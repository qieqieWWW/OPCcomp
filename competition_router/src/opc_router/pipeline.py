from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from .blender import fuse_rule_based, pairrank
from .info_pool import load_records, retrieve_from_info_pool
from .router import load_experts, route_experts_by_tier
from .service_client import AISV2Client
from .small_model import SmallModelRouter


@dataclass
class DynamicRoutingPipeline:
    project_root: Path
    service_host: str = "http://10.7.88.150:8080"
    service_model: str = "test"
    api_key: Optional[str] = None

    def __post_init__(self) -> None:
        self.small_model = SmallModelRouter()
        self.experts_path = self.project_root / "config" / "experts.json"
        self.info_pool_path = self.project_root / "config" / "info_pool.json"
        self.experts = load_experts(str(self.experts_path))
        self.info_pool = load_records(str(self.info_pool_path))
        self.client = AISV2Client(host=self.service_host, api_key=self.api_key, model=self.service_model)

    def _build_local_candidate(self, expert: Dict[str, Any], user_text: str, info_hits: List[Dict[str, Any]]) -> Dict[str, Any]:
        top_guidelines = [str(x.get("record", {}).get("guideline", "")) for x in info_hits[:2]]
        top_guidelines = [x for x in top_guidelines if x]

        parsed = {
            "risk_summary": f"{expert.get('role', '专家')}建议优先处理与输入相关的关键风险。",
            "actions": [
                {"title": "梳理关键风险清单", "owner": expert.get("name", "unknown"), "eta": "3d"},
                {"title": "制定分阶段执行计划", "owner": "ops_executor", "eta": "7d"},
            ],
            "alerts": ["若关键指标连续下滑，需触发紧急复盘"],
            "grounding": top_guidelines,
            "source_input": user_text,
        }
        return {"expert": expert, "parsed": parsed}

    def run(self, user_text: str, try_remote_llm: bool = False) -> Dict[str, Any]:
        score = self.small_model.score_complexity(user_text)
        tier = self.small_model.tier_from_score(score)
        selected_experts = route_experts_by_tier(tier, self.experts)

        info_hits = retrieve_from_info_pool(user_text, self.info_pool, top_k=3)

        candidates = [self._build_local_candidate(e, user_text, info_hits) for e in selected_experts]
        ranked = pairrank(candidates)
        fused = fuse_rule_based(ranked)

        remote = None
        if try_remote_llm:
            messages = [
                {"role": "system", "content": "你是路由融合助手，请根据给定融合结果输出简明决策建议。"},
                {"role": "user", "content": str(fused)},
            ]
            remote = self.client.chat(messages)

        return {
            "small_model": {"score": score, "tier": tier},
            "selected_experts": selected_experts,
            "info_pool_hits": info_hits,
            "ranked_candidates": ranked,
            "fused_result": fused,
            "remote_llm": remote,
        }
