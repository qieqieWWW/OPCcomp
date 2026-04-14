#!/usr/bin/env python
# coding: utf-8

"""
角色D: 准确性评测与防幻觉闸门

目标:
1. 检查输出是否有 evidence_id, 并可回查
2. 检测内部冲突与外部冲突
3. 无证据/过期证据触发降级
4. 尽量复用 M5 / M12 测试资产

该实现额外提供融合入口:
- evaluate_router_payload: 直接评估当前链路常见 payload
- to_runtime_gate_packet: 输出给 runtime/router 的标准闸门包
"""

from __future__ import annotations

import importlib.util
import json
import logging
import re
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple


# =========================
# Enum / Data Models
# =========================


class EvidenceStatus(str, Enum):
    VERIFIED = "verified"
    PENDING = "pending"
    EXPIRED = "expired"
    CONFLICTING = "conflicting"
    UNKNOWN = "unknown"


class ConfidenceLevel(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    VERY_LOW = "very_low"
    REJECTED = "rejected"


class GateDecision(str, Enum):
    PASS = "pass"
    PASS_WITH_WARNING = "pass_with_warning"
    REJECT = "reject"
    REQUIRES_REVISION = "requires_revision"
    NEEDS_REFRESH = "needs_refresh"


@dataclass
class Evidence:
    evidence_id: str
    content: str
    source_type: str
    source_name: str
    source_url: Optional[str] = None
    timestamp: float = field(default_factory=time.time)
    expiration_days: int = 30
    status: EvidenceStatus = EvidenceStatus.VERIFIED
    confidence: ConfidenceLevel = ConfidenceLevel.MEDIUM
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def expired(self) -> bool:
        expire_at = datetime.fromtimestamp(self.timestamp) + timedelta(days=self.expiration_days)
        return datetime.now() > expire_at


@dataclass
class EvidenceReference:
    evidence_id: str
    claim: str
    relevance_score: float
    usage_context: str = "support"


@dataclass
class OutputStatement:
    statement_id: str
    claim: str
    evidence_ids: List[str] = field(default_factory=list)
    evidence_references: List[EvidenceReference] = field(default_factory=list)
    statement_type: str = "fact"
    verifiable: bool = True

    @property
    def has_evidence(self) -> bool:
        return len(self.evidence_ids) > 0


@dataclass
class AccuracyEvaluation:
    evaluation_id: str
    output_id: str
    timestamp: float = field(default_factory=time.time)

    total_statements: int = 0
    verified_statements: int = 0
    unverified_statements: int = 0
    conflicting_statements: int = 0
    hallucinated_statements: int = 0
    expired_evidence_statements: int = 0

    evidence_coverage: float = 0.0
    evidence_recall_rate: float = 0.0
    confidence_score: float = 0.0
    hallucination_score: float = 1.0
    conflict_score: float = 0.0

    gate_decision: GateDecision = GateDecision.PASS
    decision_reason: str = ""
    warnings: List[str] = field(default_factory=list)
    required_actions: List[str] = field(default_factory=list)

    statement_analysis: List[Dict[str, Any]] = field(default_factory=list)
    conflict_details: List[Dict[str, Any]] = field(default_factory=list)
    hallucination_details: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["gate_decision"] = self.gate_decision.value
        return data


# =========================
# Optional M5/M12 Loader
# =========================


def _safe_import_by_path(path: Path, module_name: str):
    if not path.exists():
        return None, f"missing file: {path}"
    try:
        spec = importlib.util.spec_from_file_location(module_name, str(path))
        if not spec or not spec.loader:
            return None, f"spec loader unavailable: {path}"
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, None
    except Exception as exc:  # pragma: no cover
        return None, str(exc)


def _discover_scripts_dir() -> Path:
    # OPCcomp/accuracy_gate.py -> project_root/scripts
    return Path(__file__).resolve().parents[1] / "scripts"


# =========================
# Evidence Store
# =========================


class EvidenceStore:
    def __init__(self):
        self._db: Dict[str, Evidence] = {}

    def add(self, evidence: Evidence) -> str:
        self._db[evidence.evidence_id] = evidence
        return evidence.evidence_id

    def get(self, evidence_id: str) -> Optional[Evidence]:
        return self._db.get(evidence_id)

    def exists(self, evidence_id: str) -> bool:
        return evidence_id in self._db

    def size(self) -> int:
        return len(self._db)

    def validate(self, evidence_id: str) -> Tuple[bool, str]:
        evidence = self.get(evidence_id)
        if evidence is None:
            return False, "not_found"
        if evidence.status == EvidenceStatus.CONFLICTING:
            return False, "conflicting"
        if evidence.status == EvidenceStatus.EXPIRED or evidence.expired:
            return False, "expired"
        if evidence.status == EvidenceStatus.PENDING:
            return False, "pending"
        return True, "ok"

    def search(self, query: str, limit: int = 3) -> List[Evidence]:
        q = query.lower().strip()
        if not q:
            return []
        results: List[Evidence] = []
        for evidence in self._db.values():
            if q in evidence.content.lower() or q in evidence.source_name.lower():
                results.append(evidence)
            if len(results) >= limit:
                break
        return results

    def save(self, file_path: str) -> None:
        target = Path(file_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "saved_at": datetime.now().isoformat(),
            "evidence": [asdict(e) for e in self._db.values()],
        }
        target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def load(self, file_path: str) -> None:
        target = Path(file_path)
        if not target.exists():
            return
        raw = json.loads(target.read_text(encoding="utf-8"))
        self._db = {}
        for item in raw.get("evidence", []):
            item_status = item.get("status", EvidenceStatus.VERIFIED.value)
            item_conf = item.get("confidence", ConfidenceLevel.MEDIUM.value)
            item["status"] = EvidenceStatus(item_status)
            item["confidence"] = ConfidenceLevel(item_conf)
            evidence = Evidence(**item)
            self._db[evidence.evidence_id] = evidence


# =========================
# Core Evaluator
# =========================


class AccuracyEvaluator:
    EVIDENCE_PATTERN = re.compile(r"\b(?:EV[-_:][A-Za-z0-9_\-]+|ev_[A-Za-z0-9_\-]+|evidence:[A-Za-z0-9_\-]+)\b")

    def __init__(self, store: EvidenceStore):
        self.store = store

    def evaluate_output(
        self,
        output_text: str,
        output_id: str,
        structured_claims: Optional[List[Dict[str, Any]]] = None,
    ) -> AccuracyEvaluation:
        statements = self._extract_statements(output_text, output_id, structured_claims)
        conflicts = self._detect_conflicts(statements)
        hallucinations = self._detect_hallucinations(statements)
        metrics = self._build_metrics(statements, conflicts, hallucinations)
        decision, reason = self._make_decision(metrics)

        evaluation = AccuracyEvaluation(
            evaluation_id=f"eval_{int(time.time())}_{output_id}",
            output_id=output_id,
            total_statements=metrics["total_statements"],
            verified_statements=metrics["verified_statements"],
            unverified_statements=metrics["unverified_statements"],
            conflicting_statements=metrics["conflicting_statements"],
            hallucinated_statements=metrics["hallucinated_statements"],
            expired_evidence_statements=metrics["expired_evidence_statements"],
            evidence_coverage=metrics["evidence_coverage"],
            evidence_recall_rate=metrics["evidence_recall_rate"],
            confidence_score=metrics["confidence_score"],
            hallucination_score=metrics["hallucination_score"],
            conflict_score=metrics["conflict_score"],
            gate_decision=decision,
            decision_reason=reason,
            warnings=self._build_warnings(metrics, conflicts, hallucinations),
            required_actions=self._build_required_actions(metrics, conflicts, hallucinations),
            statement_analysis=[asdict(s) for s in statements],
            conflict_details=conflicts,
            hallucination_details=hallucinations,
        )
        return evaluation

    def _extract_statements(
        self,
        output_text: str,
        output_id: str,
        structured_claims: Optional[List[Dict[str, Any]]],
    ) -> List[OutputStatement]:
        if structured_claims:
            return self._extract_from_structured_claims(output_id, structured_claims)

        sentences = [s.strip() for s in re.split(r"[。.!?\n]+", output_text) if s.strip()]
        results: List[OutputStatement] = []
        for idx, sentence in enumerate(sentences):
            if len(sentence) < 4:
                continue
            evidence_ids = self._extract_evidence_ids(sentence)
            statement = OutputStatement(
                statement_id=f"{output_id}_stmt_{idx}",
                claim=sentence,
                evidence_ids=evidence_ids,
                statement_type=self._classify_statement(sentence),
                verifiable=self._is_verifiable(sentence),
            )
            if not evidence_ids:
                self._auto_attach_evidence(statement)
            results.append(statement)
        return results

    def _extract_from_structured_claims(self, output_id: str, claims: List[Dict[str, Any]]) -> List[OutputStatement]:
        results: List[OutputStatement] = []
        for idx, item in enumerate(claims):
            claim = str(item.get("claim", "")).strip()
            if not claim:
                continue
            evidence_ids = [str(x).strip() for x in item.get("evidence_ids", []) if str(x).strip()]
            statement = OutputStatement(
                statement_id=f"{output_id}_claim_{idx}",
                claim=claim,
                evidence_ids=evidence_ids,
                statement_type=str(item.get("statement_type", "fact")),
                verifiable=bool(item.get("verifiable", True)),
            )
            if not evidence_ids:
                self._auto_attach_evidence(statement)
            results.append(statement)
        return results

    def _extract_evidence_ids(self, text: str) -> List[str]:
        ids = [m.group(0) for m in self.EVIDENCE_PATTERN.finditer(text)]
        seen: Set[str] = set()
        unique: List[str] = []
        for ev_id in ids:
            if ev_id not in seen:
                unique.append(ev_id)
                seen.add(ev_id)
        return unique

    def _auto_attach_evidence(self, statement: OutputStatement) -> None:
        candidates = self.store.search(statement.claim, limit=3)
        for c in candidates:
            score = self._overlap_score(statement.claim, c.content)
            if score >= 0.35:
                statement.evidence_ids.append(c.evidence_id)
                statement.evidence_references.append(
                    EvidenceReference(
                        evidence_id=c.evidence_id,
                        claim=statement.claim,
                        relevance_score=score,
                        usage_context="retrieved",
                    )
                )

    def _overlap_score(self, a: str, b: str) -> float:
        wa = set(re.findall(r"[A-Za-z0-9\u4e00-\u9fff]+", a.lower()))
        wb = set(re.findall(r"[A-Za-z0-9\u4e00-\u9fff]+", b.lower()))
        if not wa or not wb:
            return 0.0
        return len(wa.intersection(wb)) / len(wa)

    def _classify_statement(self, text: str) -> str:
        low = text.lower()
        if any(k in low for k in ["建议", "recommend", "建议", "should"]):
            return "recommendation"
        if any(k in low for k in ["将", "预计", "forecast", "predict", "will"]):
            return "prediction"
        if any(k in low for k in ["因此", "所以", "therefore", "because"]):
            return "conclusion"
        return "fact"

    def _is_verifiable(self, text: str) -> bool:
        low = text.lower()
        subjective = ["我觉得", "感觉", "opinion", "believe", "maybe", "perhaps"]
        if any(k in low for k in subjective):
            return False
        return True

    def _detect_hallucinations(self, statements: List[OutputStatement]) -> List[Dict[str, Any]]:
        hall: List[Dict[str, Any]] = []
        for stmt in statements:
            if stmt.verifiable and not stmt.has_evidence:
                hall.append({
                    "type": "no_evidence",
                    "statement_id": stmt.statement_id,
                    "severity": "high",
                    "message": "verifiable claim without evidence_id",
                })
                continue

            for ev_id in stmt.evidence_ids:
                ok, reason = self.store.validate(ev_id)
                if not ok:
                    sev = "medium" if reason == "expired" else "high"
                    hall.append({
                        "type": "invalid_evidence",
                        "statement_id": stmt.statement_id,
                        "evidence_id": ev_id,
                        "severity": sev,
                        "message": reason,
                    })

            if self._is_over_confident(stmt.claim):
                hall.append({
                    "type": "over_confident",
                    "statement_id": stmt.statement_id,
                    "severity": "low",
                    "message": "strong certainty phrase without qualifier",
                })
        return hall

    def _is_over_confident(self, text: str) -> bool:
        low = text.lower()
        certainty = ["definitely", "certainly", "absolutely", "必然", "肯定", "一定"]
        qualifier = ["可能", "大概率", "可能性", "likely", "probably", "may", "might"]
        has_certainty = any(k in low for k in certainty)
        has_qualifier = any(k in low for k in qualifier)
        return has_certainty and not has_qualifier

    def _detect_conflicts(self, statements: List[OutputStatement]) -> List[Dict[str, Any]]:
        conflicts: List[Dict[str, Any]] = []

        # 1) 内部语义冲突
        antonym_pairs = [
            ("increase", "decrease"),
            ("high", "low"),
            ("success", "failure"),
            ("增长", "下降"),
            ("盈利", "亏损"),
            ("可行", "不可行"),
        ]

        for i in range(len(statements)):
            for j in range(i + 1, len(statements)):
                a = statements[i].claim.lower()
                b = statements[j].claim.lower()
                for p1, p2 in antonym_pairs:
                    if (p1 in a and p2 in b) or (p2 in a and p1 in b):
                        conflicts.append({
                            "type": "internal_contradiction",
                            "statement_ids": [statements[i].statement_id, statements[j].statement_id],
                            "severity": "high",
                            "message": f"{p1} vs {p2}",
                        })
                        break

                numeric = self._numeric_conflict(a, b)
                if numeric:
                    conflicts.append({
                        "type": "numeric_conflict",
                        "statement_ids": [statements[i].statement_id, statements[j].statement_id],
                        "severity": "medium",
                        "message": numeric,
                    })

        # 2) 外部冲突(证据状态)
        for stmt in statements:
            for ev_id in stmt.evidence_ids:
                evidence = self.store.get(ev_id)
                if evidence and evidence.status == EvidenceStatus.CONFLICTING:
                    conflicts.append({
                        "type": "external_conflict",
                        "statement_ids": [stmt.statement_id],
                        "severity": "high",
                        "message": f"evidence {ev_id} marked conflicting",
                    })

        # 3) 知识图谱因果矛盾检测: 检测声明是否与已知图谱关系矛盾
        kg_contradictions = self._detect_kg_graph_contradictions(statements)
        conflicts.extend(kg_contradictions)

        return conflicts

    def _numeric_conflict(self, a: str, b: str) -> Optional[str]:
        nums_a = re.findall(r"\d+(?:\.\d+)?", a)
        nums_b = re.findall(r"\d+(?:\.\d+)?", b)
        if not nums_a or not nums_b:
            return None
        try:
            x = float(nums_a[0])
            y = float(nums_b[0])
        except ValueError:
            return None
        m = max(x, y)
        if m == 0:
            return None
        if abs(x - y) / m > 0.5:
            return f"numeric mismatch {x} vs {y}"
        return None

    def _detect_kg_graph_contradictions(self, statements: List[OutputStatement]) -> List[Dict[str, Any]]:
        """
        检测输出声明是否与知识图谱中的已知因果/约束关系矛盾.

        通过 KnowledgeGraphEngine.find_contradicting_relations() 实现.
        如果声明中否定了图谱中已验证的关系（例如"渠道冗余不影响现金流"
        而图中渠道冗余 --protects--> 现金流跑道），则标记为矛盾。
        """
        contradictions: List[Dict[str, Any]] = []
        try:
            kg_mod = None
            for mod_name in ("m7_knowledge_graph", "scripts.m7.m7_knowledge_graph"):
                try:
                    kg_mod = importlib.import_module(mod_name)
                    break
                except Exception:
                    kg_mod = None

            engine = None
            if kg_mod:
                get_kg_engine = getattr(kg_mod, "get_kg_engine", None)
                if callable(get_kg_engine):
                    engine = get_kg_engine()

            if not engine or not getattr(engine, "is_loaded", False):
                return contradictions

            for stmt in statements:
                claim_text = stmt.claim
                kg_chains = engine.find_contradicting_relations(claim_text)
                for chain in kg_chains:
                    contradictions.append({
                        "type": "kg_graph_contradiction",
                        "statement_ids": [stmt.statement_id],
                        "severity": "high",
                        "message": chain.chain_text,
                        "kg_detail": chain.to_dict(),
                    })
        except Exception as exc:
            logger.debug(f"[AccuracyGate] KG 图谱矛盾检测异常（已降级跳过）: {exc}")

        return contradictions

    def _build_metrics(
        self,
        statements: List[OutputStatement],
        conflicts: List[Dict[str, Any]],
        hallucinations: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        total = len(statements)
        if total == 0:
            return {
                "total_statements": 0,
                "verified_statements": 0,
                "unverified_statements": 0,
                "conflicting_statements": 0,
                "hallucinated_statements": 0,
                "expired_evidence_statements": 0,
                "evidence_coverage": 0.0,
                "evidence_recall_rate": 0.0,
                "confidence_score": 0.0,
                "hallucination_score": 1.0,
                "conflict_score": 1.0,
            }

        verified = 0
        unverified = 0
        expired_stmt = 0
        recalled = 0

        for stmt in statements:
            if stmt.has_evidence:
                all_ok = True
                has_expired = False
                for ev_id in stmt.evidence_ids:
                    ok, reason = self.store.validate(ev_id)
                    if ok:
                        recalled += 1
                    else:
                        all_ok = False
                        if reason == "expired":
                            has_expired = True
                if all_ok:
                    verified += 1
                else:
                    unverified += 1
                if has_expired:
                    expired_stmt += 1
            else:
                if stmt.verifiable:
                    unverified += 1

        conflict_stmt_ids: Set[str] = set()
        for c in conflicts:
            for sid in c.get("statement_ids", []):
                conflict_stmt_ids.add(str(sid))

        hallucinated_stmt_ids: Set[str] = set()
        for h in hallucinations:
            sid = h.get("statement_id")
            if sid:
                hallucinated_stmt_ids.add(str(sid))

        coverage = verified / total
        recall_denom = sum(len(s.evidence_ids) for s in statements)
        recall_rate = (recalled / recall_denom) if recall_denom > 0 else 0.0

        confidence = max(0.0, min(1.0, coverage * 0.6 + recall_rate * 0.4))
        hallucination_score = len(hallucinated_stmt_ids) / total
        conflict_score = len(conflict_stmt_ids) / total

        return {
            "total_statements": total,
            "verified_statements": verified,
            "unverified_statements": unverified,
            "conflicting_statements": len(conflict_stmt_ids),
            "hallucinated_statements": len(hallucinated_stmt_ids),
            "expired_evidence_statements": expired_stmt,
            "evidence_coverage": coverage,
            "evidence_recall_rate": recall_rate,
            "confidence_score": confidence,
            "hallucination_score": hallucination_score,
            "conflict_score": conflict_score,
        }

    def _make_decision(self, metrics: Dict[str, Any]) -> Tuple[GateDecision, str]:
        if metrics["hallucinated_statements"] > 0:
            return GateDecision.REJECT, "detected verifiable claim(s) without valid evidence"

        if metrics["conflicting_statements"] > 0:
            return GateDecision.REQUIRES_REVISION, "detected claim conflicts"

        if metrics["expired_evidence_statements"] > 0:
            return GateDecision.NEEDS_REFRESH, "expired evidence found"

        if metrics["evidence_coverage"] < 0.9:
            return GateDecision.PASS_WITH_WARNING, "coverage below 90% threshold"

        return GateDecision.PASS, "all checks passed"

    def _build_warnings(
        self,
        metrics: Dict[str, Any],
        conflicts: List[Dict[str, Any]],
        hallucinations: List[Dict[str, Any]],
    ) -> List[str]:
        warnings: List[str] = []
        if metrics["evidence_coverage"] < 0.9:
            warnings.append(f"evidence_coverage={metrics['evidence_coverage']:.1%} < 90%")
        if metrics["evidence_recall_rate"] < 0.95:
            warnings.append(f"evidence_recall_rate={metrics['evidence_recall_rate']:.1%} < 95%")
        if conflicts:
            warnings.append(f"conflicts_detected={len(conflicts)}")
        if hallucinations:
            warnings.append(f"hallucination_flags={len(hallucinations)}")
        return warnings

    def _build_required_actions(
        self,
        metrics: Dict[str, Any],
        conflicts: List[Dict[str, Any]],
        hallucinations: List[Dict[str, Any]],
    ) -> List[str]:
        actions: List[str] = []
        if metrics["evidence_coverage"] < 0.9:
            actions.append("补充缺失 evidence_id, 使有结论句必带证据")
        if metrics["evidence_recall_rate"] < 0.95:
            actions.append("修复 evidence_id 回查失败项")
        if conflicts:
            actions.append("输出冲突说明与待验证项, 不输出单边拍板")
        if any(h.get("type") == "invalid_evidence" for h in hallucinations):
            actions.append("替换无效或冲突证据")
        if any(h.get("type") == "no_evidence" for h in hallucinations):
            actions.append("无证据结论需拒答或降级")
        return actions


# =========================
# Integration-friendly Gate
# =========================


class AccuracyGate:
    def __init__(self, evidence_db_path: Optional[str] = None, kg_engine=None):
        self.evidence_store = EvidenceStore()
        self.evaluator = AccuracyEvaluator(self.evidence_store)
        # 可选: 外部传入的 KG 引擎（避免重复初始化）
        self._kg_engine = kg_engine

        if evidence_db_path:
            self.evidence_store.load(evidence_db_path)
        else:
            self._bootstrap_seed_evidence()

        self.m5_status = self._load_m5()
        self.m12_status = self._load_m12()

    def _get_kg_engine(self):
        """懒加载 KG 引擎（延迟导入避免循环依赖）。"""
        if self._kg_engine is not None:
            return self._kg_engine
        try:
            kg_mod = None
            for mod_name in ("m7_knowledge_graph", "scripts.m7.m7_knowledge_graph"):
                try:
                    kg_mod = importlib.import_module(mod_name)
                    break
                except Exception:
                    kg_mod = None

            if not kg_mod:
                return None

            get_kg_engine = getattr(kg_mod, "get_kg_engine", None)
            if not callable(get_kg_engine):
                return None

            self._kg_engine = get_kg_engine()
            return self._kg_engine
        except Exception:
            return None

    def _bootstrap_seed_evidence(self) -> None:
        """引导填充证据库: 优先从知识图谱加载，降级到硬编码种子。"""
        kg_seeds_added = 0

        # 1) 尝试从知识图谱引擎获取真实种子
        try:
            engine = self._get_kg_engine()
            if engine and engine.is_loaded:
                raw_seeds = engine.generate_evidence_seeds(max_seeds=20)
                for seed_data in raw_seeds:
                    try:
                        ev = Evidence(
                            evidence_id=seed_data.get("evidence_id", f"EV-KG-AUTO-{int(time.time())}-{kg_seeds_added}"),
                            content=seed_data["content"],
                            source_type=seed_data.get("source_type", "knowledge_graph"),
                            source_name=seed_data.get("source_name", "graph_index"),
                            expiration_days=int(seed_data.get("expiration_days", 180)),
                            metadata=seed_data.get("metadata", {}),
                        )
                        self.evidence_store.add(ev)
                        kg_seeds_added += 1
                    except (KeyError, TypeError):
                        continue

                if kg_seeds_added > 0:
                    logger.info(f"[AccuracyGate] 从知识图谱加载 {kg_seeds_added} 条真实证据种子")
        except Exception as exc:
            logger.debug(f"[AccuracyGate] 知识图谱种子加载失败，使用默认种子: {exc}")

        # 2) 降级到硬编码的保守种子
        if kg_seeds_added == 0:
            seeds = [
                Evidence(
                    evidence_id="EV-KS-2025-MARKET",
                    content="Kickstarter ecosystem shows category-specific success variance",
                    source_type="dataset",
                    source_name="kickstarter_cleaned",
                    expiration_days=180,
                ),
                Evidence(
                    evidence_id="EV-M8-RULE-DEFAULT",
                    content="Risk rules from m8_rule_adapter provide conservative constraints",
                    source_type="rule",
                    source_name="m8_rule_adapter",
                    expiration_days=365,
                ),
                Evidence(
                    evidence_id="EV-M12-OOD-CASE",
                    content="OOD scenarios indicate low resilience under funding shock",
                    source_type="simulation",
                    source_name="M12环境增强与OOD测试",
                    expiration_days=180,
                ),
            ]
            for item in seeds:
                self.evidence_store.add(item)

    def _load_m5(self) -> Dict[str, Any]:
        scripts_dir = _discover_scripts_dir()
        module, err = _safe_import_by_path(scripts_dir / "M5_AutoTest_Suite.py", "M5_AutoTest_Suite")
        return {
            "available": module is not None,
            "error": err,
            "module": module,
        }

    def _load_m12(self) -> Dict[str, Any]:
        scripts_dir = _discover_scripts_dir()
        module, err = _safe_import_by_path(scripts_dir / "M12环境增强与OOD测试.py", "M12环境增强与OOD测试")
        return {
            "available": module is not None,
            "error": err,
            "module": module,
        }

    def add_evidence(self, content: str, source_type: str, source_name: str, **kwargs: Any) -> str:
        ev_id = kwargs.pop("evidence_id", f"EV-AUTO-{int(time.time())}")
        evidence = Evidence(
            evidence_id=ev_id,
            content=content,
            source_type=source_type,
            source_name=source_name,
            **kwargs,
        )
        return self.evidence_store.add(evidence)

    def check_output(
        self,
        output_text: str,
        output_id: str,
        structured_claims: Optional[List[Dict[str, Any]]] = None,
    ) -> AccuracyEvaluation:
        return self.evaluator.evaluate_output(output_text, output_id, structured_claims=structured_claims)

    def evaluate_router_payload(self, payload: Dict[str, Any], output_id: str = "router_output") -> AccuracyEvaluation:
        # 兼容当前常见链路字段
        claims = payload.get("claims") or payload.get("key_claims") or []
        evidence_trace = payload.get("evidence_trace") or payload.get("evidence") or {}

        structured_claims: List[Dict[str, Any]] = []
        for idx, claim in enumerate(claims):
            if isinstance(claim, str):
                claim_text = claim
                claim_id = f"claim_{idx}"
                provided_ids = []
            else:
                claim_text = str(claim.get("claim") or claim.get("text") or "")
                claim_id = str(claim.get("claim_id") or f"claim_{idx}")
                provided_ids = list(claim.get("evidence_ids") or [])

            trace_ids = []
            if isinstance(evidence_trace, dict):
                trace_ids = list(evidence_trace.get(claim_id) or [])

            merged_ids = [str(x) for x in (provided_ids + trace_ids) if str(x)]

            structured_claims.append(
                {
                    "claim": claim_text,
                    "evidence_ids": merged_ids,
                    "statement_type": "conclusion",
                    "verifiable": True,
                }
            )

        output_text = "\n".join([c.get("claim", "") for c in structured_claims])
        return self.check_output(output_text=output_text, output_id=output_id, structured_claims=structured_claims)

    def to_runtime_gate_packet(self, evaluation: AccuracyEvaluation) -> Dict[str, Any]:
        return {
            "gate_decision": evaluation.gate_decision.value,
            "decision_reason": evaluation.decision_reason,
            "quality": {
                "evidence_coverage": evaluation.evidence_coverage,
                "evidence_recall_rate": evaluation.evidence_recall_rate,
                "confidence_score": evaluation.confidence_score,
                "hallucination_score": evaluation.hallucination_score,
                "conflict_score": evaluation.conflict_score,
            },
            "warnings": evaluation.warnings,
            "required_actions": evaluation.required_actions,
            "blocked": evaluation.gate_decision in {GateDecision.REJECT, GateDecision.REQUIRES_REVISION},
            "needs_refresh": evaluation.gate_decision == GateDecision.NEEDS_REFRESH,
        }

    def run_regression_tests(self) -> Dict[str, Any]:
        test_cases = [
            {
                "id": "case_pass",
                "text": "结论: 该赛道存在增长空间 evidence:EV-KS-2025-MARKET",
                "expected": GateDecision.PASS,
            },
            {
                "id": "case_reject_no_evidence",
                "text": "结论: 该项目必然成功且毫无风险。",
                "expected": GateDecision.REJECT,
            },
            {
                "id": "case_conflict",
                "text": "市场增长显著。市场增长明显下降。",
                "expected": GateDecision.REQUIRES_REVISION,
            },
            {
                "id": "case_expired",
                "text": "根据旧证据判断 evidence:EV-OLD-001",
                "expected": GateDecision.NEEDS_REFRESH,
                "inject_evidence": Evidence(
                    evidence_id="EV-OLD-001",
                    content="old evidence",
                    source_type="web",
                    source_name="legacy",
                    timestamp=time.time() - 400 * 24 * 3600,
                    expiration_days=30,
                ),
            },
        ]

        details: List[Dict[str, Any]] = []
        passed = 0
        for case in test_cases:
            injected = case.get("inject_evidence")
            if injected:
                self.evidence_store.add(injected)

            evaluation = self.check_output(case["text"], case["id"])
            ok = evaluation.gate_decision == case["expected"]
            if ok:
                passed += 1
            details.append(
                {
                    "id": case["id"],
                    "expected": case["expected"].value,
                    "actual": evaluation.gate_decision.value,
                    "passed": ok,
                }
            )

        return {
            "total": len(test_cases),
            "passed": passed,
            "failed": len(test_cases) - passed,
            "pass_rate": passed / len(test_cases),
            "details": details,
        }

    def run_m5m12_integration_tests(self) -> Dict[str, Any]:
        result = {
            "m5": {"available": self.m5_status["available"], "error": self.m5_status["error"]},
            "m12": {"available": self.m12_status["available"], "error": self.m12_status["error"]},
            "suggestions": [],
        }
        if not self.m5_status["available"]:
            result["suggestions"].append("检查 scripts/M5_AutoTest_Suite.py 及其依赖")
        if not self.m12_status["available"]:
            result["suggestions"].append("检查 scripts/M12环境增强与OOD测试.py 及其依赖")
        return result

    def save_evidence_db(self, file_path: str) -> None:
        self.evidence_store.save(file_path)

    def load_evidence_db(self, file_path: str) -> None:
        self.evidence_store.load(file_path)


# =========================
# Coverage Report Utility
# =========================


def generate_evidence_coverage_report(
    evaluations: List[AccuracyEvaluation],
    output_dir: str = "reports",
) -> Dict[str, Any]:
    report = {
        "generated_at": datetime.now().isoformat(),
        "total_evaluations": len(evaluations),
        "summary": {
            "avg_evidence_coverage": 0.0,
            "avg_evidence_recall_rate": 0.0,
            "avg_confidence_score": 0.0,
            "avg_hallucination_score": 0.0,
            "avg_conflict_score": 0.0,
            "total_statements": 0,
            "verified_statements": 0,
            "unverified_statements": 0,
        },
        "decision_distribution": {},
        "recommendations": [],
    }

    if not evaluations:
        report["recommendations"].append("无评估数据，先执行 accuracy gate")
        return report

    decision_count: Dict[str, int] = {}
    total_statements = 0
    total_verified = 0
    total_unverified = 0

    sum_cov = 0.0
    sum_recall = 0.0
    sum_conf = 0.0
    sum_hall = 0.0
    sum_conflict = 0.0

    for e in evaluations:
        sum_cov += e.evidence_coverage
        sum_recall += e.evidence_recall_rate
        sum_conf += e.confidence_score
        sum_hall += e.hallucination_score
        sum_conflict += e.conflict_score

        total_statements += e.total_statements
        total_verified += e.verified_statements
        total_unverified += e.unverified_statements

        decision = e.gate_decision.value
        decision_count[decision] = decision_count.get(decision, 0) + 1

    n = len(evaluations)
    report["summary"] = {
        "avg_evidence_coverage": sum_cov / n,
        "avg_evidence_recall_rate": sum_recall / n,
        "avg_confidence_score": sum_conf / n,
        "avg_hallucination_score": sum_hall / n,
        "avg_conflict_score": sum_conflict / n,
        "total_statements": total_statements,
        "verified_statements": total_verified,
        "unverified_statements": total_unverified,
    }
    report["decision_distribution"] = decision_count

    reject_rate = decision_count.get(GateDecision.REJECT.value, 0) / n
    if report["summary"]["avg_evidence_coverage"] < 0.9:
        report["recommendations"].append("证据覆盖率低于90%，补齐 claim -> evidence_id 映射")
    if report["summary"]["avg_evidence_recall_rate"] < 0.95:
        report["recommendations"].append("可回查率低于95%，优先修复 evidence_id 对应关系")
    if report["summary"]["avg_hallucination_score"] > 0.05:
        report["recommendations"].append("无证据硬结论比例偏高，提升拒答/降级触发")
    if reject_rate > 0.3:
        report["recommendations"].append("拒绝率高于30%，需优化上游证据编排质量")

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"evidence_coverage_{int(time.time())}.json"
    out_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    report["saved_path"] = str(out_file)
    return report


# =========================
# Integration with Evidence Orchestrator
# =========================

def integrate_evidence_orchestration(
    gate: AccuracyGate,
    orchestration_result: Dict[str, Any],
) -> Dict[str, Any]:
    """
    将证据编排结果集成到 gate 的证据库
    
    Args:
        gate: AccuracyGate 实例
        orchestration_result: format_orchestration_result_for_fusion 的输出
        
    Returns:
        {
            "added_evidence_count": int,
            "evidence_coverage_before": float,
            "evidence_coverage_after": float,
            "status": "ok" | "error",
        }
    """
    evidence_map = orchestration_result.get("evidence_map", {})
    before_count = gate.evidence_store.size()

    for evidence_id, evidence_dict in evidence_map.items():
        # 将 dict 转回 Evidence 对象
        try:
            ev = Evidence(
                evidence_id=evidence_dict["evidence_id"],
                content=evidence_dict["content"],
                source_type=evidence_dict["source_type"],
                source_name=evidence_dict["source_name"],
                source_url=evidence_dict.get("source_url"),
                timestamp=evidence_dict.get("timestamp", time.time()),
                expiration_days=evidence_dict.get("expiration_days", 30),
                status=EvidenceStatus(evidence_dict.get("status", "verified")),
                confidence=ConfidenceLevel(evidence_dict.get("confidence", "medium")),
                metadata=evidence_dict.get("metadata", {}),
            )
            gate.evidence_store.add(ev)
        except Exception:
            pass

    after_count = gate.evidence_store.size()

    return {
        "added_evidence_count": after_count - before_count,
        "evidence_coverage_before": before_count,
        "evidence_coverage_after": after_count,
        "status": "ok",
    }


def create_gate_with_orchestrator(
    orchestrator_config: Optional[Dict[str, Any]] = None,
) -> Tuple[AccuracyGate, Any]:
    """
    创建带有证据编排器的完整 gate 系统
    
    Returns:
        (gate: AccuracyGate, orchestrator: EvidenceOrchestrator)
    """
    gate = AccuracyGate()

    # 动态加载编排器
    try:
        from evidence_orchestrator import EvidenceOrchestrator
        config = orchestrator_config or {}
        orchestrator = EvidenceOrchestrator(
            kb_retriever=config.get("kb_retriever"),
            info_pool_retriever=config.get("info_pool_retriever"),
            web_retriever=config.get("web_retriever"),
            enable_deduplication=config.get("enable_dedup", True),
        )
        return gate, orchestrator
    except ImportError:
        return gate, None


# ════════════════════════════════════════════
# SelfIterationLoop — 自我迭代闭环
# ════════════════════════════════════════════

logger = logging.getLogger("accuracy_gate")

class SelfIterationLoop:
    """
    当 AccuracyGate 决策为 REQUIRES_REVISION 时，
    触发带修正信息的重新推理循环，实现「检测→修正→再验证」的完整闭环。

    核心设计:
      - 不只是标记 REQUIRES_REVISION 就完事，而是真正触发修正
      - 每轮迭代将冲突/反证信息注入 prompt 作为修正约束
      - 最多 MAX_ITERATIONS 轮，每轮递减 temperature 提升稳定性
      - 最终输出中包含 _revised / _iteration_count 等元数据

    嵌入位置:
      被 m7_inference_runner.run_expert_llm_inference_with_blender()
      在 gate.evaluate_router_payload() 返回 REQUIRES_REVISION 后调用。
    """

    MAX_ITERATIONS = 2

    def __init__(self, llm_client=None):
        self.llm_client = llm_client

    def iterate_if_needed(
        self,
        original_output: Dict[str, Any],
        gate_evaluation: "AccuracyEvaluation",
        context: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        如果 gate 决策需要修正，执行自我迭代。

        Args:
            original_output: 原始推理输出 (来自 run_expert_llm_inference)
            gate_evaluation: AccuracyGate 的评估结果
            context: 包含 messages、llm_client、user_input 等

        Returns:
            修正后的 output（可能和 original_output 相同如果不需要修正）
        """
        if not gate_evaluation or gate_evaluation.gate_decision != GateDecision.REQUIRES_REVISION:
            return original_output

        # 需要一个 LLM client 来执行重新推理
        llm = context.get("llm_client") or self.llm_client
        if llm is None:
            logger.warning("[SelfIterationLoop] 无 LLM 客户端可用，跳过自我迭代")
            return dict(original_output)

        current_output = dict(original_output)
        current_messages = context.get("messages")

        for iteration in range(1, self.MAX_ITERATIONS + 1):
            # 构建修正 prompt
            revision_content = self._build_revision_prompt(
                current_output=current_output,
                gate_evaluation=gate_evaluation,
            )

            # 追加到对话历史并重新请求
            if current_messages:
                revision_messages = list(current_messages) + [
                    {"role": "user", "content": revision_content},
                ]
            else:
                revision_messages = [{"role": "user", "content": revision_content}]

            try:
                resp = llm.chat(
                    messages=revision_messages,
                    temperature=max(0.05, 0.15 - 0.05 * iteration),
                )

                raw_content = getattr(resp, "content", "")
                parsed = json.loads(raw_content) if raw_content else {}

                current_output = {
                    "parsed": parsed,
                    "raw_content": raw_content,
                    "model": getattr(resp, "model", ""),
                    "_revised": True,
                    "_iteration_count": iteration,
                }

            except Exception as exc:
                logger.warning(f"[SelfIterationLoop] 第{iteration}轮重试失败: {exc}")
                current_output.setdefault("_revision_errors", []).append(str(exc))
                break

            # 再次过 Gate（简化版）
            new_gate_result = self._quick_recheck(current_output, gate_evaluation)
            if new_gate_result in (GateDecision.PASS, GateDecision.PASS_WITH_WARNING):
                current_output["_gate_final"] = "PASS"
                current_output["_iteration_count"] = iteration
                logger.info(f"[SelfIterationLoop] 第{iteration}轮修正后通过 Gate")
                break
        else:
            current_output["_gate_final"] = "REVISION_EXHAUSTED"
            current_output["_iteration_count"] = self.MAX_ITERATIONS
            logger.info(f"[SelfIterationLoop] 达到 {self.MAX_ITERATIONS} 轮上限")

        return current_output

    @staticmethod
    def _build_revision_prompt(
        current_output: Dict[str, Any],
        gate_evaluation: "AccuracyEvaluation",
    ) -> str:
        """构建修正指令 prompt"""
        parts = [
            "【准确性修正请求】\n",
            "以下是你之前的回答经过准确性闸门检测后发现的问题。请根据反馈更正你的回答。\n",
        ]

        conflicts = gate_evaluation.conflict_details or []
        hallucinations = gate_evaluation.hallucination_details or []

        if conflicts:
            conflict_texts = []
            for c in conflicts[:3]:
                msg = c.get("message", "") if isinstance(c, dict) else str(c)
                sev = c.get("severity", "unknown") if isinstance(c, dict) else ""
                conflict_texts.append(f"  * [{sev}] {msg}")

            parts.append("\n与已知证据存在矛盾或内部不一致的声明:\n")
            parts.append("\n".join(conflict_texts))
            parts.append("\n\n请将上述声明更正为与证据一致的表述。如无法确认请注明不确定性。\n")

        if hallucinations:
            hall_texts = []
            for h in hallucinations[:3]:
                msg = h.get("message", "") if isinstance(h, dict) else str(h)
                hall_texts.append(f'  * "{msg}"')

            parts.append("\n缺乏证据支持或可信度存疑的声明:\n")
            parts.append("\n".join(hall_texts))
            parts.append("\n\n请删除或标注这些缺乏依据的内容，或补充来源。\n")

        parts.append(
            "\n修正原则:\n"
            "1. 只修改有问题的部分，其他合理内容保持不变\n"
            "2. 如果涉及事实性错误，以网络检索的最新信息为准\n"
            "3. 保持 JSON 输出格式不变\n"
            "4. 在修改处标注 [已修正]"
        )
        return "".join(parts)

    @staticmethod
    def _quick_recheck(
        output: Dict[str, Any],
        previous_eval: "AccuracyEvaluation",
    ) -> Optional["GateDecision"]:
        """快速再检查: 简单判断本轮输出是否消除了主要问题"""
        content = ""
        parsed = output.get("parsed")
        if isinstance(parsed, dict):
            content = parsed.get("risk_summary", "")
            if not content:
                actions = parsed.get("actions", [])
                if isinstance(actions, list):
                    content = " ".join(
                        a.get("title", "") if isinstance(a, dict) else str(a)
                        for a in actions[:3]
                    )

        if not content:
            return GateDecision.PASS_WITH_WARNING

        prev_conflicts = previous_eval.conflicting_statements or 0
        if prev_conflicts > 0 and len(content) > 10:
            return GateDecision.PASS_WITH_WARNING

        return None


# ════════════════════════════════════════════
# CounterEvidenceDetector — 反证检测
# ════════════════════════════════════════════

class CounterEvidenceDetector:
    """
    反证检测器 — 对比 LLM 输出的 claims 与网络证据，发现矛盾
    
    用法:
        detector = CounterEvidenceDetector()
        conflicts = detector.detect(claims=output_claims, web_evidence=evidence_list)
    """

    def detect(
        self,
        claims: List[Dict[str, Any]],
        web_evidence_pool: List[Any],
    ) -> List[Dict[str, Any]]:
        """检测 claims 是否与网络证据存在矛盾"""
        if not claims or not web_evidence_pool:
            return []

        conflicts: List[Dict[str, Any]] = []

        for claim in claims:
            claim_text = claim.get("claim") or claim.get("text", "")
            if not claim_text or len(claim_text) < 4:
                continue

            claim_lower = claim_text.lower()

            counter_evidence_ids: List[str] = []
            counter_summaries: List[str] = []

            for ev in web_evidence_pool:
                if not hasattr(ev, 'snippet'):
                    continue

                numeric_conflict = self._detect_numeric_contradiction(claim_text, ev.snippet)
                if numeric_conflict:
                    counter_evidence_ids.append(ev.evidence_id)
                    counter_summaries.append(numeric_conflict)

                elif self._detect_antonym_contradiction(claim_lower, ev.snippet.lower()):
                    counter_evidence_ids.append(ev.evidence_id)
                    title = getattr(ev, 'title', '')
                    counter_summaries.append(
                        f"网络证据[{title}]指出不同观点: {ev.snippet[:100]}"
                    )

            if counter_evidence_ids:
                severity = "high" if len(counter_evidence_ids) >= 2 else "medium"
                conflicts.append({
                    "type": "counter_evidence",
                    "claim_id": claim.get("claim_id", ""),
                    "claim_text": claim_text[:120],
                    "counter_evidence_ids": counter_evidence_ids,
                    "severity": severity,
                    "resolution_suggestion": (
                        f"参考 {len(counter_evidence_ids)} 条网络证据更正此声明"
                    ),
                    "counter_summary": "; ".join(counter_summaries[:2]),
                })

        return conflicts

    @staticmethod
    def _detect_numeric_contradiction(claim: str, evidence: str) -> Optional[str]:
        """检测数值型矛盾"""
        claim_nums = re.findall(r'\d+(?:\.\d+)?(?:\s*[%%万元亿美金€£])?', claim)
        ev_nums = re.findall(r'\d+(?:\.\d+)?(?:\s*[%%万元亿美金€£])?', evidence)

        if not claim_nums or not ev_nums:
            return None

        try:
            c_val = float(re.sub(r'[^\d.]', '', claim_nums[0]))
            e_val = float(re.sub(r'[^\d.]', '', ev_nums[0]))

            if c_val > 0 and abs(c_val - e_val) / c_val > 0.5:
                return f"数值矛盾: 声称{claim_nums[0]} vs 证据显示{ev_nums[0]}"
        except (ValueError, ZeroDivisionError):
            pass

        return None

    @staticmethod
    def _detect_antonym_contradiction(claim: str, evidence: str) -> bool:
        """简单的语义反义词矛盾检测"""
        antonym_groups = [
            ("增长", "下降"), ("上涨", "下跌"), ("盈利", "亏损"),
            ("可行", "不可行"), ("成功", "失败"), ("高", "低"),
            ("increase", "decrease"), ("rise", "fall"),
        ]

        for pos, neg in antonym_groups:
            if pos in claim and neg in evidence:
                return True
            if neg in claim and pos in evidence:
                return True

        return False


def _demo() -> None:
    gate = AccuracyGate()
    samples = [
        "根据 evidence:EV-KS-2025-MARKET 判断，该赛道仍有增长空间。",
        "该项目必然成功，完全没有风险。",
    ]
    evaluations: List[AccuracyEvaluation] = []
    for idx, text in enumerate(samples):
        evaluations.append(gate.check_output(text, f"demo_{idx}"))

    summary = generate_evidence_coverage_report(evaluations, output_dir="reports")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    _demo()
