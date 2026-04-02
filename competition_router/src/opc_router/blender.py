from __future__ import annotations

from typing import Any, Dict, List, Tuple


def _quality(candidate: Dict[str, Any]) -> float:
    parsed = candidate.get("parsed", {}) if isinstance(candidate.get("parsed"), dict) else {}
    actions = parsed.get("actions", []) if isinstance(parsed.get("actions"), list) else []
    alerts = parsed.get("alerts", []) if isinstance(parsed.get("alerts"), list) else []
    summary = str(parsed.get("risk_summary", "")).strip()

    score = 0.2
    if summary:
        score += 0.25
    score += min(0.3, 0.08 * len(actions))
    score += min(0.15, 0.05 * len(alerts))
    return max(0.0, min(1.0, round(score, 4)))


def pairrank(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not candidates:
        return []

    base = [_quality(c) for c in candidates]
    wins = [0] * len(candidates)

    for i in range(len(candidates)):
        for j in range(i + 1, len(candidates)):
            if base[i] >= base[j]:
                wins[i] += 1
            else:
                wins[j] += 1

    ranked: List[Tuple[float, Dict[str, Any], int]] = []
    for idx, c in enumerate(candidates):
        pair = wins[idx] / max(1, len(candidates) - 1)
        score = round(0.55 * base[idx] + 0.45 * pair, 4)
        cc = dict(c)
        cc["pairrank"] = {"score": score, "wins": wins[idx], "base_quality": base[idx]}
        ranked.append((score, cc, wins[idx]))

    ranked.sort(key=lambda x: x[0], reverse=True)
    return [item[1] for item in ranked]


def fuse_rule_based(ranked: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not ranked:
        return {
            "fused_risk_summary": "",
            "fused_actions": [],
            "fused_alerts": [],
            "source_experts": [],
            "fusion_method": "rule_based",
            "fusion_confidence": 0.0,
        }

    summaries: List[str] = []
    actions: List[Dict[str, Any]] = []
    alerts: List[str] = []
    experts: List[str] = []

    for c in ranked:
        parsed = c.get("parsed", {}) if isinstance(c.get("parsed"), dict) else {}
        s = str(parsed.get("risk_summary", "")).strip()
        if s:
            summaries.append(s)
        acts = parsed.get("actions", [])
        if isinstance(acts, list):
            actions.extend(a for a in acts if isinstance(a, dict))
        als = parsed.get("alerts", [])
        if isinstance(als, list):
            alerts.extend(str(a).strip() for a in als if str(a).strip())
        expert = c.get("expert", {})
        if isinstance(expert, dict) and expert.get("name"):
            experts.append(str(expert["name"]))

    dedup_actions: List[Dict[str, Any]] = []
    seen_titles = set()
    for a in actions:
        t = str(a.get("title", "")).strip().lower()
        if not t or t in seen_titles:
            continue
        seen_titles.add(t)
        dedup_actions.append(a)
        if len(dedup_actions) >= 6:
            break

    fused_summary = "；".join(dict.fromkeys(summaries))[:500]
    top_score = float(ranked[0].get("pairrank", {}).get("score", 0.5))
    confidence = round(max(0.0, min(0.99, 0.55 + 0.4 * top_score)), 4)

    return {
        "fused_risk_summary": fused_summary,
        "fused_actions": dedup_actions,
        "fused_alerts": list(dict.fromkeys(alerts))[:6],
        "source_experts": list(dict.fromkeys(experts)),
        "fusion_method": "rule_based",
        "fusion_confidence": confidence,
    }
