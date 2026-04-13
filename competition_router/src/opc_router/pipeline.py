from __future__ import annotations

from dataclasses import dataclass
import json
import threading
from pathlib import Path
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

from .blender import fuse_rule_based, pairrank, normalize_agent_outputs, pairrank_from_candidates
from .info_pool import load_records, retrieve_from_info_pool
from .router import load_experts, route_experts_by_tier
from .service_client import build_client
from .small_model import SmallModelRouter
 
# Optional self-correction imports (OPCcomp)
try:
    # try import from workspace OPCcomp package
    from OPCcomp.self_correction_adapter import create_adapter_for_m9
    from OPCcomp.accuracy_gate import AccuracyGate
except Exception:
    create_adapter_for_m9 = None
    AccuracyGate = None


def _load_knowledge_graph_retriever():
    """Lazy-load knowledge graph retriever from scripts/m7 if available."""
    try:
        repo_root = Path(__file__).resolve().parents[4]
        if str(repo_root) not in sys.path:
            sys.path.insert(0, str(repo_root))
        from scripts.m7.m7_knowledge_graph import retrieve_knowledge_graph_hits
        return retrieve_knowledge_graph_hits
    except ImportError:
        return None


_kg_retriever = _load_knowledge_graph_retriever()


def _load_research_route_bridge():
    """Lazy-load the research-side router so it can be used as an enhancement layer."""
    try:
        repo_root = Path(__file__).resolve().parents[4]
        if str(repo_root) not in sys.path:
            sys.path.insert(0, str(repo_root))
        scripts_m7_dir = repo_root / "scripts" / "m7"
        if str(scripts_m7_dir) not in sys.path:
            sys.path.insert(0, str(scripts_m7_dir))
        from scripts.m7.m7_router import route_experts
        return route_experts
    except ImportError:
        return None


_research_route_bridge = _load_research_route_bridge()


