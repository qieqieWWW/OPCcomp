from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class SmallModelRouter:
    """Lightweight complexity scorer migrated from existing small-model routing logic."""

    def score_complexity(self, text: str) -> float:
        x = text or ""
        xl = x.lower()

        score = 2.0
        score += min(4.0, len(x) / 180.0)

        zh_signals = ["知识产权", "现金流", "合规", "架构", "跨境", "融资", "争议", "医疗"]
        en_signals = ["compliance", "regulatory", "cross-border", "fundraising", "risk", "legal", "medical"]
        score += 0.8 * sum(1 for t in zh_signals if t in x)
        score += 0.7 * sum(1 for t in en_signals if t in xl)

        if re.search(r"(goalusd\s*[:=]\s*\d+)", xl):
            score += 0.8
        if re.search(r"(durationdays\s*[:=]\s*\d+)", xl):
            score += 0.5

        return max(0.0, min(10.0, round(score, 2)))

    @staticmethod
    def tier_from_score(score: float) -> str:
        if score <= 3.5:
            return "L1"
        if score <= 6.8:
            return "L2"
        return "L3"
