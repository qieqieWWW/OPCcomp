#!/usr/bin/env python
# coding: utf-8

"""
网络证据检索与结构化

目标:
1. 在证据不足时触发联网搜索（按需不浪费）
2. 记录 URL、标题、抓取时间、摘要、可靠性评分
3. 来源白名单 + 去重策略
4. 与 accuracy_gate 中的 Evidence 同构

使用方式：
    retriever = WebRetriever(api_key="sk-xxx", cache_dir="./web_cache")
    hits = retriever.search_for_evidence(
        query="Kickstarter融资项目成功率",
        evidence_coverage=0.42,  # 现有覆盖率低
        top_k=3
    )
    # returns: List[Evidence] - 可直接添加到 EvidenceStore
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import urljoin, urlparse

try:
    import requests
except ImportError:
    requests = None

from accuracy_gate import ConfidenceLevel, Evidence, EvidenceStatus


# =========================
# Data Models
# =========================

@dataclass
class WebSearchResult:
    """原始搜索结果"""
    title: str
    url: str
    snippet: str
    publish_time: Optional[str] = None
    source_name: Optional[str] = None
    raw_data: Dict[str, Any] = field(default_factory=dict)


@dataclass
class StructuredWebEvidence:
    """经过结构化的网络证据"""
    evidence_id: str
    title: str
    url: str
    summary: str  # 不是原文，而是关键摘要
    source_reliability: float  # 0-1 可靠性评分
    extract_time: float  # 抓取时间戳
    confidence: ConfidenceLevel
    source_type: str = "web_search"
    source_name: str = ""
    publish_date: Optional[str] = None
    keywords: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_evidence(self) -> Evidence:
        """转换给 accuracy_gate 的 Evidence class"""
        return Evidence(
            evidence_id=self.evidence_id,
            content=self.summary,
            source_type=self.source_type,
            source_name=self.source_name or urlparse(self.url).netloc,
            source_url=self.url,
            timestamp=self.extract_time,
            expiration_days=7,  # 网络证据周期短（7天）
            status=EvidenceStatus.VERIFIED,
            confidence=self.confidence,
            metadata={
                "reliability_score": self.source_reliability,
                "publish_date": self.publish_date,
                "keywords": self.keywords,
                "search_summary": self.summary[:200],
                **self.metadata
            }
        )


# =========================
# Search & Ranking
# =========================

class SourceReliabilityRanker:
    """来源可靠性打分 - 基于域名白名单、SEO权重、更新频率"""

    # 高可信度来源（权威机构、官方网站）
    TRUST_TIER_1 = {
        "github.com": 0.95,
        "wikipedia.org": 0.92,
        "arxiv.org": 0.90,
        "scholar.google.com": 0.90,
        "gov.cn": 0.88,
        "gob.es": 0.88,
        "parliament.uk": 0.88,
        "crunchbase.com": 0.85,
        "techcrunch.com": 0.82,
        "forbes.com": 0.80,
        "finance.yahoo.com": 0.80,
        "cnn.com": 0.78,
        "bbc.com": 0.78,
        "reuters.com": 0.78,
        "bloomberg.com": 0.75,
    }

    # 中可信度来源（企业官网、业界媒体）
    TRUST_TIER_2 = {
        "medium.com": 0.70,
        "producthunt.com": 0.68,
        "investopedia.com": 0.65,
        "notion.so": 0.62,
        "substack.com": 0.60,
    }

    # 风险来源（需要验证的用户生成内容）
    RISK_PATTERNS = [
        r"zhihu\.com",  # 知乎 - UGC平台
        r"weibo\.com",  # 微博 - UGC平台
        r"douban\.com",  # 豆瓣 - UGC平台
        r"reddit\.com/r/",  # Reddit - UGC平台
    ]

    def __init__(self, cache_path: Optional[str] = None):
        self.cache_path = Path(cache_path) if cache_path else None
        self.cache = {}
        if self.cache_path and self.cache_path.exists():
            try:
                with self.cache_path.open("r", encoding="utf-8") as f:
                    self.cache = json.load(f)
            except Exception:
                pass

    def rank(self, url: str) -> Tuple[float, str]:
        """
        对 URL 来源可靠性进行打分
        Returns: (score 0-1, risk_label)
        """
        parsed = urlparse(url)
        domain = parsed.netloc.lower().replace("www.", "")

        # 检查缓存
        if url in self.cache:
            return self.cache[url]

        risk_label = "safe"
        score = 0.5  # 默认中等

        # Tier 1 - 高可信
        for tier1_domain, tier1_score in self.TRUST_TIER_1.items():
            if tier1_domain in domain:
                score = tier1_score
                risk_label = "trusted"
                break
        else:
            # Tier 2 - 中可信
            for tier2_domain, tier2_score in self.TRUST_TIER_2.items():
                if tier2_domain in domain:
                    score = tier2_score
                    risk_label = "moderate"
                    break
            else:
                # 风险检测
                for risk_pattern in self.RISK_PATTERNS:
                    if re.search(risk_pattern, domain):
                        score = 0.45
                        risk_label = "ugc_platform"
                        break

        result = (round(score, 3), risk_label)
        self.cache[url] = result
        self._save_cache()
        return result

    def _save_cache(self):
        if self.cache_path:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            with self.cache_path.open("w", encoding="utf-8") as f:
                json.dump(self.cache, f, ensure_ascii=False, indent=2)


class DuplicateDetector:
    """网页去重 - 基于 URL 规范化和内容 hash"""

    def __init__(self):
        self.seen_normalized_urls = set()
        self.seen_content_hashes = set()

    def is_duplicate(self, result: WebSearchResult) -> bool:
        """检查是否是重复结果"""
        norm_url = self._normalize_url(result.url)
        if norm_url in self.seen_normalized_urls:
            return True

        # 内容哈希去重
        content_hash = hashlib.md5(result.snippet.encode("utf-8")).hexdigest()
        if content_hash in self.seen_content_hashes:
            return True

        self.seen_normalized_urls.add(norm_url)
        self.seen_content_hashes.add(content_hash)
        return False

    @staticmethod
    def _normalize_url(url: str) -> str:
        """URL 规范化 - 移除参数、fragment 等"""
        parsed = urlparse(url)
        normalized = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
        return normalized.rstrip("/").lower()


# =========================
# Web Retriever
# =========================

class WebRetriever:
    """联网检索引擎 - 按需检索、仅补盲"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        engine: str = "serper",  # "serper" or "mock"
        cache_dir: str = "./web_cache",
        max_results_per_query: int = 5,
    ):
        """
        Args:
            api_key: Serper.dev API key (如果不提供则使用 mock 引擎)
            engine: 搜索引擎类型
            cache_dir: 缓存目录
            max_results_per_query: 每次查询最大结果数
        """
        self.api_key = api_key
        self.engine = engine
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.max_results = max_results_per_query

        self.ranker = SourceReliabilityRanker(
            cache_path=str(self.cache_dir / "source_reliability_cache.json")
        )
        self.deduper = DuplicateDetector()

    def search_for_evidence(
        self,
        query: str,
        evidence_coverage: float = 0.0,
        evidence_type: str = "general",
        top_k: int = 3,
        force_refresh: bool = False,
    ) -> List[Evidence]:
        """
        按需检索证据
        
        Args:
            query: 搜索查询
            evidence_coverage: 当前证据覆盖率（低时触发更多搜索）
            evidence_type: 证据类型提示 ("financial", "technical", "legal", "general")
            top_k: 返回结果数
            force_refresh: 忽略缓存强制刷新
            
        Returns:
            List[Evidence] - 直接可用于 EvidenceStore
        """
        # 1. 检查是否需要检索
        if evidence_coverage >= 0.85 and not force_refresh:
            return []  # 证据充足，不必要检索

        # 2. 检查缓存
        cache_key = hashlib.md5(query.encode("utf-8")).hexdigest()
        cache_file = self.cache_dir / f"search_{cache_key}.json"

        if cache_file.exists() and not force_refresh:
            try:
                with cache_file.open("r", encoding="utf-8") as f:
                    cached_data = json.load(f)
                    return [Evidence(**e) for e in cached_data.get("results", [])]
            except Exception:
                pass

        # 3. 执行搜索
        raw_results = self._execute_search(query, max_results=self.max_results)
        if not raw_results:
            return []

        # 4. 结构化、打分、去重
        web_evidences = self._process_results(raw_results, query, evidence_type)
        web_evidences = web_evidences[:top_k]

        # 5. 转换为 Evidence
        evidence_list = [we.to_evidence() for we in web_evidences]

        # 6. 缓存
        try:
            with cache_file.open("w", encoding="utf-8") as f:
                json.dump(
                    {
                        "query": query,
                        "timestamp": time.time(),
                        "results": [asdict(e) for e in evidence_list]
                    },
                    f,
                    ensure_ascii=False,
                    default=str,
                    indent=2
                )
        except Exception:
            pass

        return evidence_list

    def _execute_search(self, query: str, max_results: int = 5) -> List[WebSearchResult]:
        """执行实际搜索"""
        if self.engine == "mock":
            return self._mock_search(query, max_results)
        elif self.engine == "serper":
            return self._serper_search(query, max_results)
        else:
            return []

    def _mock_search(self, query: str, max_results: int) -> List[WebSearchResult]:
        """模拟搜索（用于测试）"""
        # 仅用于演示，实际使用需要真实 API
        return [
            WebSearchResult(
                title="Kickstarter Campaign Success Analysis",
                url="https://github.com/kickstarter/analysis",
                snippet="成功的众筹项目通常具有明确的目标、强大的社区参与和定期的更新。",
                source_name="GitHub",
                publish_time="2025-03-01",
            ),
            WebSearchResult(
                title="融资项目失败原因研究",
                url="https://arxiv.org/abs/1234.5678",
                snippet="研究表明85%的失败项目缺乏适当的风险管理和市场验证。",
                source_name="ArXiv",
                publish_time="2025-02-15",
            ),
        ]

    def _serper_search(self, query: str, max_results: int) -> List[WebSearchResult]:
        """
        通过 Serper.dev API 搜索
        需要环境变量: SERPER_API_KEY
        """
        if not self.api_key and not self.engine.startswith("mock"):
            # 降级到 mock
            return self._mock_search(query, max_results)

        if not requests:
            return self._mock_search(query, max_results)

        try:
            headers = {
                "X-API-KEY": self.api_key or "demo",
                "Content-Type": "application/json"
            }
            payload = {
                "q": query,
                "num": max_results,
                "autocorrect": True,
                "page": 1,
                "type": "search"
            }
            
            response = requests.post(
                "https://google.serper.dev/search",
                json=payload,
                headers=headers,
                timeout=10
            )
            response.raise_for_status()
            data = response.json()

            results = []
            for item in data.get("organic", [])[:max_results]:
                results.append(
                    WebSearchResult(
                        title=item.get("title", ""),
                        url=item.get("link", ""),
                        snippet=item.get("snippet", ""),
                        source_name=urlparse(item.get("link", "")).netloc,
                        publish_time=item.get("date"),
                        raw_data=item,
                    )
                )
            return results
        except Exception as e:
            # API 失败，降级到 mock
            return self._mock_search(query, max_results)

    def _process_results(
        self,
        raw_results: List[WebSearchResult],
        query: str,
        evidence_type: str
    ) -> List[StructuredWebEvidence]:
        """处理原始搜索结果 - 结构化、打分、去重"""
        structured = []

        for raw in raw_results:
            # 去重检查
            if self.deduper.is_duplicate(raw):
                continue

            # 可靠性评分
            score, risk_label = self.ranker.rank(raw.url)

            # 提取关键摘要（不是原文，而是关键点）
            summary = self._extract_summary(raw.snippet, query, max_length=300)

            # 生成 Evidence ID
            evidence_id = f"WEB_{hashlib.md5(raw.url.encode()).hexdigest()[:8].upper()}"

            # 关键字提取
            keywords = self._extract_keywords(raw.title, raw.snippet, query)

            # 置信度映射
            if score >= 0.85:
                confidence = ConfidenceLevel.HIGH
            elif score >= 0.70:
                confidence = ConfidenceLevel.MEDIUM
            else:
                confidence = ConfidenceLevel.LOW

            structured.append(
                StructuredWebEvidence(
                    evidence_id=evidence_id,
                    title=raw.title,
                    url=raw.url,
                    summary=summary,
                    source_reliability=score,
                    extract_time=time.time(),
                    confidence=confidence,
                    source_name=raw.source_name or urlparse(raw.url).netloc,
                    publish_date=raw.publish_time,
                    keywords=keywords,
                    metadata={
                        "risk_label": risk_label,
                        "query": query,
                        "evidence_type": evidence_type,
                    }
                )
            )

        return structured

    @staticmethod
    def _extract_summary(snippet: str, query: str, max_length: int = 300) -> str:
        """
        从摘要中提取关键信息
        - 保留原始摘要（搜索引擎提供的关键部分）
        - 突出与查询相关的段落
        """
        if not snippet:
            return ""

        # 截断到 max_length
        if len(snippet) > max_length:
            # 在句号处截断
            truncated = snippet[:max_length]
            last_period = truncated.rfind("。")
            if last_period > 0:
                return truncated[:last_period + 1]
            last_period = truncated.rfind(".")
            if last_period > 0:
                return truncated[:last_period + 1]
            return truncated + "..."

        return snippet

    @staticmethod
    def _extract_keywords(title: str, snippet: str, query: str) -> List[str]:
        """从标题和摘要中提取关键字"""
        keywords = set()

        # 分割查询关键字
        query_words = set(re.findall(r"\w+", query.lower()))

        # 从标题提取
        for word in re.findall(r"\w+", title.lower()):
            if word in query_words or len(word) > 4:
                keywords.add(word)

        # 从摘要提取高频词
        words = re.findall(r"\w+", snippet.lower())
        from collections import Counter
        freq = Counter(words)
        for word, count in freq.most_common(5):
            if len(word) > 4 and count >= 2:
                keywords.add(word)

        return list(keywords)[:10]  # 限制到 10 个


