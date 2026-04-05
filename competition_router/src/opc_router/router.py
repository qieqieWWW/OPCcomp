from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Set


LEGAL_KEYWORDS = ["合规", "法规", "监管", "资质", "证书", "许可", "legal", "compliance", "regulatory", "license", "cross-border", "跨境"]


def _contains_any(text: str, keywords: List[str]) -> bool:
    lowered = text.lower()
    for kw in keywords:
        if kw.lower() in lowered:
            return True
    return False


def _forced_agents_from_text(user_text: str, experts: List[Dict[str, str]]) -> Set[str]:
    alias_map = {
        "strategy_agent": ["strategy_agent", "战略", "战略部", "strategy"],
        "research_agent": ["research_agent", "研发", "研发部", "research", "r&d"],
        "market_agent": ["market_agent", "市场", "市场部", "market", "marketing"],
        "sales_agent": ["sales_agent", "销售", "销售部", "sales"],
        "legal_agent": ["legal_agent", "法务", "法务部", "legal", "compliance"],
    }
    text = user_text.lower()
    names = {str(e.get("name", "")) for e in experts}
    forced: Set[str] = set()
    for agent_name, aliases in alias_map.items():
        if agent_name not in names:
            continue
        if any(alias.lower() in text for alias in aliases):
            forced.add(agent_name)
    return forced


def _need_legal_agent(user_text: str, experts: List[Dict[str, str]]) -> bool:
    if _contains_any(user_text, LEGAL_KEYWORDS):
        return True
    for expert in experts:
        if str(expert.get("name", "")) != "legal_agent":
            continue
        kws = expert.get("keywords")
        if isinstance(kws, list) and _contains_any(user_text, [str(x) for x in kws]):
            return True
    return False


def load_experts(experts_path: str, prompts_dir: str | None = None) -> List[Dict[str, str]]:
    p = Path(experts_path)
    with p.open("r", encoding="utf-8") as f:
        data = json.load(f)
    experts = [x for x in data if isinstance(x, dict)]

    if not prompts_dir:
        return experts

    prompt_root = Path(prompts_dir)
    for expert in experts:
        prompt_file = str(expert.get("prompt_file") or "").strip()
        if not prompt_file:
            continue
        prompt_path = prompt_root / prompt_file
        if not prompt_path.exists():
            continue
        expert["system_prompt"] = prompt_path.read_text(encoding="utf-8").strip()

    return experts


def route_experts_by_tier(tier: str, experts: List[Dict[str, str]], user_text: str = "") -> List[Dict[str, str]]:
    emap = {str(e.get("name", "")): e for e in experts}
    frontline = ["strategy_agent", "research_agent"]
    execution = ["market_agent", "sales_agent"]

    if tier == "L3":
        names = frontline + execution
    elif tier == "L2":
        names = frontline + execution
    else:
        names = frontline + ["market_agent"]

    if _need_legal_agent(user_text, experts):
        names = frontline + ["legal_agent"] + [n for n in names if n not in frontline]

    forced = _forced_agents_from_text(user_text, experts)
    for name in forced:
        if name not in names:
            names.append(name)

    ordered_unique: List[str] = []
    for n in names:
        if n in emap and n not in ordered_unique:
            ordered_unique.append(n)

    return [emap[n] for n in ordered_unique]
