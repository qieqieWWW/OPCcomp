"""
知识图谱schema定义：节点类型、关系类型、属性结构
"""
from __future__ import annotations
from enum import Enum

class NodeType(str, Enum):
    Project = 'Project'
    RiskFactor = 'RiskFactor'
    Rule = 'Rule'
    Scenario = 'Scenario'
    Evidence = 'Evidence'
    Metric = 'Metric'

class EdgeType(str, Enum):
    Triggers = 'triggers'
    Supports = 'supports'
    Contradicts = 'contradicts'
    DerivedFrom = 'derived_from'

NODE_SCHEMA = {
    'Project': [
        'id', 'name', 'main_category', 'country', 'goal_usd', 'duration_days', 'predicted_status', 'success_probability', 'source_file', 'report_id', 'timestamp', 'total_scenarios'
    ],
    'RiskFactor': [
        'id', 'feature', 'value'
    ],
    'Rule': [
        'id', 'text'
    ],
    'Scenario': [
        'id', 'scenario_id', 'name', 'description', 'difficulty'
    ],
    'Evidence': [
        'id', 'evidence_id', 'type', 'name', 'description', 'severity', 'duration', 'feature', 'magnitude', 'direction', 'is_gradual'
    ],
    'Metric': [
        'id', 'scenario_id', 'survival_rate', 'avg_risk_increase', 'recovery_speed', 'worst_case_performance', 'adaptability_score', 'overall_resilience'
    ]
}

EDGE_SCHEMA = {
    'triggers': ['Evidence', 'Scenario'],
    'supports': ['Evidence', 'Metric'],
    'contradicts': ['Evidence', 'Evidence'],
    'derived_from': ['RiskFactor', 'Project'],
}




import json
from dataclasses import dataclass, asdict
from typing import Dict, Any, List, Tuple, Optional
from uuid import uuid4
from datetime import datetime
from pathlib import Path
import csv


@dataclass
class Node:
    id: str
    label: str
    properties: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return {"id": self.id, "label": self.label, "properties": self.properties}


@dataclass
class Edge:
    source: str
    target: str
    rel_type: str
    properties: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return {"source": self.source, "target": self.target, "type": self.rel_type, "properties": self.properties}


def _gen_evidence_id(prefix: str = "evidence") -> str:
    """Generate a compact evidence id usable for backreference."""
    return f"{prefix}_{datetime.utcnow().strftime('%Y%m%dT%H%M%S')}_{uuid4().hex[:8]}"


