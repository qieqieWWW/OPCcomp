from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar, Dict, Optional


def _as_bool(value: str) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class SmallModelRouter:
    """Small model router with optional Qwen+LoRA backend and heuristic fallback."""

    _shared_classifier: ClassVar[Any] = None
    _shared_backend: ClassVar[Optional[str]] = None
    _shared_backend_reason: ClassVar[Optional[str]] = None

    def __post_init__(self) -> None:
        self.backend = "heuristic"
        self.backend_reason = "heuristic-default"
        self._real_classifier: Any = None

        if self.__class__._shared_classifier is not None:
            self._real_classifier = self.__class__._shared_classifier
            self.backend = str(self.__class__._shared_backend or "heuristic")
            self.backend_reason = str(self.__class__._shared_backend_reason or "shared-cache")
            return

        use_real = _as_bool(os.getenv("USE_REAL_SMALL_MODEL", "true"))
        if not use_real:
            return
        os.environ.setdefault("USE_REAL_SMALL_MODEL", "true")

        # Ensure repo root is importable so scripts.classifier can be resolved.
        repo_root = Path(__file__).resolve().parents[4]
        if str(repo_root) not in os.sys.path:
            os.sys.path.insert(0, str(repo_root))

        # Use deploy-friendly relative defaults from repo root.
        os.environ.setdefault("QWEN3_BASE_PATH", "models/Qwen3-1.7B")
        os.environ.setdefault("ROUTER_ADAPTER_PATH", "scripts/training/output/adapter/adapter_model")

        try:
            from scripts.classifier import ComplexityClassifier

            original_cwd = Path.cwd()
            os.chdir(repo_root)
            try:
                self._real_classifier = ComplexityClassifier()
            finally:
                os.chdir(original_cwd)
            if getattr(self._real_classifier, "use_real_model", False):
                self.backend = "qwen3-lora"
                self.backend_reason = "USE_REAL_SMALL_MODEL=true and model loaded"
                self.__class__._shared_classifier = self._real_classifier
                self.__class__._shared_backend = self.backend
                self.__class__._shared_backend_reason = self.backend_reason
            else:
                self.backend = "heuristic"
                self.backend_reason = "classifier fallback to rule engine"
        except Exception as exc:  # pragma: no cover
            self.backend = "heuristic"
            self.backend_reason = f"failed to load real classifier: {exc}"

    def route(self, text: str) -> Dict[str, Any]:
        if self._real_classifier is not None:
            try:
                decision = self._real_classifier.classify(text)
                score = float(getattr(decision, "complexity_score", 0.0))
                tier = str(getattr(decision, "tier", "") or "")
                if tier not in {"L1", "L2", "L3"}:
                    tier = self.tier_from_score(score)
                return {
                    "score": max(0.0, min(10.0, round(score, 2))),
                    "tier": tier,
                    "backend": self.backend,
                    "backend_reason": self.backend_reason,
                }
            except Exception:
                pass

        score = self.score_complexity(text)
        return {
            "score": score,
            "tier": self.tier_from_score(score),
            "backend": "heuristic",
            "backend_reason": self.backend_reason,
        }

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
