from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List


def load_experts(experts_path: str) -> List[Dict[str, str]]:
    p = Path(experts_path)
    with p.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return [x for x in data if isinstance(x, dict)]


def route_experts_by_tier(tier: str, experts: List[Dict[str, str]]) -> List[Dict[str, str]]:
    emap = {str(e.get("name", "")): e for e in experts}

    if tier == "L3":
        names = ["risk_guardian", "finance_advisor", "ops_executor"]
    elif tier == "L2":
        names = ["finance_advisor", "ops_executor", "growth_strategist"]
    else:
        names = ["growth_strategist", "ops_executor"]

    return [emap[n] for n in names if n in emap]