# Existing M12 report parser kept (unchanged behavior)
def create_nodes_edges_from_report(report: Dict[str, Any]) -> Tuple[List[Node], List[Edge], Dict[str, Dict[str, Any]]]:
    nodes: List[Node] = []
    edges: List[Edge] = []
    evidence_index: Dict[str, Dict[str, Any]] = {}

    # Top-level report info as a Project node
    report_id = report.get("report_id", f"report_{uuid4().hex[:8]}")
    project_node_id = f"project_{report_id}"
    project_node = Node(id=project_node_id, label="Project", properties={
        "report_id": report_id,
        "timestamp": report.get("timestamp"),
        "total_scenarios": report.get("summary", {}).get("total_scenarios")
    })
    nodes.append(project_node)

    # Iterate scenarios and their metrics
    detailed = report.get("detailed_results", {})
    scenarios = detailed.get("scenarios", [])
    metrics = detailed.get("resilience_metrics", [])

    # Build quick map scenario_id->metrics
    metrics_map = {m.get("scenario_id"): m for m in metrics}

    for sc in scenarios:
        sid = sc.get("scenario_id")
        scen_node = Node(id=f"scenario_{sid}", label="Scenario", properties={
            "scenario_id": sid,
            "name": sc.get("name"),
            "description": sc.get("description"),
            "difficulty": sc.get("difficulty_level")
        })
        nodes.append(scen_node)

        # derived_from: Scenario -> Project
        edges.append(Edge(source=scen_node.id, target=project_node.id, rel_type="derived_from", properties={}))

        # Associate metrics node
        m = metrics_map.get(sid)
        if m:
            metric_node_id = f"metric_{sid}"
            metric_node = Node(id=metric_node_id, label="Metric", properties=m)
            nodes.append(metric_node)
            edges.append(Edge(source=metric_node_id, target=scen_node.id, rel_type="supports", properties={"kind": "resilience"}))

        # Evidence: black swan events
        for ev in sc.get("black_swan_events", []):
            evidence_id = _gen_evidence_id("bs")
            ev_props = {
                "evidence_id": evidence_id,
                "type": ev.get("event_type"),
                "name": ev.get("name"),
                "description": ev.get("description"),
                "severity": ev.get("severity"),
                "duration": ev.get("duration")
            }
            ev_node = Node(id=f"evidence_{evidence_id}", label="Evidence", properties=ev_props)
            nodes.append(ev_node)

            # triggers: Evidence -> Scenario
            edges.append(Edge(source=ev_node.id, target=scen_node.id, rel_type="triggers", properties={}))

            # support: Evidence supports a Metric if it raised severity
            if m:
                edges.append(Edge(source=ev_node.id, target=f"metric_{sid}", rel_type="supports", properties={}))

            evidence_index[evidence_id] = {"scenario_id": sid, "source": "black_swan", "raw": ev_props}

        # Evidence: distribution shifts
        for ds in sc.get("distribution_shifts", []):
            evidence_id = _gen_evidence_id("drift")
            ds_props = {
                "evidence_id": evidence_id,
                "type": ds.get("shift_type"),
                "feature": ds.get("target_feature"),
                "magnitude": ds.get("drift_magnitude"),
                "direction": ds.get("shift_direction"),
                "is_gradual": ds.get("is_gradual")
            }
            ds_node = Node(id=f"evidence_{evidence_id}", label="Evidence", properties=ds_props)
            nodes.append(ds_node)
            edges.append(Edge(source=ds_node.id, target=scen_node.id, rel_type="triggers", properties={"kind": "distribution_shift"}))
            if m:
                edges.append(Edge(source=ds_node.id, target=f"metric_{sid}", rel_type="supports", properties={}))
            evidence_index[evidence_id] = {"scenario_id": sid, "source": "distribution_shift", "raw": ds_props}

        # RiskFactor nodes: infer from base_project keys and create supports/contradicts
        base = sc.get("base_project", {}) or {}
        for k, v in base.items():
            if k in ["goal_ratio", "time_penalty", "category_risk", "combined_risk", "country_factor", "urgency_score"]:
                rf_id = f"risk_{sid}_{k}"
                rf_node = Node(id=rf_id, label="RiskFactor", properties={"feature": k, "value": v})
                nodes.append(rf_node)
                # risk factor derived_from project
                proj_ref = f"project_{report_id}"
                edges.append(Edge(source=rf_id, target=proj_ref, rel_type="derived_from", properties={}))
                # connects to scenario
                edges.append(Edge(source=rf_id, target=scen_node.id, rel_type="supports", properties={}))

        # Rules: if report contains recommendations, represent as Rule nodes
        for idx, rec in enumerate(report.get("recommendations", []) or []):
            rule_id = f"rule_{sid}_{idx}"
            rule_node = Node(id=rule_id, label="Rule", properties={"text": rec})
            nodes.append(rule_node)
            # Rule supports or contradicts based on keywords
            if any(x in rec.lower() for x in ["不足", "弱", "慢", "风险"]):
                edges.append(Edge(source=rule_id, target=scen_node.id, rel_type="contradicts", properties={}))
            else:
                edges.append(Edge(source=rule_id, target=scen_node.id, rel_type="supports", properties={}))

    # De-duplicate nodes by id (keep first)
    unique_nodes: Dict[str, Node] = {}
    for n in nodes:
        if n.id not in unique_nodes:
            unique_nodes[n.id] = n
    nodes = list(unique_nodes.values())

    # De-duplicate edges by tuple
    seen_edges = set()
    unique_edges: List[Edge] = []
    for e in edges:
        key = (e.source, e.target, e.rel_type, json.dumps(e.properties, sort_keys=True))
        if key not in seen_edges:
            seen_edges.add(key)
            unique_edges.append(e)
    edges = unique_edges

    return nodes, edges, evidence_index


# -----------------------
# CSV ingestion helpers
# -----------------------

