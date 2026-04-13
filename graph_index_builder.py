from __future__ import annotations

import json
from pathlib import Path
from typing import List, Dict, Any
import csv
from datetime import datetime
import sys

# 支持相对导入和直接脚本运行
try:
    from .graph_schema import (
        create_nodes_edges_from_report,
        create_nodes_edges_from_full_prediction_csv,
        create_nodes_edges_from_kickstarter_csv
    )
except ImportError:
    from graph_schema import (
        create_nodes_edges_from_report,
        create_nodes_edges_from_full_prediction_csv,
        create_nodes_edges_from_kickstarter_csv
    )


def _write_nodes_csv(nodes, out_path: Path):
    fieldnames = ["id", "label", "properties_json"]
    with out_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for n in nodes:
            # Handle both Node objects and dict objects
            if hasattr(n, 'id'):
                node_id = n.id
                node_label = n.label
                node_props = n.properties if isinstance(n.properties, dict) else {}
            else:
                node_id = n.get("id", "")
                node_label = n.get("label", "")
                node_props = n.get("properties_json", {})
                if isinstance(node_props, str):
                    try:
                        node_props = json.loads(node_props)
                    except:
                        node_props = {}
            writer.writerow({"id": node_id, "label": node_label, "properties_json": json.dumps(node_props, ensure_ascii=False)})


def _write_edges_csv(edges, out_path: Path):
    fieldnames = ["source", "target", "type", "properties_json"]
    with out_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for e in edges:
            # Handle both Edge objects and dict objects
            if hasattr(e, 'source'):
                writer.writerow({
                    "source": e.source, 
                    "target": e.target, 
                    "type": e.rel_type, 
                    "properties_json": json.dumps(e.properties, ensure_ascii=False)
                })
            else:
                writer.writerow({
                    "source": e.get("source", ""),
                    "target": e.get("target", ""),
                    "type": e.get("type", ""),
                    "properties_json": json.dumps(e.get("properties", {}), ensure_ascii=False)
                })


class GraphIndexBuilder:
    """Build CSV node/edge exports from M12 reports for Neo4j ingestion."""

    def __init__(self, reports_dir: str, output_dir: str = None):
        self.reports_dir = Path(reports_dir)
        self.output_dir = Path(output_dir) if output_dir else (self.reports_dir / "graph_exports")
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def build_from_report_file(self, report_path: Path) -> Dict:
        with report_path.open("r", encoding="utf-8") as f:
            report = json.load(f)
        nodes, edges, evidence_index = create_nodes_edges_from_report(report)
        
        print(f"[DEBUG] build_from_report_file: {report_path.name}")
        print(f"  Nodes generated: {len(nodes)}")
        print(f"  Edges generated: {len(edges)}")

        base_name = report_path.stem
        nodes_out = self.output_dir / f"{base_name}_nodes.csv"
        edges_out = self.output_dir / f"{base_name}_edges.csv"
        idx_out = self.output_dir / f"{base_name}_evidence_index.json"

        _write_nodes_csv(nodes, nodes_out)
        _write_edges_csv(edges, edges_out)

        with idx_out.open("w", encoding="utf-8") as f:
            json.dump(evidence_index, f, indent=2, ensure_ascii=False)

        print(f"  ✓ Saved to: {nodes_out}, {edges_out}")
        return {"nodes_csv": str(nodes_out), "edges_csv": str(edges_out), "evidence_index": str(idx_out)}

    def build_batch(self, glob_pattern: str = "*.json") -> List[Dict]:
        results = []
        # 支持递归查找并忽略后缀大小写，增强可发现子目录中的报告
        files = []
        if self.reports_dir.exists():
            for p in self.reports_dir.rglob('*'):
                if p.is_file() and p.suffix.lower() == '.json':
                    files.append(p)
        files = sorted(files)

        print(f"[GraphIndexBuilder] scanning {self.reports_dir} found {len(files)} json files (recursive)")

        if not files:
            print(f"[GraphIndexBuilder] no json files found under {self.reports_dir}")
            return results

        for p in files:
            try:
                print(f"[GraphIndexBuilder] processing {p}")
                results.append(self.build_from_report_file(p))
            except Exception as e:
                print(f"Failed to build for {p}: {e}")
        return results


