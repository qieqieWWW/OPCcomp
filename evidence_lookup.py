from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Any, Optional
import sys

# 动态导入处理：支持作为包和独立脚本运行
try:
    from .graph_index_builder import build_graph_index
    from . import m7_global_kb
except ImportError:
    # 作为独立脚本运行时的导入
    try:
        from graph_index_builder import build_graph_index
        import m7_global_kb
    except ImportError:
        # 动态导入
        import importlib.util
        current_dir = Path(__file__).parent
        
        graph_spec = importlib.util.spec_from_file_location(
            "graph_index_builder",
            current_dir / "graph_index_builder.py"
        )
        m7_spec = importlib.util.spec_from_file_location(
            "m7_global_kb",
            current_dir / "m7_global_kb.py"
        )
        
        graph_module = importlib.util.module_from_spec(graph_spec)
        m7_global_kb = importlib.util.module_from_spec(m7_spec)
        
        sys.modules['graph_index_builder'] = graph_module
        sys.modules['m7_global_kb'] = m7_global_kb
        
        graph_spec.loader.exec_module(graph_module)
        m7_spec.loader.exec_module(m7_global_kb)
        
        build_graph_index = graph_module.build_graph_index


class EvidenceLookup:
    """Provide evidence id lookup and optional reuse of m7 retrieval logic."""

    def __init__(self, index_path: str):
        self.index_path = Path(index_path)
        if not self.index_path.exists():
            raise FileNotFoundError(f"Evidence index not found: {index_path}")
        with self.index_path.open("r", encoding="utf-8") as f:
            self.index = json.load(f)
        self.graph = build_graph_index(index_path)
        self.evidence_id_map = self.graph["evidence_id_map"]
        self._evidence_nodes = [n for n in self.graph["nodes"] if n.get("type") == "Evidence"]

    def get(self, evidence_id: str) -> Optional[Dict[str, Any]]:
        """获取单个证据，返回 None 如果证据为空或不存在"""
        evidence = self.index.get(evidence_id)
        # 过滤空对象
        if evidence and evidence != {}:
            return evidence
        return None

    def lookup_with_m7(self, evidence_id: str, query: str) -> Dict[str, Any]:
        """
        If m7's retrieve_global_kb exists, use it to enrich lookup results.
        Otherwise return the stored evidence metadata.
        """
        base = self.get(evidence_id)
        if base is None:
            return {"found": False}

        result = {"found": True, "metadata": base}

        # Try to retrieve related KB records using m7_global_kb
        try:
            candidates = m7_global_kb.retrieve_global_kb(query, top_k=5)
            result["m7_candidates"] = candidates
        except Exception as e:
            result["m7_error"] = str(e)

        return result

    def get_evidence_by_id(self, evidence_id):
        """根据evidence_id回查证据节点"""
        return self.evidence_id_map.get(evidence_id)

    def search(self, query):
        """支持按属性查找证据（在索引中搜索）
        
        Args:
            query: dict，支持多个搜索条件
                - {"source": "black_swan"}
                - {"scenario_id": "ood_scenario_0001"}
                - {"source": "black_swan", "scenario_id": "ood_scenario_0001"}
        
        Returns:
            list of evidence dicts matching the query (排除空对象)
        """
        results = []
        for evidence_id, evidence in self.index.items():
            # ✅ 过滤空对象
            if not evidence or evidence == {}:
                continue
            
            match = True
            for k, v in query.items():
                # 支持在多个层级查找
                # 1. 直接在顶层查找 (source, scenario_id)
                if evidence.get(k) == v:
                    continue
                # 2. 在 raw 字段查找
                elif evidence.get('raw', {}).get(k) == v:
                    continue
                else:
                    match = False
                    break
            
            if match:
                results.append(evidence)
        
        return results

    def retrieve_kb(self, query: str, top_k: int = 5):
        """知识库检索：从索引中进行相似度检索
        
        使用 M7 的相似度计算算法，但数据源是本地索引
        
        Args:
            query: 查询文本（中文或英文）
            top_k: 返回结果数
        
        Returns:
            list of dicts: [{"score": float, "record": evidence_dict}, ...]
        """
        # 将索引数据转换为可检索的格式
        kb_records = []
        for evidence_id, evidence in self.index.items():
            record = {
                'id': evidence_id,
                'title': evidence.get('raw', {}).get('name', ''),
                'description': evidence.get('raw', {}).get('description', ''),
                'category': evidence.get('raw', {}).get('type', ''),
                'source': evidence.get('source', ''),
                'scenario_id': evidence.get('scenario_id', ''),
                'severity': evidence.get('raw', {}).get('severity', 0),
            }
            kb_records.append(record)
        
        # 使用 M7 的检索算法
        def load_kb_from_index(kb_path=None):
            return kb_records
        
        # Monkey patch 加载函数
        old_loader = m7_global_kb.load_global_kb_records
        m7_global_kb.load_global_kb_records = load_kb_from_index
        
        try:
            results = m7_global_kb.retrieve_global_kb(query, top_k=top_k)
            # 补充完整的原始证据数据
            enriched_results = []
            for item in results:
                record = item.get('record', {})
                evidence_id = record.get('id')
                if evidence_id and evidence_id in self.index:
                    item['full_evidence'] = self.index[evidence_id]
                enriched_results.append(item)
            return enriched_results
        finally:
            m7_global_kb.load_global_kb_records = old_loader
    
    def initialize_with_custom_data(self, data_dict: Dict[str, Any]):
        """允许使用自定义数据初始化索引（不仅限于 M12）
        
        这使 EvidenceLookup 成为通用的证据查询工具
        
        Args:
            data_dict: 证据字典，格式与 evidence_index.json 相同
                {
                    "evidence_id": {
                        "scenario_id": "...",
                        "source": "...",
                        "raw": {...}
                    }
                }
        
        Returns:
            self (便于链式调用)
        
        Example:
            # 使用自定义数据
            custom_data = {
                "custom_evidence_1": {
                    "scenario_id": "scenario_A",
                    "source": "custom_source",
                    "raw": {"name": "自定义证据", "type": "custom_type"}
                }
            }
            el = EvidenceLookup("dummy.json")
            el.initialize_with_custom_data(custom_data)
            results = el.search({"source": "custom_source"})
        """
        self.index.update(data_dict)
        return self
    
    def batch_query(self, evidence_ids: list) -> Dict[str, Any]:
        """批量查询多个证据
        
        Args:
            evidence_ids: list of evidence IDs
        
        Returns:
            dict: {evidence_id: evidence_data, ...}
        """
        results = {}
        for eid in evidence_ids:
            evidence = self.get(eid)
            if evidence:
                results[eid] = evidence
        return results
    
    def get_statistics(self) -> Dict[str, Any]:
        """..."""
        # ...existing code...
        return stats
    
    def is_valid_evidence(self, evidence_id: str) -> bool:
        """检查证据是否有效（非空且包含基本字段）
        
        Args:
            evidence_id: 证据 ID
        
        Returns:
            bool: True 如果证据有效，False 如果为空或缺少必要字段
        """
        evidence = self.index.get(evidence_id)
        
        # 检查是否为空
        if not evidence or evidence == {}:
            return False
        
        # 检查是否有必要的字段
        required_fields = ['source', 'scenario_id', 'raw']
        for field in required_fields:
            if field not in evidence:
                return False
        
        return True
    
    def get_valid_evidence(self, evidence_id: str) -> Optional[Dict[str, Any]]:
        """获取有效的证据（检查完整性）
        
        Args:
            evidence_id: 证据 ID
        
        Returns:
            dict: 有效证据对象，或 None 如果无效
        """
        if self.is_valid_evidence(evidence_id):
            return self.index.get(evidence_id)
        return None
    
    def filter_valid_evidence(self, evidence_list: list = None) -> list:
        """过滤有效的证据（移除空对象和不完整的证据）
        
        Args:
            evidence_list: 证据列表，如果为 None 则使用索引中的所有证据
        
        Returns:
            list: 只包含有效证据的列表
        """
        if evidence_list is None:
            evidence_list = list(self.index.values())
        
        valid_evidence = []
        for evidence in evidence_list:
            if evidence and evidence != {} and 'source' in evidence and 'raw' in evidence:
                valid_evidence.append(evidence)
        
        return valid_evidence
    
    def search_valid(self, query) -> list:
        """按属性搜索有效证据（自动过滤空对象）
        
        Args:
            query: dict，搜索条件
        
        Returns:
            list: 只包含有效证据的搜索结果
        """
        results = self.search(query)
        return self.filter_valid_evidence(results)