def _tier_to_research_risk_level(tier: str) -> str:
    mapping = {
        "L3": "high",
        "L2": "medium",
        "L1": "low",
    }
    return mapping.get((tier or "").strip(), "medium")


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
        self.task_intent_confidence_threshold = float(os.getenv("TASK_REQUEST_CONFIDENCE_THRESHOLD", "0.72"))
        self.intent_parse_fallback_score_threshold = float(os.getenv("INTENT_PARSE_FALLBACK_SCORE_THRESHOLD", "5.0"))
        self.intent_parse_fallback_text_length = int(os.getenv("INTENT_PARSE_FALLBACK_TEXT_LENGTH", "80"))
        self.experts_path = self.project_root / "config" / "experts.json"
        self.prompts_dir = self.project_root.parent / "opc-eval-runtime" / "prompts"
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
        # 初始化证据编排器（可选）
        self.evidence_orchestrator = self._init_evidence_orchestrator()

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

    def _init_evidence_orchestrator(self):
        """初始化证据编排器 - 支持联网检索和证据融合"""
        try:
            repo_root = (self.project_root / ".." / "..").resolve()
            if str(repo_root) not in sys.path:
                sys.path.insert(0, str(repo_root))
            from OPCcomp.evidence_orchestrator import EvidenceOrchestrator

            # 支持通过千帆平台的多个 agent 做外部检索（当 WEB_ENGINE=qianfan 时）
            class QianfanWebRetriever:
                def __init__(self, app_ids: List[str], api_key: str, host: str = "https://qianfan.baidubce.com", cache_dir: str = "./web_cache"):
                    self.app_ids = [a for a in (app_ids or []) if a]
                    self.api_key = api_key or ""
                    self.host = host
                    self.cache_dir = cache_dir

                def search_for_evidence(self, query: str, evidence_coverage: float = 0.0, evidence_type: str = "general", top_k: int = 3, force_refresh: bool = False):
                    """
                    使用千帆上注册的 agent 进行检索：将 query 发给每个 agent，期望返回结构化的证据列表或可解析的文本片段。
                    返回值为 OPCcomp.accuracy_gate.Evidence 列表（或兼容对象）。
                    """
                    results = []
                    try:
                        from time import time
                        from .service_client import QianfanAgentClient, extract_text
                        from OPCcomp.accuracy_gate import Evidence, EvidenceStatus, ConfidenceLevel
                    except Exception:
                        return []

                    for app_id in self.app_ids:
                        try:
                            client = QianfanAgentClient(app_id=app_id, api_key=self.api_key, secret_key=os.getenv("QIANFAN_SECRET_KEY", ""), host=self.host)
                            system_prompt = (
                                "你是一个外部检索助手。接到用户查询后，请返回一个JSON数组，数组每项包含 {title, url, snippet}，尽量返回真实来源并以中文简短描述。"
                            )
                            messages = [
                                {"role": "system", "content": system_prompt},
                                {"role": "user", "content": f"请基于网络检索以下查询并返回结构化证据（最多{top_k}条）：\n{query}"},
                            ]

                            resp = client.chat(messages)
                            text = extract_text(resp) if isinstance(resp, dict) else str(resp)

                            # 尝试解析为 JSON 列表
                            items = []
                            try:
                                import json as _json
                                parsed = _json.loads(text)
                                if isinstance(parsed, list):
                                    items = parsed[:top_k]
                                elif isinstance(parsed, dict):
                                    # 支持单个对象包装
                                    items = [parsed]
                            except Exception:
                                # fallback: 按行拆分为若干 snippet
                                lines = [l.strip() for l in text.splitlines() if l.strip()][:top_k]
                                items = [{"title": None, "url": None, "snippet": l} for l in lines]

                            now = time()
                            for idx, it in enumerate(items[:top_k]):
                                title = it.get("title") if isinstance(it, dict) else None
                                url = it.get("url") if isinstance(it, dict) else None
                                snippet = it.get("snippet") if isinstance(it, dict) else str(it)
                                ev = Evidence(
                                    evidence_id=f"QF-{app_id}-{int(now)}-{idx}",
                                    content=snippet or (title or ""),
                                    source_type="web",
                                    source_name=f"qianfan_{app_id}",
                                    source_url=url,
                                    timestamp=now,
                                    expiration_days=30,
                                    status=EvidenceStatus.VERIFIED,
                                    confidence=ConfidenceLevel.MEDIUM,
                                    metadata={"reliability_score": 0.6},
                                )
                                results.append(ev)
                        except Exception:
                            continue

                    # 简单按时间与来源排序
                    return results[:top_k]

            web_retriever = None
            engine = os.getenv("WEB_ENGINE", "mock").lower()
            if os.getenv("ENABLE_WEB_SEARCH", "false").lower() == "true":
                if engine == "qianfan":
                    # 从 experts 配置中获取竞赛侧 agent 的 app_id
                    try:
                        comp_agent_names = {"evidence_agent", "feasibility_agent", "risk_agent", "legal_agent"}
                        app_ids = [str(e.get("app_id")) for e in self.experts if str(e.get("name")) in comp_agent_names and e.get("app_id")]
                    except Exception:
                        app_ids = []

                    web_retriever = QianfanWebRetriever(
                        app_ids=app_ids,
                        api_key=os.getenv("QIANFAN_API_KEY") or os.getenv("QIANFAN_ACCESS_KEY"),
                        host=os.getenv("QIANFAN_HOST") or "https://qianfan.baidubce.com",
                        cache_dir=os.getenv("WEB_CACHE_DIR", "./web_cache"),
                    )
                else:
                    try:
                        from OPCcomp.web_retriever import WebRetriever
                        web_retriever = WebRetriever(
                            api_key=os.getenv("SERPER_API_KEY"),
                            engine=engine,
                            cache_dir=os.getenv("WEB_CACHE_DIR", "./web_cache"),
                        )
                    except Exception:
                        web_retriever = None

            return EvidenceOrchestrator(
                kb_retriever=None,
                info_pool_retriever=lambda q, top_k=3: retrieve_from_info_pool(q, self.info_pool, top_k),
                web_retriever=web_retriever,
                enable_deduplication=True,
            )
        except Exception:
            return None

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

        add_edge("feasibility_agent", "evidence_agent", "question-refine")
        add_edge("evidence_agent", "feasibility_agent", "evidence-feedback")
        add_edge("feasibility_agent", "risk_agent", "handoff-feasibility")
        add_edge("evidence_agent", "risk_agent", "handoff-evidence")

        if "legal_agent" in names:
            for upstream in ["evidence_agent", "feasibility_agent", "risk_agent"]:
                add_edge(upstream, "legal_agent", "compliance-request")

        return {
            "mode": "dynamic-bypass-enabled",
            "frontline": [x for x in ["evidence_agent", "feasibility_agent"] if x in names],
            "execution": [x for x in ["risk_agent"] if x in names],
            "support": [x for x in ["legal_agent"] if x in names],
            "nodes": nodes,
            "edges": edges,
        }

    def _build_transient_info_hit(self, user_text: str) -> Dict[str, Any]:
        text = (user_text or "").strip()
        tokens = [x for x in re.split(r"[\s,，。；;：:！!？?、/\\]+", text) if len(x) >= 2][:8]
        return {
            "score": 1.0,
            "record": {
                "title": "当前任务输入",
                "industry": "dynamic",
                "keywords": tokens,
                "guideline": text,
            },
            "source": "transient_current_task",
        }

    def _build_research_fusion(
        self,
        tier: str,
        user_text: str,
        selected_experts: List[Dict[str, Any]],
        info_hits: List[Dict[str, Any]],
        knowledge_graph_hits: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        comp_scores = {
            str(expert.get("name", "")): max(0.1, 1.0 - (idx * 0.05))
            for idx, expert in enumerate(selected_experts)
            if str(expert.get("name", ""))
        }

        if _research_route_bridge is None:
            return {
                "enabled": False,
                "reason": "research_route_bridge_unavailable",
                "selected_experts": selected_experts,
                "comp_scores": comp_scores,
                "research_selected_experts": [],
                "research_routing_scores": {},
                "research_result": {},
            }

        try:
            research_result = _research_route_bridge(
                risk_level=_tier_to_research_risk_level(tier),
                intermediate={},
                project_data={},
                user_input=user_text,
            )
        except Exception as exc:  # noqa: BLE001
            return {
                "enabled": False,
                "reason": f"research_route_bridge_error:{exc}",
                "selected_experts": selected_experts,
                "comp_scores": comp_scores,
                "research_selected_experts": [],
                "research_routing_scores": {},
                "research_result": {},
            }

        research_selected_experts = [
            str(expert.get("name", ""))
            for expert in research_result.get("selected_experts", [])
            if isinstance(expert, dict) and str(expert.get("name", ""))
        ]
        research_routing_scores = {
            str(name): float(score)
            for name, score in (research_result.get("routing_scores", {}) or {}).items()
            if str(name)
        }

        bridge_map = {
            "risk_guardian": {"risk_agent": 1.0, "legal_agent": 0.45, "feasibility_agent": 0.12},
            "finance_advisor": {"feasibility_agent": 0.9, "evidence_agent": 0.15},
            "ops_executor": {"feasibility_agent": 0.55, "evidence_agent": 0.45},
            "growth_strategist": {"feasibility_agent": 0.35, "evidence_agent": 0.65},
        }

        for research_name, target_weights in bridge_map.items():
            research_score = float(research_routing_scores.get(research_name, 0.0))
            if research_name in research_selected_experts:
                research_score += 0.08
            for comp_name, weight in target_weights.items():
                if comp_name in comp_scores:
                    comp_scores[comp_name] += research_score * weight

        if info_hits and "evidence_agent" in comp_scores:
            comp_scores["evidence_agent"] += min(0.18, 0.03 * len(info_hits))

        if knowledge_graph_hits and "evidence_agent" in comp_scores:
            comp_scores["evidence_agent"] += min(0.18, 0.04 * len(knowledge_graph_hits))

        legal_signals = 0
        for hit in knowledge_graph_hits:
            if not isinstance(hit, dict):
                continue
            text = " ".join(
                str(hit.get(field, ""))
                for field in ["relation", "source_label", "evidence_snippet", "node_label", "target_label"]
            ).lower()
            if any(token in text for token in ["legal", "compliance", "cross-border", "跨境", "法规", "合规"]):
                legal_signals += 1

        if legal_signals and "legal_agent" in comp_scores:
            comp_scores["legal_agent"] += min(0.22, 0.05 * legal_signals)

        intent_result = research_result.get("intent_result", {})
        required_experts = intent_result.get("required_experts", []) if isinstance(intent_result, dict) else []
        if isinstance(required_experts, list):
            if "risk_guardian" in required_experts and "risk_agent" in comp_scores:
                comp_scores["risk_agent"] += 0.15
            if "finance_advisor" in required_experts and "feasibility_agent" in comp_scores:
                comp_scores["feasibility_agent"] += 0.12
            if "finance_advisor" in required_experts and "evidence_agent" in comp_scores:
                comp_scores["evidence_agent"] += 0.05

        ordered = sorted(
            enumerate(selected_experts),
            key=lambda item: (
                comp_scores.get(str(item[1].get("name", "")), 0.0),
                -item[0],
            ),
            reverse=True,
        )
        fused_selected_experts = [item[1] for item in ordered]

        return {
            "enabled": True,
            "reason": research_result.get("route_reason", ""),
            "selected_experts": fused_selected_experts,
            "comp_scores": {name: round(score, 4) for name, score in comp_scores.items()},
            "research_selected_experts": research_selected_experts,
            "research_routing_scores": {name: round(score, 4) for name, score in research_routing_scores.items()},
            "research_result": research_result,
            "research_risk_level": _tier_to_research_risk_level(tier),
        }

    def _invoke_qianfan_agents(self, selected_experts: List[Dict[str, Any]], fused: Dict[str, Any]) -> List[Dict[str, Any]]:
        """并发调用千帆平台上已注册的 agent（使用 experts 中的 app_id）。返回每个 agent 的原始响应和提取文本。"""
        try:
            from .service_client import QianfanAgentClient
        except Exception:
            return []

        outputs: List[Dict[str, Any]] = []
        lock = threading.Lock()

        def call_agent(expert: Dict[str, Any]):
            app_id = str(expert.get("app_id" or "", "")).strip()
            if not app_id:
                return
            api_key = os.getenv("QIANFAN_API_KEY") or os.getenv("QIANFAN_ACCESS_KEY")
            secret = os.getenv("QIANFAN_SECRET_KEY") or ""
            host = os.getenv("QIANFAN_HOST") or "https://qianfan.baidubce.com"
            client = QianfanAgentClient(app_id=app_id, api_key=api_key or "", secret_key=secret or "", host=host)

            system_prompt = str(expert.get("system_prompt") or "")
            # 将融合结果作为用户输入传给每个 agent，以便其基于分工生成回复
            try:
                user_content = json.dumps(fused, ensure_ascii=False)
            except Exception:
                user_content = str(fused)

            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ]

            try:
                resp = client.chat(messages)
            except Exception as exc:
                resp = {"ok": False, "status": None, "raw": {"error_message": str(exc)}}

            # 尝试从 raw 中提取常见 content 字段
            extracted = ""
            raw = resp.get("raw") if isinstance(resp.get("raw"), dict) else {}
            try:
                choices = raw.get("choices", [])
                if isinstance(choices, list) and choices:
                    msg = choices[0].get("message") if isinstance(choices[0], dict) else {}
                    extracted = msg.get("content", "") if isinstance(msg, dict) else str(msg)
            except Exception:
                extracted = str(raw)

            out = {
                "expert": expert.get("name"),
                "app_id": app_id,
                "ok": resp.get("ok", False),
                "status": resp.get("status"),
                "raw": resp.get("raw"),
                "text": extracted,
            }
            with lock:
                outputs.append(out)

        threads: List[threading.Thread] = []
        for expert in selected_experts:
            t = threading.Thread(target=call_agent, args=(expert,))
            t.start()
            threads.append(t)

        for t in threads:
            t.join()

        return outputs

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
            "research_fusion": {
                "source": "scripts.m7.m7_router+bridge",
                "description": "由研究侧多层评分提供增强信号，仅用于竞赛侧 agent 重排，不改变对外结构",
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

    def _infer_intent(self, user_text: str, small_model_result: Dict[str, Any]) -> Dict[str, Any]:
        return self.small_model.infer_intent(user_text, route_result=small_model_result)

    def _fallback_intent_when_parse_failed(self, user_text: str, score: float) -> Dict[str, Any]:
        text_len = len((user_text or "").strip())
        if score >= self.intent_parse_fallback_score_threshold or text_len >= self.intent_parse_fallback_text_length:
            return {
                "type": "task_request",
                "confidence": 0.55,
                "reason": f"intent_parse_fallback(score={score:.2f},len={text_len})",
            }
        return {
            "type": "conversation_query",
            "confidence": 0.45,
            "reason": f"intent_parse_fallback_conversation(score={score:.2f},len={text_len})",
        }

    def _should_force_task_flow(self, user_text: str, score: float) -> bool:
        text = (user_text or "").strip()
        if not text:
            return False

        line_count = len([line for line in text.splitlines() if line.strip()])
        if score >= self.intent_parse_fallback_score_threshold:
            return True
        if len(text) >= self.intent_parse_fallback_text_length:
            return True
        if line_count >= 3:
            return True
        return False

    def run(self, user_text: str, try_remote_llm: bool = False) -> Dict[str, Any]:
        small_model_result = self.small_model.route(user_text)
        score = float(small_model_result.get("score", 0.0))
        tier = str(small_model_result.get("tier", "L1"))
        try:
            intent = self._infer_intent(user_text, small_model_result)
        except Exception as exc:  # noqa: BLE001
            intent = self._fallback_intent_when_parse_failed(user_text, score)
            intent_error = str(exc)
        else:
            intent_error = ""

        if intent.get("type") == "task_request":
            confidence = float(intent.get("confidence", 0.0))
            force_task = self._should_force_task_flow(user_text, score)
            if confidence < self.task_intent_confidence_threshold and not force_task:
                intent = {
                    "type": "conversation_query",
                    "confidence": confidence,
                    "reason": f"task_confidence_below_threshold({confidence:.3f}<{self.task_intent_confidence_threshold:.3f})",
                }
            elif confidence < self.task_intent_confidence_threshold and force_task:
                intent = {
                    "type": "task_request",
                    "confidence": confidence,
                    "reason": f"task_forced_by_complexity(score={score:.2f},len={len((user_text or '').strip())})",
                }

        if intent["type"] != "task_request":
            try:
                conversation_reply = self.small_model.generate_reply(user_text)
            except Exception as exc:  # noqa: BLE001
                conversation_reply = "FAULT_CODE:ERR_CHAT_MODEL_PARSE"
                if not intent_error:
                    intent_error = str(exc)
            return {
                "small_model": {
                    "score": score,
                    "tier": tier,
                    "backend": small_model_result.get("backend", "heuristic"),
                    "backend_reason": small_model_result.get("backend_reason", ""),
                },
                "intent": intent,
                "conversation_reply": conversation_reply,
                "selected_experts": [],
                "collaboration_plan": {
                    "mode": "conversation-shortcut",
                    "frontline": [],
                    "execution": [],
                    "support": [],
                    "nodes": [],
                    "edges": [],
                },
                "info_pool_hits": [],
                "research_fusion": {
                    "enabled": False,
                    "reason": "conversation_shortcut",
                    "selected_experts": [],
                    "comp_scores": {},
                    "research_selected_experts": [],
                    "research_routing_scores": {},
                    "research_result": {},
                },
                "ranked_candidates": [],
                "fused_result": {},
                "remote_llm": None,
                "output_attribution": self._build_output_attribution(remote_called=False, remote_available=False),
                "runtime_trace": {
                    "small_model_called": True,
                    "small_model_callsite": "pipeline.run -> SmallModelRouter.route",
                    "small_model_backend": small_model_result.get("backend", "heuristic"),
                    "small_model_backend_reason": small_model_result.get("backend_reason", ""),
                    "remote_llm_called": False,
                    "small_model_error": intent_error,
                    "task_intent_conf_threshold": self.task_intent_confidence_threshold,
                    "intent_parse_fallback_score_threshold": self.intent_parse_fallback_score_threshold,
                    "intent_parse_fallback_text_length": self.intent_parse_fallback_text_length,
                    "provider": self.provider,
                    "model": self.service_model,
                },
            }

        selected_experts = route_experts_by_tier(tier, self.experts, user_text=user_text)

        info_hits = [
            self._build_transient_info_hit(user_text),
            *retrieve_from_info_pool(user_text, self.info_pool, top_k=3),
        ]

        knowledge_graph_hits = []
        if _kg_retriever is not None:
            try:
                knowledge_graph_hits = _kg_retriever(query=user_text, top_k=3)
            except Exception:
                pass

        research_fusion = self._build_research_fusion(
            tier=tier,
            user_text=user_text,
            selected_experts=selected_experts,
            info_hits=info_hits,
            knowledge_graph_hits=knowledge_graph_hits,
        )
        selected_experts = research_fusion.get("selected_experts", selected_experts)

        candidates = [self._build_local_candidate(e, user_text, info_hits) for e in selected_experts]
        ranked = pairrank(candidates)
        fused = fuse_rule_based(ranked)
        
        # 调用证据编排器 - 补充证据（仅在有配置时）
        orchestration_result = None
        if self.evidence_orchestrator:
            try:
                from OPCcomp.evidence_orchestrator import EvidenceRequest
                request = EvidenceRequest(
                    query=user_text,
                    output_claims=[],
                    query_category=tier.lower() if tier else "general",
                    required_evidence_count=3,
                    min_evidence_coverage=0.7,
                    allow_web_search=os.getenv("ENABLE_WEB_SEARCH", "false").lower() == "true",
                    context={"tier": tier, "intent_type": intent.get("type", "")}
                )
                orchestration_result = self.evidence_orchestrator.orchestrate(request)
                
                # 融合到候选项
                if orchestration_result and orchestration_result.search_triggered:
                    fused["evidence_orchestration_metadata"] = {
                        "search_triggered": True,
                        "internal_count": len(orchestration_result.internal_evidence),
                        "external_count": len(orchestration_result.external_evidence),
                        "coverage": orchestration_result.coverage_score,
                        "quality": orchestration_result.orchestration_quality,
                    }
            except Exception:
                orchestration_result = None

        # 调用千帆平台上注册的各 agent（并发），将每个 agent 的回复收集为 agent_outputs
        try:
            agent_outputs = self._invoke_qianfan_agents(selected_experts, fused)
        except Exception:
            agent_outputs = []

        # 若远端 agent 返回结果，则使用 multi-agent 路径：规范化 -> pairrank -> fuse
        if agent_outputs:
            try:
                candidates = normalize_agent_outputs(agent_outputs)
                signals = research_fusion.get("comp_scores") if isinstance(research_fusion, dict) else None
                ranked_agent = pairrank_from_candidates(candidates, signals)
                fused_agent = fuse_rule_based(ranked_agent)
                fused_agent["agent_based"] = True
                fused_agent["agent_outputs"] = agent_outputs

                # 替换原有的 ranked/fused 输出以反映 agent-based 融合
                ranked = ranked_agent
                fused = fused_agent
            except Exception:
                # 如果处理失败，保留原有本地融合结果
                pass

        # === Self-correction integration (optional) ===
        # If OPCcomp accuracy gate and adapter are available, evaluate fused result
        # and trigger a single self-correction loop when adapter suggests.
        try:
            if AccuracyGate is not None and create_adapter_for_m9 is not None:
                try:
                    gate = AccuracyGate()
                    eval_result = gate.evaluate_router_payload(fused, output_id="router_output")
                except Exception:
                    gate = None
                    eval_result = None

                if gate is not None:
                    try:
                        adapter = create_adapter_for_m9(
                            gate=gate,
                            service_client=self.client,
                            orchestrator=self.evidence_orchestrator,
                            info_pool=self.info_pool,
                            reference_date=None,
                        )

                        should = False
                        try:
                            should = adapter.should_trigger_correction(eval_result, enable_web_search=True)
                        except Exception:
                            should = False

                        if should:
                            # prepare a textual representation of fused result for correction
                            try:
                                fused_text = json.dumps(fused, ensure_ascii=False)
                            except Exception:
                                fused_text = str(fused)

                            try:
                                sc_result = adapter.correct(fused_text, user_text, output_id="router_output")
                                # attach correction metadata to fused result
                                fused["self_correction"] = {
                                    "applied": bool(sc_result.correction_applied),
                                    "total_iterations": sc_result.total_iterations,
                                    "final_gate_decision": getattr(sc_result, "final_gate_decision", None).value if getattr(sc_result, "final_gate_decision", None) else None,
                                    "final_output": sc_result.final_output,
                                }
                            except Exception:
                                # ignore self-correction failures but do not block pipeline
                                pass
                    except Exception:
                        # adapter creation failed; skip self-correction
                        pass
        except Exception:
            # defensive: do not let self-correction errors break main flow
            pass

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
            "intent": intent,
            "selected_experts": selected_experts,
            "collaboration_plan": self._build_collaboration_plan(selected_experts),
            "info_pool_hits": info_hits,
            "knowledge_graph_hits": knowledge_graph_hits,
            "research_fusion": research_fusion,
            "ranked_candidates": ranked,
            "fused_result": fused,
            "evidence_orchestration_result": orchestration_result,
            "remote_llm": remote,
            "agent_outputs": agent_outputs,
            "output_attribution": self._build_output_attribution(remote_called=remote_called, remote_available=remote is not None),
            "runtime_trace": {
                "small_model_called": True,
                "small_model_callsite": "pipeline.run -> SmallModelRouter.route",
                "small_model_backend": small_model_result.get("backend", "heuristic"),
                "small_model_backend_reason": small_model_result.get("backend_reason", ""),
                "task_intent_conf_threshold": self.task_intent_confidence_threshold,
                "intent_parse_fallback_score_threshold": self.intent_parse_fallback_score_threshold,
                "intent_parse_fallback_text_length": self.intent_parse_fallback_text_length,
                "remote_llm_called": remote_called,
                "qianfan_called": bool(agent_outputs),
                "remote_llm_callsite": "pipeline.run -> self.client.chat",
                "research_fusion_enabled": bool(research_fusion.get("enabled")),
                "research_fusion_risk_level": research_fusion.get("research_risk_level", ""),
                "provider": self.provider,
                "model": self.service_model,
                # ── 证据管道元数据（供 TypeScript 侧 renderTaskReport 消费 ──
                "search_triggered": bool(
                    orchestration_result and getattr(orchestration_result, "search_triggered", False)
                ) or bool(fused.get("evidence_orchestration_metadata", {}).get("search_triggered", False)),
                "self_iteration_rounds": int(
                    fused.get("self_correction", {}).get("total_iterations", 0)
                    if isinstance(fused.get("self_correction"), dict) else 0
                ),
                "kg_contradictions": 0,  # TODO: 接入 KG 矛盾检测后填充实际值
                "knowledge_graph_hit_count": len(knowledge_graph_hits),
                "info_pool_hit_count": len(info_hits),
            },
        }