"""
从多源csv构建知识图谱索引，生成节点、关系、evidence_id等，支持后续检索。
"""
import os
import csv
import glob
import json
from collections import defaultdict

try:
    from .graph_schema import NodeType, EdgeType, NODE_SCHEMA, EDGE_SCHEMA
except ImportError:
    from graph_schema import NodeType, EdgeType, NODE_SCHEMA, EDGE_SCHEMA


def load_csv_nodes(file_path, node_type, id_field, extra_fields=None):
    """通用csv节点加载"""
    nodes = []
    with open(file_path, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            node = {'type': node_type, 'id': row[id_field]}
            for k in NODE_SCHEMA[node_type]:
                if k in row:
                    node[k] = row[k]
            if extra_fields:
                for k, v in extra_fields.items():
                    node[k] = v
            nodes.append(node)
    return nodes


def load_kickstarter_nodes(base_dir):
    """加载kickstarter_cleaned和full_prediction_summary_*.csv为Project节点"""
    nodes = []
    for csv_file in glob.glob(os.path.join(base_dir, 'kickstarter_cleaned.csv')):
        nodes += load_csv_nodes(csv_file, 'Project', 'Project ID', {'source_file': 'kickstarter_cleaned.csv'})
    for csv_file in glob.glob(os.path.join(base_dir, 'full_prediction_summary*.csv')):
        nodes += load_csv_nodes(csv_file, 'Project', 'Project ID', {'source_file': os.path.basename(csv_file)})
    return nodes


def load_nodes_from_graph_csv(csv_file):
    """加载标准nodes.csv（如m12_ood_report_..._nodes.csv）"""
    nodes = []
    with open(csv_file, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            props = json.loads(row['properties_json']) if 'properties_json' in row and row['properties_json'] else {}
            node = {'id': row['id'], 'type': row['label']}
            node.update(props)
            nodes.append(node)
    return nodes


def load_edges_from_graph_csv(csv_file):
    """加载标准edges.csv"""
    edges = []
    with open(csv_file, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            props = json.loads(row['properties_json']) if 'properties_json' in row and row['properties_json'] else {}
            edge = {'source': row['source'], 'target': row['target'], 'type': row['type']}
            edge.update(props)
            edges.append(edge)
    return edges


def build_graph_index(data_dir):
    """统一构建知识图谱索引，返回nodes, edges, evidence_id->node映射"""
    nodes = []
    edges = []
    evidence_id_map = {}
    # 1. 加载kickstarter项目节点
    nodes += load_kickstarter_nodes(os.path.join(data_dir, 'Kickstarter_Clean'))
    # 2. 加载m12/m8等导出的nodes/edges
    for csv_file in glob.glob(os.path.join(data_dir, '*_nodes.csv')):
        nodes += load_nodes_from_graph_csv(csv_file)
    for csv_file in glob.glob(os.path.join(data_dir, '*_edges.csv')):
        edges += load_edges_from_graph_csv(csv_file)
    # 3. evidence_id索引
    for node in nodes:
        if node.get('type') == 'Evidence' and 'evidence_id' in node:
            evidence_id_map[node['evidence_id']] = node
    return {'nodes': nodes, 'edges': edges, 'evidence_id_map': evidence_id_map}


def write_simple_nodes(nodes, out_path: Path):
    fieldnames = ["id", "label", "properties_json"]
    with out_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for n in nodes:
            writer.writerow(n)


def _write_edges_for_m8_config(config_nodes: List[Dict], feature_nodes: List[Dict]) -> List[Dict]:
    """
    为 M8 Config 和 Feature 节点生成关系边。
    
    关系类型：
    - Config → FeatureWeight (配置影响特征权重)
    - FeatureWeight → RiskFactor (特征权重影响风险因素)
    
    Returns:
        List of edge dicts with source, target, type, properties_json
    """
    edges = []
    
    # Rule 1: 如果 FeatureWeight 中的特征名包含在 Config 的取值中，则建立关系
    for config in config_nodes:
        config_id = config['id']
        config_props = json.loads(config.get('properties_json', '{}'))
        config_value = str(config_props.get('value', '')).lower()
        
        for feature in feature_nodes:
            feature_id = feature['id']
            feature_props = json.loads(feature.get('properties_json', '{}'))
            feature_name = str(feature_props.get('name', '')).lower()
            
            # 检查配置值是否与特征名相关
            if feature_name in config_value or config_value in feature_name:
                edges.append({
                    "source": config_id,
                    "target": feature_id,
                    "type": "affects",
                    "properties_json": json.dumps({"relation": "config_influences_weight"}, ensure_ascii=False)
                })
    
    return edges


def _write_edges_csv_simple(edges, out_path: Path):
    """简单版本的 edges CSV 写入，用于 m8 配置边"""
    fieldnames = ["source", "target", "type", "properties_json"]
    with out_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for e in edges:
            writer.writerow(e)


def build_evidence_index_from_kickstarter(ks_csv_path: str) -> Dict[str, Any]:
    """从 kickstarter_cleaned.csv 生成 evidence_index"""
    evidence_index = {}
    
    with open(ks_csv_path, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for idx, row in enumerate(reader):
            project_id = row.get('id', f'project_{idx}')
            evidence_id = f"ks_{project_id}"
            
            # 解析category JSON
            category_name = ''
            try:
                if row.get('category'):
                    category_obj = json.loads(row.get('category', '{}'))
                    category_name = category_obj.get('name', '')
            except (json.JSONDecodeError, TypeError):
                pass
            
            # 解析country_displayable_name
            country = row.get('country_displayable_name', row.get('country', ''))
            
            # 获取goal和duration_days
            try:
                funding_goal = float(row.get('goal', 0)) if row.get('goal') else 0
            except (ValueError, TypeError):
                funding_goal = 0
            
            try:
                duration_days = int(row.get('duration_days', 0)) if row.get('duration_days') else 0
            except (ValueError, TypeError):
                duration_days = 0
            
            # 获取状态和概率（如果有）
            state = row.get('state', '')
            success_probability = 1.0 if state == 'successful' else 0.0
            
            evidence_index[evidence_id] = {
                "scenario_id": "kickstarter_dataset",
                "source": "kickstarter",
                "raw": {
                    "project_id": str(project_id),
                    "name": row.get('name', ''),
                    "category": category_name,
                    "country": country,
                    "funding_goal": funding_goal,
                    "duration_days": duration_days,
                    "predicted_status": state,
                    "success_probability": success_probability,
                }
            }
    
    return evidence_index


def build_evidence_index_from_full_prediction(fps_csv_path: str) -> Dict[str, Any]:
    """从 full_prediction_summary.csv 生成 evidence_index"""
    evidence_index = {}
    
    with open(fps_csv_path, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for idx, row in enumerate(reader):
            project_id = row.get('Project ID', f'project_{idx}')
            evidence_id = f"fps_{project_id}"
            
            evidence_index[evidence_id] = {
                "scenario_id": "full_prediction_dataset",
                "source": "full_prediction_summary",
                "raw": {
                    "project_id": project_id,
                    "name": row.get('Project Name', ''),
                    "category": row.get('Main Category', ''),
                    "country": row.get('Country', ''),
                    "goal_ratio": float(row.get('goal_ratio', 0)) if row.get('goal_ratio') else 0,
                    "time_penalty": float(row.get('time_penalty', 0)) if row.get('time_penalty') else 0,
                    "category_risk": float(row.get('category_risk', 0)) if row.get('category_risk') else 0,
                    "combined_risk": float(row.get('combined_risk', 0)) if row.get('combined_risk') else 0,
                    "predicted_status": row.get('Predicted Status', ''),
                    "success_probability": float(row.get('Success Probability', 0)) if row.get('Success Probability') else 0,
                }
            }
    
    return evidence_index


def build_evidence_index_from_m8_config(m8_config_path: str) -> Dict[str, Any]:
    """从 m8_core_config.csv 生成 evidence_index"""
    evidence_index = {}
    
    try:
        import pandas as pd
        df = pd.read_csv(m8_config_path)
        
        for idx, row in df.iterrows():
            category = str(row.get('配置项类别', 'unknown')).strip()
            name = str(row.get('配置项名称', f'config_{idx}')).strip()
            evidence_id = f"m8_config_{category}_{name}".replace(' ', '_').replace('（', '_').replace('）', '')
            
            evidence_index[evidence_id] = {
                "scenario_id": "m8_core_config",
                "source": "m8_core_config",
                "raw": {
                    "category": category,
                    "name": name,
                    "value": str(row.get('取值', '')),
                    "description": str(row.get('说明', '')),
                    "type": "config_item",
                }
            }
    except ImportError:
        print("⚠ pandas 未安装，跳过 m8_core_config.csv 处理")
    
    return evidence_index


def build_evidence_index_from_m8_features(m8_feat_path: str) -> Dict[str, Any]:
    """从 m8_feature_weights.csv 生成 evidence_index"""
    evidence_index = {}
    
    try:
        import pandas as pd
        df = pd.read_csv(m8_feat_path)
        
        for idx, row in df.iterrows():
            feature_name = str(row.get('特征名称', f'feature_{idx}')).strip()
            evidence_id = f"m8_feature_{feature_name}".replace(' ', '_').replace('（', '_').replace('）', '')
            
            evidence_index[evidence_id] = {
                "scenario_id": "m8_feature_weights",
                "source": "m8_feature_weights",
                "raw": {
                    "name": feature_name,
                    "weight": str(row.get('FEATURE_WEIGHTS（权重）', '')),
                    "coefficient": str(row.get('FEATURE_COEFFICIENTS（加权系数）', '')),
                    "threshold": str(row.get('SCENARIO_THRESHOLDS（场景阈值）', '')),
                    "default_value": str(row.get('DEFAULT_VALUES（默认值）', '')),
                    "type": "feature_weight",
                }
            }
    except ImportError:
        print("⚠ pandas 未安装，跳过 m8_feature_weights.csv 处理")
    
    return evidence_index


if __name__ == "__main__":
    # 直接脚本运行时的入口
    import sys
    from pathlib import Path
    
    # 添加当前目录到 path
    current_dir = Path(__file__).parent
    if str(current_dir) not in sys.path:
        sys.path.insert(0, str(current_dir))
    
    reports_dir = current_dir
    output_dir = reports_dir / "graph_exports"
    output_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("🚀 Graph Index Builder 启动")
    print("=" * 60)
    print(f"📂 工作目录: {reports_dir}")
    print(f"📁 输出目录: {output_dir}")
    print()

    # 1. 处理 JSON 报告
    print("📋 [1/3] 处理 JSON 报告文件...")
    builder = GraphIndexBuilder(reports_dir=reports_dir)
    results = builder.build_batch()
    print()

    # 2. 处理 full_prediction_summary.csv
    print("📋 [2/5] 处理 full_prediction_summary.csv...")
    fps_csv = reports_dir / "full_prediction_summary.csv"
    if fps_csv.exists():
        nodes, edges, _ = create_nodes_edges_from_full_prediction_csv(str(fps_csv))
        fps_nodes_out = output_dir / "full_prediction_summary_nodes.csv"
        fps_edges_out = output_dir / "full_prediction_summary_edges.csv"
        fps_idx_out = output_dir / "full_prediction_summary_evidence_index.json"
        _write_nodes_csv(nodes, fps_nodes_out)
        _write_edges_csv(edges, fps_edges_out)
        
        # 生成 evidence_index
        fps_evidence_index = build_evidence_index_from_full_prediction(str(fps_csv))
        with fps_idx_out.open("w", encoding="utf-8") as f:
            json.dump(fps_evidence_index, f, indent=2, ensure_ascii=False)
        
        print(f"✓ 节点: {len(nodes)}, 关系: {len(edges)}, 证据: {len(fps_evidence_index)}")
        print(f"  → {fps_nodes_out.name}")
        print(f"  → {fps_edges_out.name}")
        print(f"  → {fps_idx_out.name}")
    else:
        print(f"⊘ 文件不存在: {fps_csv}")
    print()

    # 3. 处理 kickstarter_cleaned.csv
    print("📋 [3/5] 处理 kickstarter_cleaned.csv...")
    ks_csv = reports_dir / "kickstarter_cleaned.csv"
    if ks_csv.exists():
        try:
            nodes, edges, _ = create_nodes_edges_from_kickstarter_csv(str(ks_csv))
            ks_nodes_out = output_dir / "kickstarter_cleaned_nodes.csv"
            ks_edges_out = output_dir / "kickstarter_cleaned_edges.csv"
            _write_nodes_csv(nodes, ks_nodes_out)
            _write_edges_csv(edges, ks_edges_out)
            print(f"✓ 节点: {len(nodes)}, 关系: {len(edges)}")
            print(f"  → {ks_nodes_out.name}")
            print(f"  → {ks_edges_out.name}")
        except Exception as e:
            print(f"⚠ 处理 graph_schema 出错 (可选): {e}")
        
        # 生成 evidence_index（这是主要的数据）
        ks_evidence_index = build_evidence_index_from_kickstarter(str(ks_csv))
        ks_idx_out = output_dir / "kickstarter_cleaned_evidence_index.json"
        with ks_idx_out.open("w", encoding="utf-8") as f:
            json.dump(ks_evidence_index, f, indent=2, ensure_ascii=False)
        
        print(f"✓ 证据索引: {len(ks_evidence_index)} 条记录")
        print(f"  → {ks_idx_out.name}")
    else:
        print(f"⊘ 文件不存在: {ks_csv}")
    print()

    # 4. 处理可选的 pandas 文件
    try:
        import pandas as pd
        
        # m8_core_config.csv
        m8_config_csv = reports_dir / "m8_core_config.csv"
        if m8_config_csv.exists():
            print("📋 [4/5] 处理 m8_core_config.csv...")
            df = pd.read_csv(m8_config_csv)
            config_nodes = []
            config_edges = []
            config_evidence_index = {}
            
            for idx, row in df.iterrows():
                # 使用更语义化的 ID: config_<类别>_<配置项名称>
                category = str(row.get('配置项类别', 'unknown')).strip()
                name = str(row.get('配置项名称', f'config_{idx}')).strip()
                node_id = f"config_{category}_{name}".replace(' ', '_')
                
                props = {
                    'category': category,
                    'name': name,
                    'value': row.get('取值', ''),
                    'description': row.get('说明', '')
                }
                
                config_nodes.append({
                    "id": node_id,
                    "label": "Config",
                    "properties_json": json.dumps(props, ensure_ascii=False)
                })
                
                # 生成 evidence_index 项
                evidence_id = f"m8_config_{idx}"
                config_evidence_index[evidence_id] = {
                    "scenario_id": "m8_core_config",
                    "source": "m8_core_config",
                    "raw": props
                }
            
            config_nodes_out = output_dir / "m8_core_config_nodes.csv"
            config_idx_out = output_dir / "m8_core_config_evidence_index.json"
            write_simple_nodes(config_nodes, config_nodes_out)
            with config_idx_out.open("w", encoding="utf-8") as f:
                json.dump(config_evidence_index, f, indent=2, ensure_ascii=False)
            
            print(f"✓ 节点: {len(config_nodes)}, 证据: {len(config_evidence_index)}")
            print(f"  → {config_nodes_out.name}")
            print(f"  → {config_idx_out.name}")
            print()

        # m8_feature_weights.csv
        m8_feat_csv = reports_dir / "m8_feature_weights.csv"
        if m8_feat_csv.exists():
            print("📋 [5/5] 处理 m8_feature_weights.csv...")
            df = pd.read_csv(m8_feat_csv)
            feat_nodes = []
            feat_evidence_index = {}
            
            for idx, row in df.iterrows():
                # 使用特征名作为 ID: feature_<特征名>
                feature_name = str(row.get('特征名称', f'feature_{idx}')).strip()
                node_id = f"feature_{feature_name}".replace(' ', '_').replace('（', '_').replace('）', '')
                
                props = {
                    'name': feature_name,
                    'weight': row.get('FEATURE_WEIGHTS（权重）', ''),
                    'coefficient': row.get('FEATURE_COEFFICIENTS（加权系数）', ''),
                    'threshold': row.get('SCENARIO_THRESHOLDS（场景阈值）', ''),
                    'default_value': row.get('DEFAULT_VALUES（默认值）', '')
                }
                
                feat_nodes.append({
                    "id": node_id,
                    "label": "FeatureWeight",
                    "properties_json": json.dumps(props, ensure_ascii=False)
                })
                
                # 生成 evidence_index 项
                evidence_id = f"m8_feature_{idx}"
                feat_evidence_index[evidence_id] = {
                    "scenario_id": "m8_feature_weights",
                    "source": "m8_feature_weights",
                    "raw": props
                }
            
            feat_nodes_out = output_dir / "m8_feature_weights_nodes.csv"
            feat_idx_out = output_dir / "m8_feature_weights_evidence_index.json"
            write_simple_nodes(feat_nodes, feat_nodes_out)
            with feat_idx_out.open("w", encoding="utf-8") as f:
                json.dump(feat_evidence_index, f, indent=2, ensure_ascii=False)
            
            print(f"✓ 节点: {len(feat_nodes)}, 证据: {len(feat_evidence_index)}")
            print(f"  → {feat_nodes_out.name}")
            print(f"  → {feat_idx_out.name}")
            print()

            # 生成 Config 和 FeatureWeight 之间的关系边
            if 'config_nodes' in locals() and config_nodes:
                config_feature_edges = _write_edges_for_m8_config(config_nodes, feat_nodes)
                if config_feature_edges:
                    config_feat_edges_out = output_dir / "m8_config_feature_edges.csv"
                    _write_edges_csv_simple(config_feature_edges, config_feat_edges_out)
                    print(f"✓ 关系: {len(config_feature_edges)} (Config ↔ FeatureWeight)")
                    print(f"  → {config_feat_edges_out.name}")
                    print()
    except ImportError:
        print("⚠ pandas 未安装，跳过 m8_core_config.csv 和 m8_feature_weights.csv 处理")
        print()

    # 完成报告
    print("=" * 60)
    print("✅ 构建完成！")
    print("=" * 60)
    
    # 列出所有生成的文件
    output_files = sorted(output_dir.glob("*"))
    if output_files:
        print(f"\n📊 生成的文件 ({len(output_files)} 个):")
        for f in output_files:
            size = f.stat().st_size
            if size > 1024*1024:
                size_str = f"{size / (1024*1024):.2f} MB"
            elif size > 1024:
                size_str = f"{size / 1024:.2f} KB"
            else:
                size_str = f"{size} B"
            print(f"  ✓ {f.name:<50} {size_str:>10}")
    else:
        print("\n⚠ 未生成任何文件")
    
    print(f"\n📁 输出目录: {output_dir}")
    print()