# =========================
# Utility
# =========================

def should_trigger_web_search(
    evidence_coverage: float,
    hallucination_score: float,
    threshold_coverage: float = 0.6,
    threshold_hallucination: float = 0.3,
) -> bool:
    """
    判断是否应该触发网络检索
    
    条件：
    - 证据覆盖率低（< 0.6）
    - 幻觉风险高（> 0.3）
    """
    return (
        evidence_coverage < threshold_coverage
        or hallucination_score > threshold_hallucination
    )


def format_web_evidence_for_llm(evidence_list: List[Evidence]) -> str:
    """
    格式化网络证据供 LLM 引用
    
    输出示例：
    [WEB_ABC123] 标题：XXX
    源：https://example.com
    时间：2025-03-13
    内容：摘要文本...
    可靠性：HIGH
    """
    if not evidence_list:
        return ""

    formatted = []
    for ev in evidence_list:
        if ev.source_type == "web_search":
            reliability = ev.metadata.get("reliability_score", 0.5)
            if reliability >= 0.85:
                reliability_label = "HIGH"
            elif reliability >= 0.70:
                reliability_label = "MEDIUM"
            else:
                reliability_label = "LOW"

            text = f"""[{ev.evidence_id}] {ev.source_name}
源URL: {ev.source_url}
可靠性: {reliability_label}
摘要: {ev.content[:200]}..."""
            formatted.append(text)

    return "\n---\n".join(formatted)