def create_nodes_edges_from_kickstarter_csv(csv_path: str | Path) -> Tuple[List[Node], List[Edge], Dict[str, Dict[str, Any]]]:
    """Convert a kickstarter_cleaned.csv into Project + RiskFactor nodes.

    Returns nodes, edges, evidence_index (may be empty)
    """
    csv_path = Path(csv_path)
    nodes: List[Node] = []
    edges: List[Edge] = []
    evidence_index: Dict[str, Dict[str, Any]] = {}

    if not csv_path.exists():
        print(f"[WARNING] kickstarter CSV not found: {csv_path}")
        return nodes, edges, evidence_index

    print(f"[DEBUG] Loading kickstarter CSV from: {csv_path}")
    with csv_path.open('r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        row_count = 0
        edge_count = 0
        risk_factor_count = 0
        first_row = None
        
        for row in reader:
            row_count += 1
            if row_count == 1:
                first_row = row
                print(f"[DEBUG] CSV columns: {list(row.keys())}")
            
            pid = str(row.get('id') or row.get('Project ID') or row.get('project_id') or uuid4().hex[:8])
            
            # 计算风险因素
            try:
                goal = float(row.get('goal') or 0)
                pledged = float(row.get('pledged') or 0)
                goal_ratio = pledged / goal if goal > 0 else 0
            except:
                goal_ratio = 0
            
            try:
                duration = float(row.get('duration_days') or 0)
                time_penalty = 1.0 / (duration + 1) if duration >= 0 else 0
            except:
                time_penalty = 0
            
            # category_risk: 从 category 字段推断（简单估计）
            category_str = str(row.get('category') or '')
            category_risk = 0.5 if len(category_str) > 0 else 0.3
            
            # combined_risk: 综合风险
            try:
                backers = float(row.get('backers_count') or 0)
                combined_risk = (1 - goal_ratio) * 0.4 + time_penalty * 0.3 + category_risk * 0.3
            except:
                combined_risk = 0.5
            
            # country_factor: 从 country 代码推断
            country_code = str(row.get('country') or 'us').lower()
            country_factor = 1.2 if country_code in ['us', 'gb', 'ca'] else 0.8
            
            # urgency_score: 基于 percent_funded
            try:
                percent_funded = float(row.get('percent_funded') or 0)
                urgency_score = min(percent_funded / 100.0, 1.0)
            except:
                urgency_score = 0.5
            
            project_node = Node(id=f"project_{pid}", label="Project", properties={
                "project_id": pid,
                "name": row.get('name') or row.get('Project Name') or '',
                "main_category": row.get('category'),
                "country": row.get('country'),
                "goal_usd": goal
            })
            nodes.append(project_node)

            # 使用计算的风险因素创建边
            risk_factors = {
                'goal_ratio': goal_ratio,
                'time_penalty': time_penalty,
                'category_risk': category_risk,
                'combined_risk': combined_risk,
                'country_factor': country_factor,
                'urgency_score': urgency_score
            }
            
            for k, v in risk_factors.items():
                risk_factor_count += 1
                rf_id = f"risk_{pid}_{k}"
                rf_node = Node(id=rf_id, label="RiskFactor", properties={"feature": k, "value": round(v, 4)})
                nodes.append(rf_node)
                # RiskFactor derived_from Project
                edges.append(Edge(source=rf_id, target=project_node.id, rel_type="derived_from", properties={}))
                edge_count += 1
                # RiskFactor supports Project (risk implications)
                edges.append(Edge(source=rf_id, target=project_node.id, rel_type="supports", properties={"aspect": "risk"}))
                edge_count += 1
        
        print(f"[DEBUG] Processed {row_count} rows from kickstarter CSV")
        print(f"[DEBUG] Generated {risk_factor_count} risk factors → {edge_count} edges before dedup")

    # de-dupe
    uniq = {}
    for n in nodes:
        if n.id not in uniq:
            uniq[n.id] = n
    nodes = list(uniq.values())
    print(f"[DEBUG] After dedup: {len(nodes)} unique nodes")

    # dedupe edges
    seen = set()
    uedges = []
    for e in edges:
        key = (e.source, e.target, e.rel_type, json.dumps(e.properties, sort_keys=True))
        if key not in seen:
            seen.add(key)
            uedges.append(e)
    edges = uedges
    print(f"[DEBUG] After dedup: {len(edges)} unique edges")

    return nodes, edges, evidence_index


def create_nodes_edges_from_full_prediction_csv(csv_path: str | Path) -> Tuple[List[Node], List[Edge], Dict[str, Dict[str, Any]]]:
    """Convert a full_prediction_summary CSV into Project + Metric + RiskFactor nodes."""
    csv_path = Path(csv_path)
    nodes: List[Node] = []
    edges: List[Edge] = []
    evidence_index: Dict[str, Dict[str, Any]] = {}

    if not csv_path.exists():
        return nodes, edges, evidence_index

    with csv_path.open('r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            pid = str(row.get('Project ID') or row.get('Project ID'.lower()) or row.get('id') or uuid4().hex[:8])
            project_node = Node(id=f"project_{pid}", label="Project", properties={
                "project_id": pid,
                "name": row.get('Project Name') or row.get('name') or '',
                "main_category": row.get('Main Category') or row.get('main_category'),
                "country": row.get('Country') or row.get('country'),
                "goal_usd": row.get('Funding Goal (USD)') or row.get('goal_usd')
            })
            nodes.append(project_node)

            # Metric node
            metric_id = f"metric_{pid}"
            metric_props = {
                "predicted_status": row.get('Predicted Status') or row.get('predicted_status'),
                "success_probability": None
            }
            try:
                metric_props['success_probability'] = float(row.get('Success Probability') or row.get('success_probability') or 0)
            except Exception:
                metric_props['success_probability'] = row.get('Success Probability') or row.get('success_probability')

            metric_node = Node(id=metric_id, label='Metric', properties=metric_props)
            nodes.append(metric_node)
            edges.append(Edge(source=metric_id, target=project_node.id, rel_type='supports', properties={}))

            # Risk factors
            for k in ['goal_ratio', 'time_penalty', 'category_risk', 'combined_risk', 'country_factor', 'urgency_score']:
                v = row.get(k) or row.get(k.title())
                if v is None:
                    continue
                try:
                    val = float(v)
                except Exception:
                    val = v
                rf_id = f"risk_{pid}_{k}"
                rf_node = Node(id=rf_id, label="RiskFactor", properties={"feature": k, "value": val})
                nodes.append(rf_node)
                edges.append(Edge(source=rf_id, target=project_node.id, rel_type="derived_from", properties={}))
                edges.append(Edge(source=rf_id, target=metric_id, rel_type="supports", properties={}))

    # dedupe
    unique_nodes: Dict[str, Node] = {}
    for n in nodes:
        if n.id not in unique_nodes:
            unique_nodes[n.id] = n
    nodes = list(unique_nodes.values())

    seen_edges = set()
    unique_edges: List[Edge] = []
    for e in edges:
        key = (e.source, e.target, e.rel_type, json.dumps(e.properties, sort_keys=True))
        if key not in seen_edges:
            seen_edges.add(key)
            unique_edges.append(e)
    edges = unique_edges

    return nodes, edges, evidence_index


def create_rules_from_m8(m8_module_name: str = 'scripts.m8_rule_adapter') -> Tuple[List[Node], List[Edge], Dict[str, Dict[str, Any]]]:
    """Try to import M8 rule adapter and convert rules to Rule nodes."""
    nodes: List[Node] = []
    edges: List[Edge] = []
    evidence_index: Dict[str, Dict[str, Any]] = {}

    try:
        import importlib
        m = importlib.import_module(m8_module_name)
        # expected: module exposes a RULES list or a function list_rules()
        rules = []
        if hasattr(m, 'RULES'):
            rules = getattr(m, 'RULES') or []
        elif hasattr(m, 'list_rules'):
            rules = m.list_rules()
        elif hasattr(m, 'get_rules'):
            rules = m.get_rules()

        for i, r in enumerate(rules):
            rule_id = f"rule_m8_{i}"
            text = r.get('text') if isinstance(r, dict) else str(r)
            rule_node = Node(id=rule_id, label='Rule', properties={'text': text})
            nodes.append(rule_node)
    except Exception:
        # silent fallback if module not available
        pass

    return nodes, edges, evidence_index


__all__ = [
    "Node",
    "Edge",
    "_gen_evidence_id",
    "create_nodes_edges_from_report",
    "create_nodes_edges_from_kickstarter_csv",
    "create_nodes_edges_from_full_prediction_csv",
    "create_rules_from_m8",
]