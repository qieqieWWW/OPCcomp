#!/usr/bin/env python
# coding: utf-8

"""
Pipeline 集成补丁 - 证据编排层

用意：
1. 在初始化时创建证据编排器
2. 在 run 方法中调用编排器
3. 将编排后的证据融合到候选项中

应用方式：
将此文件中的代码段复制到 pipeline.py 对应位置
"""

# ============================================================
# 补丁 1：在 __post_init__ 中添加编排器初始化
# ============================================================

PATCH_1_OLD = """    def __post_init__(self) -> None:
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
        )"""

PATCH_1_NEW = """    def __post_init__(self) -> None:
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
        self.evidence_orchestrator = self._init_evidence_orchestrator()"""

# ============================================================
# 补丁 2：添加编排器初始化方法
# ============================================================

NEW_METHOD_INIT_ORCHESTRATOR = """    def _init_evidence_orchestrator(self):
        \"\"\"初始化证据编排器\"\"\"
        try:
            from pathlib import Path as PathlibPath
            from sys import path as sys_path
            
            repo_root = (self.project_root / ".." / "..").resolve()
            if str(repo_root) not in sys_path:
                sys_path.insert(0, str(repo_root))
            
            # 延迟导入以避免循环依赖
            from OPCcomp.evidence_orchestrator import EvidenceOrchestrator
            from OPCcomp.web_retriever import WebRetriever
            
            web_retriever = None
            if os.getenv("ENABLE_WEB_SEARCH", "false").lower() == "true":
                web_retriever = WebRetriever(
                    api_key=os.getenv("SERPER_API_KEY"),
                    engine=os.getenv("WEB_ENGINE", "mock"),
                    cache_dir=os.getenv("WEB_CACHE_DIR", "./web_cache"),
                )
            
            return EvidenceOrchestrator(
                kb_retriever=None,  # 暂无
                info_pool_retriever=lambda q, top_k: retrieve_from_info_pool(q, self.info_pool, top_k),
                web_retriever=web_retriever,
                enable_deduplication=True,
            )
        except ImportError:
            return None"""

# ============================================================
# 补丁 3：在 run 方法中调用编排器
# ============================================================

PATCH_3_OLD = """        ranked = pairrank(candidates)
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
            "intent": intent,
            "selected_experts": selected_experts,
            "collaboration_plan": self._build_collaboration_plan(selected_experts),
            "info_pool_hits": info_hits,
            "knowledge_graph_hits": knowledge_graph_hits,
            "research_fusion": research_fusion,
            "ranked_candidates": ranked,
            "fused_result": fused,
            "remote_llm": remote,
            "output_attribution": self._build_output_attribution(remote_called=remote_called, remote_available=remote is not None),"""

PATCH_3_NEW = """        ranked = pairrank(candidates)
        fused = fuse_rule_based(ranked)
        
        # 调用证据编排器 - 补充证据
        orchestration_result = None
        if self.evidence_orchestrator:
            try:
                from OPCcomp.evidence_orchestrator import EvidenceRequest
                request = EvidenceRequest(
                    query=user_text,
                    output_claims=list(fused.get("fused_actions", [])),
                    query_category=tier.lower() if tier else "general",
                    required_evidence_count=3,
                    min_evidence_coverage=0.7,
                    allow_web_search=os.getenv("ENABLE_WEB_SEARCH", "false").lower() == "true",
                    context={"tier": tier, "intent_type": intent.get("type", "")}
                )
                orchestration_result = self.evidence_orchestrator.orchestrate(request)
                
                # 融合到候选项
                if orchestration_result.search_triggered:
                    fused["evidence_orchestration"] = {
                        "triggered": True,
                        "internal_evidence_count": len(orchestration_result.internal_evidence),
                        "external_evidence_count": len(orchestration_result.external_evidence),
                        "coverage_score": orchestration_result.coverage_score,
                        "quality_score": orchestration_result.orchestration_quality,
                    }
            except Exception as e:
                orchestration_result = None

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
            "output_attribution": self._build_output_attribution(remote_called=remote_called, remote_available=remote is not None),"""

# ============================================================
# 注意：以下导入应该在文件顶部添加
# ============================================================

REQUIRED_IMPORTS = """import os  # 添加此行以支持 os.getenv"""
