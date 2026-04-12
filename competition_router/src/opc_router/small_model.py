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
    """Small model router with strict Qwen+LoRA-only behavior (no template fallback)."""

    _shared_classifier: ClassVar[Any] = None
    _shared_backend: ClassVar[Optional[str]] = None
    _shared_backend_reason: ClassVar[Optional[str]] = None

    def __post_init__(self) -> None:
        self.backend = "uninitialized"
        self.backend_reason = "uninitialized"
        self._real_classifier: Any = None
        self._debug_raw_output = _as_bool(os.getenv("SMALL_MODEL_DEBUG_RAW_OUTPUT", "true"))

        if self.__class__._shared_classifier is not None:
            self._real_classifier = self.__class__._shared_classifier
            self.backend = str(self.__class__._shared_backend or "qwen3-lora")
            self.backend_reason = str(self.__class__._shared_backend_reason or "shared-cache")
            return

        use_real = _as_bool(os.getenv("USE_REAL_SMALL_MODEL", "true"))
        if not use_real:
            raise RuntimeError("USE_REAL_SMALL_MODEL=false，不允许回退模式。")
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
                raise RuntimeError("小模型未成功加载，拒绝回退到规则引擎。")
        except Exception as exc:  # pragma: no cover
            raise RuntimeError(f"小模型加载失败: {exc}") from exc

    def route(self, text: str) -> Dict[str, Any]:
        if self._real_classifier is None:
            raise RuntimeError("小模型未就绪，无法进行 route。")

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

    def generate_reply(self, text: str) -> str:
        if self._real_classifier is None:
            raise RuntimeError("小模型未就绪，无法生成会话回复。")

        reply = self._generate_model_reply(text)
        if not reply:
            raise RuntimeError("小模型未生成有效会话回复。")
        return reply

    def infer_intent(self, text: str, route_result: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        normalized = (text or "").strip()
        if not normalized:
            return {
                "type": "conversation_query",
                "confidence": 0.99,
                "reason": "empty_text",
            }

        if self._real_classifier is not None:
            try:
                parsed = self._generate_model_intent(normalized)
                intent_type = str(parsed.get("intent_type", "")).strip().lower()
                if intent_type not in {"conversation_query", "task_request"}:
                    raise ValueError("invalid intent_type")

                confidence = float(parsed.get("confidence", 0.75))
                confidence = max(0.05, min(0.99, round(confidence, 4)))
                reason = str(parsed.get("reason", "small-model-intent"))
                return {
                    "type": intent_type,
                    "confidence": confidence,
                    "reason": reason,
                }
            except Exception as exc:
                raise RuntimeError(f"小模型意图识别失败: {exc}") from exc

        raise RuntimeError("小模型未就绪，无法识别意图。")

    def _generate_model_intent(self, text: str) -> Dict[str, Any]:
        if self._real_classifier is None:
            raise ValueError("classifier not loaded")

        model = getattr(self._real_classifier, "model", None)
        tokenizer = getattr(self._real_classifier, "tokenizer", None)
        if model is None or tokenizer is None:
            raise ValueError("model/tokenizer unavailable")

        import torch

        prompt = (
            "<|im_start|>system\n"
            "你是意图识别器。"
            "请严格输出三行，不要输出其它内容："
            "intent_type=<conversation_query|task_request>"
            "confidence=<0到1的小数>"
            "reason=<简短原因>"
            "不要输出 <think>。"
            "<|im_end|>\n"
            f"<|im_start|>user\n{text}\n<|im_end|>\n"
            "<|im_start|>assistant\n"
        )

        model_device = next(model.parameters()).device
        inputs = tokenizer(prompt, return_tensors="pt").to(model_device)

        with torch.no_grad():
            outputs = model.generate(
                **inputs,
                max_new_tokens=256,
                do_sample=False,
                pad_token_id=tokenizer.eos_token_id,
            )

        generated_tokens = outputs[0][inputs["input_ids"].shape[1]:]
        raw = tokenizer.decode(generated_tokens, skip_special_tokens=False)
        cleaned = self._clean_reply(raw)
        self._log_model_output("intent", raw, cleaned)
        parsed = self._parse_intent_from_text(cleaned)
        if parsed is None:
            raise ValueError("intent payload missing")

        intent_type = parsed["intent_type"]
        confidence = parsed["confidence"]
        reason = parsed["reason"]

        return {
            "intent_type": intent_type,
            "confidence": confidence,
            "reason": reason,
        }

    def _generate_model_reply(self, text: str) -> str:
        if self._real_classifier is None:
            return ""

        model = getattr(self._real_classifier, "model", None)
        tokenizer = getattr(self._real_classifier, "tokenizer", None)
        if model is None or tokenizer is None:
            return ""

        import torch

        prompt = (
            "<|im_start|>system\n"
            "你是一个简洁、自然、友好的中文聊天助手。"
            "请只输出给用户看的最终回复。"
            "不要复述用户问题，不要输出过程性表达，不要输出 <think>。"
            "不要输出 <think>。"
            "<|im_end|>\n"
            f"<|im_start|>user\n{text.strip()}\n<|im_end|>\n"
            "<|im_start|>assistant\n"
        )

        model_device = next(model.parameters()).device
        inputs = tokenizer(prompt, return_tensors="pt").to(model_device)

        generation_kwargs: Dict[str, Any] = {
            "max_new_tokens": 256,
            "do_sample": True,
            "temperature": 0.85,
            "top_p": 0.9,
            "pad_token_id": tokenizer.eos_token_id,
        }

        with torch.no_grad():
            outputs = model.generate(**inputs, **generation_kwargs)

        generated_tokens = outputs[0][inputs["input_ids"].shape[1]:]
        raw = tokenizer.decode(generated_tokens, skip_special_tokens=False)
        cleaned = self._clean_reply(raw)
        self._log_model_output("reply", raw, cleaned)
        reply = cleaned
        if not reply:
            raise RuntimeError("聊天回复为空")
        if self._debug_raw_output:
            print(f"[small-model][reply-final] {reply}")
        return reply

    def _clean_reply(self, reply: str) -> str:
        cleaned = (reply or "").strip()
        if not cleaned:
            return ""

        # Remove both closed and unclosed think blocks to prevent reasoning leakage.
        cleaned = re.sub(r"<think>[\s\S]*?(</think>|$)", "", cleaned, flags=re.IGNORECASE)
        cleaned = cleaned.replace("</think>", " ")
        cleaned = cleaned.replace("<|endoftext|>", " ")
        cleaned = cleaned.replace("<|im_start|>", " ").replace("<|im_end|>", " ")
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
        return cleaned.strip()

    def _parse_intent_from_text(self, text: str) -> Optional[Dict[str, Any]]:
        m_type = re.search(r"intent_type\s*[=:]\s*(conversation_query|task_request)", text, flags=re.IGNORECASE)
        if not m_type:
            m_type = re.search(r"\b(conversation_query|task_request)\b", text, flags=re.IGNORECASE)
        if not m_type:
            return None

        intent_type = m_type.group(1).strip().lower()
        confidence = 0.75
        m_conf = re.search(r"confidence\s*[=:]\s*([0-9]*\.?[0-9]+)", text, flags=re.IGNORECASE)
        if m_conf:
            try:
                confidence = float(m_conf.group(1))
            except Exception:
                confidence = 0.75
        confidence = max(0.05, min(0.99, round(confidence, 4)))

        m_reason = re.search(r"reason\s*[=:]\s*(.+)$", text, flags=re.IGNORECASE)
        reason = m_reason.group(1).strip()[:50] if m_reason else "small-model-intent"
        reason = reason or "small-model-intent"

        return {
            "intent_type": intent_type,
            "confidence": confidence,
            "reason": reason,
        }

    def _extract_plain_sentence(self, text: str) -> str:
        return self._clean_reply(text)

    def _log_model_output(self, stage: str, raw: str, cleaned: str) -> None:
        if not self._debug_raw_output:
            return
        print(f"[small-model][{stage}-raw] <<<")
        print(raw)
        print(f"[small-model][{stage}-raw] >>>")
        print(f"[small-model][{stage}-clean] {cleaned}")

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
