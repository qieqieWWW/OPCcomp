#!/usr/bin/env python
# coding: utf-8

"""
准确性评测与防幻觉闸门
======================

目标：把"胡编"在发布前拦住

核心功能：
1. 构建评测脚本：检查输出是否有证据ID、证据是否可回查
2. 建立冲突检测：内部证据 vs 外部证据冲突时强制降置信度
3. 建立幻觉拦截：
   - 无证据结论 -> 拒答/降级
   - 证据过期 -> 提示需要刷新
4. 复用 M5_AutoTest_Suite.py 与 M12环境增强与OOD测试.py 做回归集

架构设计：
- Evidence Tracker: 证据追踪和验证
- Conflict Detector: 冲突检测和置信度调整
- Hallucination Guard: 幻觉拦截和降级处理
- Accuracy Evaluator: 准确性评估和报告生成
"""

import os
import sys
import json
import time
import re
from pathlib import Path
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional, Tuple, Set
from dataclasses import dataclass, asdict, field
from enum import Enum
import logging
import hashlib
from collections import defaultdict

# 导入项目模块
script_dir = Path(__file__).parent.parent.parent
oioioi_scripts_dir = script_dir / "oioioi" / "scripts"
sys.path.insert(0, str(oioioi_scripts_dir))

# 安全导入M5模块
M5_AVAILABLE = False
M5_CLASSES = {}

try:
    # 先尝试不导入pandas等依赖
    import importlib.util
    import sys
    
    # 临时禁用可能缺失的依赖
    original_import = __builtins__.__import__
    
    def safe_import(name, *args, **kwargs):
        if name in ['pandas', 'numpy']:
            # 返回一个模拟模块
            class MockModule:
                def __getattr__(self, name):
                    return None
                def __call__(self, *args, **kwargs):
                    return None
            return MockModule()
        return original_import(name, *args, **kwargs)
    
    __builtins__.__import__ = safe_import
    
    try:
        # 尝试导入M5核心类
        spec = importlib.util.spec_from_file_location(
            "M5_AutoTest_Suite", 
            str(oioioi_scripts_dir / "M5_AutoTest_Suite.py")
        )
        m5_module = importlib.util.module_from_spec(spec)
        
        # 执行模块，但捕获导入错误
        try:
            spec.loader.exec_module(m5_module)
            
            # 提取需要的类
            M5_CLASSES = {
                "TestCase": getattr(m5_module, "TestCase", None),
                "TestResult": getattr(m5_module, "TestResult", None),
                "TestReport": getattr(m5_module, "TestReport", None),
                "TestStatus": getattr(m5_module, "TestStatus", None),
            }
            
            if all(M5_CLASSES.values()):
                M5_AVAILABLE = True
                print("✓ M5模块可用（部分功能）")
            else:
                print("⚠️ M5模块部分类缺失")
                
        except Exception as e:
            print(f"⚠️ M5模块加载异常: {e}")
            
    except Exception as e:
        print(f"⚠️ M5模块不可用: {e}")
    
    # 恢复原始import
    __builtins__.__import__ = original_import
    
except Exception as e:
    print(f"⚠️ M5模块导入失败: {e}")

# 安全导入M12模块
M12_AVAILABLE = False
M12_CLASSES = {}

try:
    # 检查M12文件是否存在
    m12_file = oioioi_scripts_dir / "M12环境增强与OOD测试.py"
    if m12_file.exists():
        try:
            # 尝试导入M12
            spec = importlib.util.spec_from_file_location(
                "M12环境增强与OOD测试", 
                str(m12_file)
            )
            m12_module = importlib.util.module_from_spec(spec)
            
            # 执行模块
            try:
                spec.loader.exec_module(m12_module)
                
                # 提取需要的类
                M12_CLASSES = {
                    "OODConfig": getattr(m12_module, "OODConfig", None),
                    "OODTestGenerator": getattr(m12_module, "OODTestGenerator", None),
                }
                
                if any(M12_CLASSES.values()):
                    M12_AVAILABLE = True
                    print("✓ M12模块可用（部分功能）")
                else:
                    print("⚠️ M12模块类缺失")
                    
            except Exception as e:
                print(f"⚠️ M12模块加载异常: {e}")
                
        except Exception as e:
            print(f"⚠️ M12模块导入失败: {e}")
    else:
        print("⚠️ M12模块文件不存在")
        
except Exception as e:
    print(f"⚠️ M12模块检查失败: {e}")

# 如果没有成功导入，创建基本实现
if not M5_AVAILABLE:
    print("📝 创建M5基本实现")
    
    # 创建基本枚举
    class TestStatus(str, Enum):
        PENDING, RUNNING, PASSED, FAILED, ERROR, SKIPPED = "pending", "running", "passed", "failed", "error", "skipped"
    
    M5_CLASSES = {
        "TestCase": None,
        "TestResult": None,
        "TestReport": None,
        "TestStatus": TestStatus,
    }

if not M12_AVAILABLE:
    print("📝 创建M12基本实现")
    
    class OODConfig:
        def __init__(self):
            self.output_dir = "ood_tests"
            self.max_ood_steps = 24
            self.resilience_threshold = 0.6
    
    class OODTestGenerator:
        def __init__(self, config):
            self.config = config
        
        def generate_tests(self, count=5):
            return []
    
    M12_CLASSES = {
        "OODConfig": OODConfig,
        "OODTestGenerator": OODTestGenerator,
    }

# ============ 枚举定义 ============

class EvidenceStatus(str, Enum):
    """证据状态枚举"""
    VERIFIED = "verified"          # 已验证
    PENDING_VERIFICATION = "pending"  # 待验证
    EXPIRED = "expired"           # 过期
    UNVERIFIABLE = "unverifiable"  # 不可验证
    CONFLICTING = "conflicting"    # 冲突
    HALLUCINATED = "hallucinated"  # 幻觉

class ConfidenceLevel(str, Enum):
    """置信度等级"""
    HIGH = "high"      # 高置信度（多源交叉验证）
    MEDIUM = "medium"  # 中置信度（单源可信）
    LOW = "low"        # 低置信度（需要验证）
    VERY_LOW = "very_low"  # 极低置信度（冲突或过期）
    REJECTED = "rejected"  # 拒绝（幻觉或无证据）

class GateDecision(str, Enum):
    """闸门决策"""
    PASS = "pass"              # 通过
    PASS_WITH_WARNING = "pass_with_warning"  # 警告通过
    REJECT = "reject"          # 拒绝
    REQUIRES_REVISION = "requires_revision"  # 需要修改
    NEEDS_REFRESH = "needs_refresh"  # 需要刷新证据

# ============ 数据类定义 ============

@dataclass
class Evidence:
    """证据记录"""
    evidence_id: str
    content: str
    source_type: str  # "internal", "external", "assumption"
    source_name: str
    source_url: Optional[str] = None
    evidence_type: str = "fact"  # "fact", "data", "case_study", "expert_opinion"
    timestamp: float = field(default_factory=time.time)
    expiration_days: int = 30  # 默认30天过期
    confidence: ConfidenceLevel = ConfidenceLevel.MEDIUM
    verification_method: str = "manual"  # "manual", "automated", "cross_reference"
    verification_timestamp: Optional[float] = None
    status: EvidenceStatus = EvidenceStatus.PENDING_VERIFICATION
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    @property
    def is_expired(self) -> bool:
        """检查证据是否过期"""
        if not self.verification_timestamp:
            return False
        expiration_date = datetime.fromtimestamp(self.verification_timestamp) + timedelta(days=self.expiration_days)
        return datetime.now() > expiration_date
    
    @property
    def age_days(self) -> float:
        """证据年龄（天）"""
        if not self.verification_timestamp:
            return 0
        return (time.time() - self.verification_timestamp) / (24 * 3600)
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

@dataclass
class EvidenceReference:
    """证据引用"""
    evidence_id: str
    claim: str
    relevance_score: float  # 0-1，相关度评分
    usage_context: str  # "support", "contradict", "reference"
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

@dataclass
class OutputStatement:
    """输出声明"""
    statement_id: str
    content: str
    statement_type: str  # "fact", "conclusion", "recommendation", "prediction"
    evidence_references: List[EvidenceReference] = field(default_factory=list)
    confidence: ConfidenceLevel = ConfidenceLevel.MEDIUM
    is_verifiable: bool = True
    verification_required: bool = False
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    @property
    def has_evidence(self) -> bool:
        """是否有证据支持"""
        return len(self.evidence_references) > 0
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "statement_id": self.statement_id,
            "content": self.content,
            "statement_type": self.statement_type,
            "evidence_count": len(self.evidence_references),
            "confidence": self.confidence.value,
            "is_verifiable": self.is_verifiable,
            "verification_required": self.verification_required,
            "evidence_references": [er.to_dict() for er in self.evidence_references]
        }

@dataclass
class AccuracyEvaluation:
    """准确性评估结果"""
    evaluation_id: str
    output_id: str
    timestamp: float = field(default_factory=time.time)
    
    # 统计信息
    total_statements: int = 0
    verified_statements: int = 0
    unverified_statements: int = 0
    conflicting_statements: int = 0
    hallucinated_statements: int = 0
    expired_evidence_statements: int = 0
    
    # 质量指标
    evidence_coverage: float = 0.0  # 证据覆盖率
    confidence_score: float = 0.0   # 置信度评分
    hallucination_score: float = 0.0  # 幻觉评分（越低越好）
    conflict_score: float = 0.0     # 冲突评分
    
    # 决策结果
    gate_decision: GateDecision = GateDecision.PASS
    decision_reason: str = ""
    warnings: List[str] = field(default_factory=list)
    required_actions: List[str] = field(default_factory=list)
    
    # 详细分析
    statement_analysis: List[Dict[str, Any]] = field(default_factory=list)
    evidence_analysis: List[Dict[str, Any]] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

# ============ 证据追踪器 ============

class EvidenceTracker:
    """证据追踪器"""
    
    def __init__(self, evidence_db_path: Optional[str] = None):
        self.evidence_db: Dict[str, Evidence] = {}
        self.evidence_by_source: Dict[str, List[str]] = defaultdict(list)
        self.evidence_by_type: Dict[str, List[str]] = defaultdict(list)
        
        if evidence_db_path and Path(evidence_db_path).exists():
            self.load_evidence_db(evidence_db_path)
    
    def add_evidence(self, evidence: Evidence) -> str:
        """添加证据"""
        self.evidence_db[evidence.evidence_id] = evidence
        self.evidence_by_source[evidence.source_type].append(evidence.evidence_id)
        self.evidence_by_type[evidence.evidence_type].append(evidence.evidence_id)
        return evidence.evidence_id
    
    def get_evidence(self, evidence_id: str) -> Optional[Evidence]:
        """获取证据"""
        return self.evidence_db.get(evidence_id)
    
    def verify_evidence(self, evidence_id: str, method: str = "manual") -> bool:
        """验证证据"""
        evidence = self.get_evidence(evidence_id)
        if not evidence:
            return False
        
        evidence.verification_method = method
        evidence.verification_timestamp = time.time()
        evidence.status = EvidenceStatus.VERIFIED
        evidence.confidence = ConfidenceLevel.HIGH
        
        return True
    
    def check_evidence_validity(self, evidence_id: str) -> Tuple[bool, str]:
        """检查证据有效性"""
        evidence = self.get_evidence(evidence_id)
        if not evidence:
            return False, "证据不存在"
        
        if evidence.status == EvidenceStatus.HALLUCINATED:
            return False, "证据被标记为幻觉"
        
        if evidence.status == EvidenceStatus.CONFLICTING:
            return False, "证据存在冲突"
        
        if evidence.is_expired:
            evidence.status = EvidenceStatus.EXPIRED
            return False, "证据已过期"
        
        if evidence.status == EvidenceStatus.PENDING_VERIFICATION:
            return False, "证据待验证"
        
        return True, "有效"
    
    def search_evidence(self, query: str, max_results: int = 10) -> List[Evidence]:
        """搜索证据"""
        results = []
        query_lower = query.lower()
        
        for evidence in self.evidence_db.values():
            # 简单关键词匹配
            if query_lower in evidence.content.lower():
                results.append(evidence)
            elif query_lower in evidence.source_name.lower():
                results.append(evidence)
            
            if len(results) >= max_results:
                break
        
        return results
    
    def load_evidence_db(self, filepath: str):
        """加载证据数据库"""
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
                
            for ev_data in data.get("evidence", []):
                evidence = Evidence(**ev_data)
                self.evidence_db[evidence.evidence_id] = evidence
                self.evidence_by_source[evidence.source_type].append(evidence.evidence_id)
                self.evidence_by_type[evidence.evidence_type].append(evidence.evidence_id)
                
            print(f"✓ 加载证据数据库: {len(self.evidence_db)} 条证据")
            
        except Exception as e:
            print(f"✗ 加载证据数据库失败: {e}")
    
    def save_evidence_db(self, filepath: str):
        """保存证据数据库"""
        try:
            data = {
                "evidence": [ev.to_dict() for ev in self.evidence_db.values()],
                "timestamp": time.time(),
                "total_count": len(self.evidence_db)
            }
            
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                
            print(f"✓ 保存证据数据库: {filepath}")
            
        except Exception as e:
            print(f"✗ 保存证据数据库失败: {e}")

# ============ 冲突检测器 ============

class ConflictDetector:
    """冲突检测器"""
    
    def __init__(self, evidence_tracker: EvidenceTracker):
        self.evidence_tracker = evidence_tracker
        self.conflict_patterns = [
            (r"(\d+)\s*%", "percentage_conflict"),  # 百分比冲突
            (r"\$\s*(\d+[\d,]*)", "currency_conflict"),  # 货币冲突
            (r"\b(\d{4})\b", "year_conflict"),  # 年份冲突
            (r"(\d+)\s*(?:million|billion|trillion)", "scale_conflict"),  # 规模冲突
        ]
    
    def detect_conflicts(self, output_statements: List[OutputStatement]) -> List[Dict[str, Any]]:
        """检测冲突"""
        conflicts = []
        
        # 1. 证据内部冲突
        for i, stmt1 in enumerate(output_statements):
            for j, stmt2 in enumerate(output_statements[i+1:], i+1):
                conflict = self._check_statement_conflict(stmt1, stmt2)
                if conflict:
                    conflicts.append(conflict)
        
        # 2. 证据与外部知识冲突
        for statement in output_statements:
            for evidence_ref in statement.evidence_references:
                evidence = self.evidence_tracker.get_evidence(evidence_ref.evidence_id)
                if evidence and evidence.status == EvidenceStatus.CONFLICTING:
                    conflicts.append({
                        "type": "external_conflict",
                        "statement_id": statement.statement_id,
                        "evidence_id": evidence_ref.evidence_id,
                        "description": f"证据与外部知识冲突: {evidence.content[:100]}...",
                        "severity": "high"
                    })
        
        return conflicts
    
    def _check_statement_conflict(self, stmt1: OutputStatement, stmt2: OutputStatement) -> Optional[Dict[str, Any]]:
        """检查两个声明之间的冲突"""
        # 检查是否有相同主题但矛盾的内容
        content1 = stmt1.content.lower()
        content2 = stmt2.content.lower()
        
        # 简单关键词冲突检测
        conflict_keywords = ["increase", "decrease", "high", "low", "success", "failure", "profitable", "unprofitable"]
        
        for keyword in conflict_keywords:
            if keyword in content1 and self._get_opposite(keyword) in content2:
                # 检查是否是同一主题
                if self._similar_topic(content1, content2):
                    return {
                        "type": "direct_contradiction",
                        "statement_ids": [stmt1.statement_id, stmt2.statement_id],
                        "keywords": [keyword, self._get_opposite(keyword)],
                        "description": f"声明直接矛盾: '{keyword}' vs '{self._get_opposite(keyword)}'",
                        "severity": "high"
                    }
        
        # 数值冲突检测
        numeric_conflict = self._check_numeric_conflict(stmt1.content, stmt2.content)
        if numeric_conflict:
            return {
                "type": "numeric_conflict",
                "statement_ids": [stmt1.statement_id, stmt2.statement_id],
                "description": f"数值冲突: {numeric_conflict}",
                "severity": "medium"
            }
        
        return None
    
    def _get_opposite(self, keyword: str) -> str:
        """获取反义词"""
        opposites = {
            "increase": "decrease", "decrease": "increase",
            "high": "low", "low": "high",
            "success": "failure", "failure": "success",
            "profitable": "unprofitable", "unprofitable": "profitable",
            "positive": "negative", "negative": "positive"
        }
        return opposites.get(keyword, "")
    
    def _similar_topic(self, content1: str, content2: str) -> bool:
        """检查是否同一主题"""
        # 简单实现：检查是否有相同的关键名词
        nouns1 = set(re.findall(r'\b([A-Z][a-z]+)\b', content1))
        nouns2 = set(re.findall(r'\b([A-Z][a-z]+)\b', content2))
        
        common_nouns = nouns1.intersection(nouns2)
        return len(common_nouns) >= 2
    
    def _check_numeric_conflict(self, text1: str, text2: str) -> Optional[str]:
        """检查数值冲突"""
        # 提取数值和单位
        numbers1 = re.findall(r'(\d+(?:\.\d+)?)\s*%?', text1)
        numbers2 = re.findall(r'(\d+(?:\.\d+)?)\s*%?', text2)
        
        if numbers1 and numbers2:
            # 简单检查：如果数值差异超过50%，可能冲突
            try:
                num1 = float(numbers1[0])
                num2 = float(numbers2[0])
                
                if abs(num1 - num2) / max(num1, num2) > 0.5:
                    return f"{num1} vs {num2}"
            except:
                pass
        
        return None

# ============ 幻觉拦截器 ============

class HallucinationGuard:
    """幻觉拦截器"""
    
    def __init__(self, evidence_tracker: EvidenceTracker):
        self.evidence_tracker = evidence_tracker
        self.hallucination_patterns = [
            (r"\b(?:definitely|certainly|absolutely)\b.*\b(?:but|however|although)\b", "certainty_contradiction"),
            (r"\b(?:every|all|none|never|always)\b", "absolute_statement"),
            (r"\b(?:proven|demonstrated|established)\b.*\b(?:without evidence|no data)\b", "unsubstantiated_claim"),
            (r"\b(?:according to|based on)\b.*\b(?:unknown|unspecified)\b", "vague_source"),
        ]
    
    def detect_hallucinations(self, output_statements: List[OutputStatement]) -> List[Dict[str, Any]]:
        """检测幻觉"""
        hallucinations = []
        
        for statement in output_statements:
            # 1. 检查是否有证据支持
            if not statement.has_evidence and statement.is_verifiable:
                hallucinations.append({
                    "type": "no_evidence",
                    "statement_id": statement.statement_id,
                    "content": statement.content[:100],
                    "description": "可验证声明但无证据支持",
                    "severity": "high"
                })
            
            # 2. 检查证据有效性
            for evidence_ref in statement.evidence_references:
                evidence = self.evidence_tracker.get_evidence(evidence_ref.evidence_id)
                if evidence:
                    valid, reason = self.evidence_tracker.check_evidence_validity(evidence_ref.evidence_id)
                    if not valid:
                        hallucinations.append({
                            "type": "invalid_evidence",
                            "statement_id": statement.statement_id,
                            "evidence_id": evidence_ref.evidence_id,
                            "description": f"无效证据: {reason}",
                            "severity": "medium" if "过期" in reason else "high"
                        })
            
            # 3. 检查模式匹配幻觉
            pattern_hallucinations = self._check_pattern_hallucinations(statement.content)
            for pattern in pattern_hallucinations:
                hallucinations.append({
                    "type": "pattern_match",
                    "statement_id": statement.statement_id,
                    "pattern": pattern[0],
                    "description": pattern[1],
                    "severity": "low"
                })
            
            # 4. 检查过于确定的声明
            if self._is_overly_confident(statement.content):
                hallucinations.append({
                    "type": "overconfidence",
                    "statement_id": statement.statement_id,
                    "content": statement.content[:100],
                    "description": "声明过于确定，缺乏限定条件",
                    "severity": "low"
                })
        
        return hallucinations
    
    def _check_pattern_hallucinations(self, text: str) -> List[Tuple[str, str]]:
        """检查模式匹配幻觉"""
        matches = []
        for pattern, pattern_name in self.hallucination_patterns:
            if re.search(pattern, text, re.IGNORECASE):
                matches.append((pattern_name, f"匹配到{pattern_name}模式"))
        
        return matches
    
    def _is_overly_confident(self, text: str) -> bool:
        """检查是否过于确定"""
        overconfidence_keywords = ["definitely", "certainly", "absolutely", "without a doubt", "guaranteed"]
        
        for keyword in overconfidence_keywords:
            if keyword in text.lower():
                # 检查是否有限定条件
                if not self._has_qualifiers(text):
                    return True
        
        return False
    
    def _has_qualifiers(self, text: str) -> bool:
        """检查是否有限定条件"""
        qualifiers = ["likely", "probably", "possibly", "may", "might", "could", "often", "sometimes", "generally"]
        
        for qualifier in qualifiers:
            if qualifier in text.lower():
                return True
        
        return False

# ============ 准确性评估器 ============

class AccuracyEvaluator:
    """准确性评估器"""
    
    def __init__(self, evidence_tracker: EvidenceTracker):
        self.evidence_tracker = evidence_tracker
        self.conflict_detector = ConflictDetector(evidence_tracker)
        self.hallucination_guard = HallucinationGuard(evidence_tracker)
    
    def evaluate_output(self, output_text: str, output_id: str, 
                       extract_statements: bool = True) -> AccuracyEvaluation:
        """评估输出准确性"""
        print(f"🔍 评估输出: {output_id}")
        
        # 1. 提取声明
        if extract_statements:
            statements = self._extract_statements(output_text, output_id)
        else:
            # 假设已经提供结构化声明
            statements = []
        
        # 2. 检测冲突
        conflicts = self.conflict_detector.detect_conflicts(statements)
        
        # 3. 检测幻觉
        hallucinations = self.hallucination_guard.detect_hallucinations(statements)
        
        # 4. 计算指标
        metrics = self._calculate_metrics(statements, conflicts, hallucinations)
        
        # 5. 做出决策
        decision, reason = self._make_decision(metrics, statements, conflicts, hallucinations)
        
        # 6. 生成评估报告
        evaluation = AccuracyEvaluation(
            evaluation_id=f"eval_{int(time.time())}_{hashlib.md5(output_id.encode()).hexdigest()[:8]}",
            output_id=output_id,
            total_statements=len(statements),
            verified_statements=metrics["verified_statements"],
            unverified_statements=metrics["unverified_statements"],
            conflicting_statements=metrics["conflicting_statements"],
            hallucinated_statements=metrics["hallucinated_statements"],
            expired_evidence_statements=metrics["expired_evidence"],
            evidence_coverage=metrics["evidence_coverage"],
            confidence_score=metrics["confidence_score"],
            hallucination_score=metrics["hallucination_score"],
            conflict_score=metrics["conflict_score"],
            gate_decision=decision,
            decision_reason=reason,
            warnings=self._generate_warnings(conflicts, hallucinations, metrics),
            required_actions=self._generate_required_actions(conflicts, hallucinations, metrics)
        )
        
        # 7. 添加详细分析
        evaluation.statement_analysis = [stmt.to_dict() for stmt in statements]
        
        print(f"✓ 评估完成: {decision.value}")
        
        return evaluation
    
    def _extract_statements(self, text: str, output_id: str) -> List[OutputStatement]:
        """从文本中提取声明"""
        statements = []
        
        # 简单实现：按句子分割
        sentences = re.split(r'[.!?]+', text)
        
        for i, sentence in enumerate(sentences):
            sentence = sentence.strip()
            if not sentence or len(sentence) < 10:
                continue
            
            # 检查是否是声明性语句（而非问题或命令）
            if self._is_declarative(sentence):
                statement = OutputStatement(
                    statement_id=f"{output_id}_stmt_{i}",
                    content=sentence,
                    statement_type=self._classify_statement_type(sentence),
                    confidence=ConfidenceLevel.MEDIUM,
                    is_verifiable=self._is_verifiable(sentence)
                )
                
                # 尝试查找相关证据
                self._attach_evidence(statement)
                
                statements.append(statement)
        
        return statements
    
    def _is_declarative(self, sentence: str) -> bool:
        """检查是否是声明性语句"""
        # 排除疑问句
        if sentence.strip().endswith('?'):
            return False
        
        # 排除祈使句
        imperative_keywords = ["please", "should", "must", "need to", "let's"]
        if any(keyword in sentence.lower() for keyword in imperative_keywords):
            return False
        
        return True
    
    def _classify_statement_type(self, sentence: str) -> str:
        """分类声明类型"""
        sentence_lower = sentence.lower()
        
        if any(word in sentence_lower for word in ["recommend", "suggest", "advise"]):
            return "recommendation"
        elif any(word in sentence_lower for word in ["will", "going to", "predict", "forecast"]):
            return "prediction"
        elif any(word in sentence_lower for word in ["because", "therefore", "thus", "so"]):
            return "conclusion"
        else:
            return "fact"
    
    def _is_verifiable(self, sentence: str) -> bool:
        """检查是否可验证"""
        # 可验证的声明通常包含具体信息
        unverifiable_patterns = [
            r"\b(?:opinion|feel|think|believe)\b",
            r"\b(?:beautiful|ugly|good|bad)\b",  # 主观评价
            r"\b(?:maybe|perhaps|possibly)\b.*\b(?:could|might)\b",
        ]
        
        for pattern in unverifiable_patterns:
            if re.search(pattern, sentence, re.IGNORECASE):
                return False
        
        return True
    
    def _attach_evidence(self, statement: OutputStatement):
        """为声明附加证据"""
        # 搜索相关证据
        relevant_evidence = self.evidence_tracker.search_evidence(statement.content, max_results=3)
        
        for evidence in relevant_evidence:
            relevance = self._calculate_relevance(statement.content, evidence.content)
            if relevance > 0.3:  # 相关度阈值
                statement.evidence_references.append(
                    EvidenceReference(
                        evidence_id=evidence.evidence_id,
                        claim=statement.content,
                        relevance_score=relevance,
                        usage_context="support"
                    )
                )
    
    def _calculate_relevance(self, statement: str, evidence: str) -> float:
        """计算相关度"""
        # 简单实现：关键词重叠
        statement_words = set(statement.lower().split())
        evidence_words = set(evidence.lower().split())
        
        if not statement_words or not evidence_words:
            return 0.0
        
        overlap = len(statement_words.intersection(evidence_words))
        return overlap / len(statement_words)
    
    def _calculate_metrics(self, statements: List[OutputStatement], 
                          conflicts: List[Dict], 
                          hallucinations: List[Dict]) -> Dict[str, Any]:
        """计算评估指标"""
        total_statements = len(statements)
        if total_statements == 0:
            return {
                "verified_statements": 0,
                "unverified_statements": 0,
                "conflicting_statements": 0,
                "hallucinated_statements": 0,
                "expired_evidence": 0,
                "evidence_coverage": 0.0,
                "confidence_score": 0.0,
                "hallucination_score": 1.0,
                "conflict_score": 1.0
            }
        
        # 基本统计
        verified_statements = sum(1 for stmt in statements if stmt.has_evidence)
        unverified_statements = total_statements - verified_statements
        
        # 冲突统计
        conflicting_statements = len(set(c.get("statement_ids", []) for c in conflicts))
        
        # 幻觉统计
        hallucinated_statements = len(set(h.get("statement_id") for h in hallucinations))
        
        # 过期证据统计
        expired_evidence = 0
        for statement in statements:
            for evidence_ref in statement.evidence_references:
                evidence = self.evidence_tracker.get_evidence(evidence_ref.evidence_id)
                if evidence and evidence.is_expired:
                    expired_evidence += 1
                    break
        
        # 计算指标
        evidence_coverage = verified_statements / total_statements if total_statements > 0 else 0.0
        
        # 置信度评分（基于证据覆盖率和证据质量）
        confidence_score = evidence_coverage * 0.7
        
        # 幻觉评分（越低越好）
        hallucination_score = hallucinated_statements / total_statements if total_statements > 0 else 1.0
        
        # 冲突评分（越低越好）
        conflict_score = conflicting_statements / total_statements if total_statements > 0 else 1.0
        
        return {
            "verified_statements": verified_statements,
            "unverified_statements": unverified_statements,
            "conflicting_statements": conflicting_statements,
            "hallucinated_statements": hallucinated_statements,
            "expired_evidence": expired_evidence,
            "evidence_coverage": evidence_coverage,
            "confidence_score": confidence_score,
            "hallucination_score": hallucination_score,
            "conflict_score": conflict_score
        }
    
    def _make_decision(self, metrics: Dict[str, Any], 
                      statements: List[OutputStatement],
                      conflicts: List[Dict],
                      hallucinations: List[Dict]) -> Tuple[GateDecision, str]:
        """做出闸门决策"""
        
        # 高严重性幻觉 => 拒绝
        high_severity_hallucinations = [h for h in hallucinations if h.get("severity") == "high"]
        if high_severity_hallucinations:
            return GateDecision.REJECT, f"检测到{len(high_severity_hallucinations)}个高严重性幻觉"
        
        # 高严重性冲突 => 需要修改
        high_severity_conflicts = [c for c in conflicts if c.get("severity") == "high"]
        if high_severity_conflicts:
            return GateDecision.REQUIRES_REVISION, f"检测到{len(high_severity_conflicts)}个高严重性冲突"
        
        # 证据覆盖率低 => 警告通过
        if metrics["evidence_coverage"] < 0.5:
            return GateDecision.PASS_WITH_WARNING, f"证据覆盖率较低: {metrics['evidence_coverage']:.1%}"
        
        # 过期证据 => 需要刷新
        if metrics["expired_evidence"] > 0:
            return GateDecision.NEEDS_REFRESH, f"检测到{metrics['expired_evidence']}个过期证据"
        
        # 幻觉评分高 => 警告通过
        if metrics["hallucination_score"] > 0.3:
            return GateDecision.PASS_WITH_WARNING, f"幻觉评分较高: {metrics['hallucination_score']:.1%}"
        
        # 冲突评分高 => 警告通过
        if metrics["conflict_score"] > 0.3:
            return GateDecision.PASS_WITH_WARNING, f"冲突评分较高: {metrics['conflict_score']:.1%}"
        
        # 一切正常 => 通过
        return GateDecision.PASS, "所有检查通过"
    
    def _generate_warnings(self, conflicts: List[Dict], 
                          hallucinations: List[Dict], 
                          metrics: Dict[str, Any]) -> List[str]:
        """生成警告"""
        warnings = []
        
        if metrics["evidence_coverage"] < 0.7:
            warnings.append(f"证据覆盖率较低: {metrics['evidence_coverage']:.1%}")
        
        if metrics["hallucination_score"] > 0.1:
            warnings.append(f"检测到可能的幻觉: {metrics['hallucination_score']:.1%}")
        
        if metrics["conflict_score"] > 0.1:
            warnings.append(f"检测到内部冲突: {metrics['conflict_score']:.1%}")
        
        for conflict in conflicts:
            if conflict.get("severity") in ["medium", "low"]:
                warnings.append(f"潜在冲突: {conflict.get('description', '未知')}")
        
        for hallucination in hallucinations:
            if hallucination.get("severity") in ["medium", "low"]:
                warnings.append(f"潜在幻觉: {hallucination.get('description', '未知')}")
        
        return warnings
    
    def _generate_required_actions(self, conflicts: List[Dict],
                                 hallucinations: List[Dict],
                                 metrics: Dict[str, Any]) -> List[str]:
        """生成必要行动"""
        actions = []
        
        if metrics["evidence_coverage"] < 0.5:
            actions.append("增加证据支持，特别是对于关键声明")
        
        if metrics["expired_evidence"] > 0:
            actions.append("更新过期证据")
        
        for conflict in conflicts:
            if conflict.get("severity") == "medium":
                actions.append(f"澄清冲突: {conflict.get('description', '')}")
        
        for hallucination in hallucinations:
            if hallucination.get("type") == "no_evidence":
                actions.append(f"为声明'{hallucination.get('content', '')}'添加证据支持")
        
        return actions

# ============ 回归测试集成 ============

class AccuracyRegressionTest:
    """准确性回归测试"""
    
    def __init__(self, accuracy_evaluator: AccuracyEvaluator):
        self.accuracy_evaluator = accuracy_evaluator
        
        # 基本测试用例
        self.test_cases = [
            {
                "id": "test_high_accuracy",
                "description": "高准确性输出测试",
                "output": "根据2024年Gartner报告，AI市场预计到2027年将达到5000亿美元，年复合增长率为25%。",
                "expected_decision": GateDecision.PASS
            },
            {
                "id": "test_no_evidence",
                "description": "无证据输出测试",
                "output": "这个项目肯定会成功，不需要任何验证。",
                "expected_decision": GateDecision.REJECT
            },
            {
                "id": "test_conflicting",
                "description": "冲突输出测试",
                "output": "市场增长率为10%。市场增长率为50%。",
                "expected_decision": GateDecision.REQUIRES_REVISION
            },
            {
                "id": "test_expired_evidence",
                "description": "过期证据测试",
                "output": "根据2010年数据，智能手机普及率为30%。",
                "expected_decision": GateDecision.NEEDS_REFRESH
            }
        ]
    
    def run_regression_tests(self) -> Dict[str, Any]:
        """运行回归测试"""
        print("🧪 运行准确性回归测试")
        
        results = {
            "total_tests": len(self.test_cases),
            "passed_tests": 0,
            "failed_tests": 0,
            "test_results": []
        }
        
        for test_case in self.test_cases:
            print(f"  运行测试: {test_case['description']}")
            
            try:
                evaluation = self.accuracy_evaluator.evaluate_output(
                    test_case["output"],
                    test_case["id"]
                )
                
                passed = evaluation.gate_decision == test_case["expected_decision"]
                
                results["test_results"].append({
                    "test_id": test_case["id"],
                    "description": test_case["description"],
                    "expected_decision": test_case["expected_decision"].value,
                    "actual_decision": evaluation.gate_decision.value,
                    "passed": passed,
                    "evidence_coverage": evaluation.evidence_coverage,
                    "confidence_score": evaluation.confidence_score,
                    "warnings": evaluation.warnings
                })
                
                if passed:
                    results["passed_tests"] += 1
                    print(f"    ✓ 通过")
                else:
                    results["failed_tests"] += 1
                    print(f"    ✗ 失败: 期望{test_case['expected_decision'].value}, 实际{evaluation.gate_decision.value}")
                    
            except Exception as e:
                print(f"    ✗ 错误: {e}")
                results["failed_tests"] += 1
                results["test_results"].append({
                    "test_id": test_case["id"],
                    "error": str(e),
                    "passed": False
                })
        
        print(f"\n📊 回归测试结果: {results['passed_tests']}/{results['total_tests']} 通过")
        
        return results

# ============ M5/M12集成回归测试 ============

class M5M12IntegrationTest:
    """M5和M12集成回归测试"""
    
    def __init__(self, accuracy_gate: 'AccuracyGate'):
        self.accuracy_gate = accuracy_gate
        self.m5_available = M5_AVAILABLE
        self.m12_available = M12_AVAILABLE
        
    def run_m5_integration_tests(self) -> Dict[str, Any]:
        """运行M5集成测试"""
        print("🔗 运行M5模块集成测试")
        
        results = {
            "module": "M5",
            "available": self.m5_available,
            "tests": [],
            "passed": 0,
            "failed": 0
        }
        
        if not self.m5_available:
            print("   ⚠️ M5模块不可用，跳过集成测试")
            results["tests"].append({
                "name": "module_availability",
                "passed": False,
                "reason": "M5模块不可用"
            })
            return results
        
        # 测试1: M5测试用例生成
        try:
            TestCase = M5_CLASSES.get("TestCase")
            if TestCase:
                test_case = TestCase(
                    case_id="acc_gate_test_001",
                    case_name="防幻觉闸门准确性测试",
                    description="测试防幻觉闸门对无证据输出的检测能力",
                    project_data={"test": True},
                    expected_risk_level="low"
                )
                
                results["tests"].append({
                    "name": "test_case_generation",
                    "passed": True,
                    "details": f"成功生成测试用例: {test_case.case_id}"
                })
                results["passed"] += 1
            else:
                results["tests"].append({
                    "name": "test_case_generation",
                    "passed": False,
                    "reason": "TestCase类不可用"
                })
                results["failed"] += 1
                
        except Exception as e:
            results["tests"].append({
                "name": "test_case_generation",
                "passed": False,
                "reason": f"生成失败: {e}"
            })
            results["failed"] += 1
        
        # 测试2: M5测试结果记录
        try:
            TestResult = M5_CLASSES.get("TestResult")
            TestStatus = M5_CLASSES.get("TestStatus")
            
            if TestResult and TestStatus:
                test_result = TestResult(
                    case_id="acc_gate_test_001",
                    case_name="防幻觉闸门准确性测试",
                    status=TestStatus.PASSED,
                    actual_risk_level="low",
                    expected_risk_level="low",
                    passed=True,
                    start_time=time.time(),
                    end_time=time.time() + 1.0
                )
                
                results["tests"].append({
                    "name": "test_result_recording",
                    "passed": True,
                    "details": f"成功记录测试结果: {test_result.case_id}"
                })
                results["passed"] += 1
            else:
                results["tests"].append({
                    "name": "test_result_recording",
                    "passed": False,
                    "reason": "TestResult或TestStatus类不可用"
                })
                results["failed"] += 1
                
        except Exception as e:
            results["tests"].append({
                "name": "test_result_recording",
                "passed": False,
                "reason": f"记录失败: {e}"
            })
            results["failed"] += 1
        
        print(f"   📊 M5集成测试: {results['passed']}/{results['passed'] + results['failed']} 通过")
        return results
    
    def run_m12_integration_tests(self) -> Dict[str, Any]:
        """运行M12集成测试"""
        print("🔗 运行M12模块集成测试")
        
        results = {
            "module": "M12",
            "available": self.m12_available,
            "tests": [],
            "passed": 0,
            "failed": 0
        }
        
        if not self.m12_available:
            print("   ⚠️ M12模块不可用，跳过集成测试")
            results["tests"].append({
                "name": "module_availability",
                "passed": False,
                "reason": "M12模块不可用"
            })
            return results
        
        # 测试1: OOD配置初始化
        try:
            OODConfig = M12_CLASSES.get("OODConfig")
            if OODConfig:
                config = OODConfig()
                
                results["tests"].append({
                    "name": "ood_config_initialization",
                    "passed": True,
                    "details": f"成功初始化OOD配置，输出目录: {config.output_dir}"
                })
                results["passed"] += 1
            else:
                results["tests"].append({
                    "name": "ood_config_initialization",
                    "passed": False,
                    "reason": "OODConfig类不可用"
                })
                results["failed"] += 1
                
        except Exception as e:
            results["tests"].append({
                "name": "ood_config_initialization",
                "passed": False,
                "reason": f"初始化失败: {e}"
            })
            results["failed"] += 1
        
        # 测试2: OOD测试生成
        try:
            OODTestGenerator = M12_CLASSES.get("OODTestGenerator")
            
            if OODTestGenerator and OODConfig:
                config = OODConfig()
                generator = OODTestGenerator(config)
                
                # 尝试生成测试
                tests = generator.generate_tests(count=2)
                
                results["tests"].append({
                    "name": "ood_test_generation",
                    "passed": True,
                    "details": f"成功生成OOD测试，数量: {len(tests)}"
                })
                results["passed"] += 1
            else:
                results["tests"].append({
                    "name": "ood_test_generation",
                    "passed": False,
                    "reason": "OODTestGenerator类不可用"
                })
                results["failed"] += 1
                
        except Exception as e:
            results["tests"].append({
                "name": "ood_test_generation",
                "passed": False,
                "reason": f"生成失败: {e}"
            })
            results["failed"] += 1
        
        # 测试3: 极端场景测试
        try:
            # 创建极端场景输出测试
            extreme_output = "在市场崩盘、资源断供、监管剧变的三重极端压力下，项目依然保持90%的存活率。"
            
            evaluation = self.accuracy_gate.check_output(extreme_output, "extreme_scenario_test")
            
            # 检查防幻觉闸门是否能够处理极端场景
            results["tests"].append({
                "name": "extreme_scenario_handling",
                "passed": evaluation.gate_decision in [GateDecision.PASS_WITH_WARNING, GateDecision.REJECT, GateDecision.REQUIRES_REVISION],
                "details": f"防幻觉闸门处理极端场景，决策: {evaluation.gate_decision.value}"
            })
            
            if evaluation.gate_decision in [GateDecision.PASS_WITH_WARNING, GateDecision.REJECT, GateDecision.REQUIRES_REVISION]:
                results["passed"] += 1
            else:
                results["failed"] += 1
                
        except Exception as e:
            results["tests"].append({
                "name": "extreme_scenario_handling",
                "passed": False,
                "reason": f"处理失败: {e}"
            })
            results["failed"] += 1
        
        print(f"   📊 M12集成测试: {results['passed']}/{results['passed'] + results['failed']} 通过")
        return results
    
    def run_integration_report(self) -> Dict[str, Any]:
        """运行完整集成报告"""
        print("=" * 60)
        print("🔗 M5/M12模块集成测试报告")
        print("=" * 60)
        
        m5_results = self.run_m5_integration_tests()
        m12_results = self.run_m12_integration_tests()
        
        total_tests = len(m5_results["tests"]) + len(m12_results["tests"])
        total_passed = m5_results["passed"] + m12_results["passed"]
        
        report = {
            "timestamp": time.time(),
            "summary": {
                "m5_available": self.m5_available,
                "m12_available": self.m12_available,
                "total_tests": total_tests,
                "total_passed": total_passed,
                "total_failed": total_tests - total_passed,
                "success_rate": total_passed / total_tests if total_tests > 0 else 0
            },
            "m5_results": m5_results,
            "m12_results": m12_results,
            "recommendations": []
        }
        
        # 生成建议
        if not self.m5_available:
            report["recommendations"].append("安装pandas和numpy依赖以使M5模块完全可用")
        
        if not self.m12_available:
            report["recommendations"].append("检查M12模块文件是否存在和依赖")
        
        if total_passed < total_tests * 0.7:
            report["recommendations"].append("集成测试通过率较低，建议检查和修复模块接口")
        
        print(f"\n📊 集成测试总结:")
        print(f"  M5可用性: {'✅' if self.m5_available else '❌'}")
        print(f"  M12可用性: {'✅' if self.m12_available else '❌'}")
        print(f"  总测试数: {total_tests}")
        print(f"  通过数: {total_passed}")
        print(f"  成功率: {report['summary']['success_rate']:.1%}")
        
        if report["recommendations"]:
            print("\n💡 建议:")
            for rec in report["recommendations"]:
                print(f"  • {rec}")
        
        print("=" * 60)
        
        return report

# ============ 主闸门类 ============

class AccuracyGate:
    """准确性闸门主类"""
    
    def __init__(self, evidence_db_path: Optional[str] = None):
        self.evidence_tracker = EvidenceTracker(evidence_db_path)
        self.accuracy_evaluator = AccuracyEvaluator(self.evidence_tracker)
        self.regression_test = AccuracyRegressionTest(self.accuracy_evaluator)
        self.m5m12_integration = M5M12IntegrationTest(self)
        
        # 模块状态
        self.m5_available = M5_AVAILABLE
        self.m12_available = M12_AVAILABLE
        
        # 初始化示例证据
        self._initialize_sample_evidence()
        
        print("🚪 准确性闸门初始化完成")
        print(f"  M5模块: {'✅ 可用' if self.m5_available else '⚠️ 受限'}")
        print(f"  M12模块: {'✅ 可用' if self.m12_available else '⚠️ 受限'}")
    
    def _initialize_sample_evidence(self):
        """初始化示例证据"""
        # 添加一些示例证据用于测试
        sample_evidence = [
            Evidence(
                evidence_id="ev_001",
                content="根据Gartner 2024年报告，AI市场预计到2027年将达到5000亿美元",
                source_type="external",
                source_name="Gartner",
                source_url="https://www.gartner.com",
                evidence_type="market_data",
                timestamp=time.time() - 30 * 24 * 3600,  # 30天前
                expiration_days=365,
                confidence=ConfidenceLevel.HIGH,
                verification_method="cross_reference",
                verification_timestamp=time.time() - 30 * 24 * 3600,
                status=EvidenceStatus.VERIFIED
            ),
            Evidence(
                evidence_id="ev_002",
                content="智能手机普及率在2023年达到75%",
                source_type="external",
                source_name="Statista",
                source_url="https://www.statista.com",
                evidence_type="market_data",
                timestamp=time.time() - 90 * 24 * 3600,  # 90天前
                expiration_days=180,
                confidence=ConfidenceLevel.HIGH,
                verification_method="manual",
                verification_timestamp=time.time() - 90 * 24 * 3600,
                status=EvidenceStatus.VERIFIED
            ),
            Evidence(
                evidence_id="ev_003",
                content="初创企业失败率在前3年约为90%",
                source_type="external",
                source_name="CB Insights",
                source_url="https://www.cbinsights.com",
                evidence_type="case_study",
                timestamp=time.time() - 365 * 24 * 3600,  # 1年前
                expiration_days=180,
                confidence=ConfidenceLevel.MEDIUM,
                verification_method="manual",
                verification_timestamp=time.time() - 365 * 24 * 3600,
                status=EvidenceStatus.EXPIRED  # 已过期
            )
        ]
        
        for evidence in sample_evidence:
            self.evidence_tracker.add_evidence(evidence)
    
    def check_output(self, output_text: str, output_id: str) -> AccuracyEvaluation:
        """检查输出准确性"""
        return self.accuracy_evaluator.evaluate_output(output_text, output_id)
    
    def add_evidence(self, content: str, source_type: str, source_name: str, **kwargs) -> str:
        """添加新证据"""
        evidence_id = f"ev_{int(time.time())}_{hashlib.md5(content.encode()).hexdigest()[:8]}"
        
        evidence = Evidence(
            evidence_id=evidence_id,
            content=content,
            source_type=source_type,
            source_name=source_name,
            **kwargs
        )
        
        return self.evidence_tracker.add_evidence(evidence)
    
    def run_regression_tests(self) -> Dict[str, Any]:
        """运行回归测试"""
        return self.regression_test.run_regression_tests()
    
    def save_evidence_db(self, filepath: str):
        """保存证据数据库"""
        self.evidence_tracker.save_evidence_db(filepath)
    
    def load_evidence_db(self, filepath: str):
        """加载证据数据库"""
        self.evidence_tracker.load_evidence_db(filepath)
    
    def run_m5m12_integration_tests(self) -> Dict[str, Any]:
        """运行M5/M12模块集成测试"""
        return self.m5m12_integration.run_integration_report()
    
    def check_with_m5_test_framework(self, output_text: str, test_case_name: str = None) -> Dict[str, Any]:
        """使用M5测试框架检查输出"""
        if not self.m5_available:
            return {
                "status": "error",
                "message": "M5模块不可用",
                "suggestion": "安装pandas和numpy依赖"
            }
        
        try:
            TestCase = M5_CLASSES.get("TestCase")
            TestResult = M5_CLASSES.get("TestResult")
            TestStatus = M5_CLASSES.get("TestStatus")
            
            if not all([TestCase, TestResult, TestStatus]):
                return {
                    "status": "error",
                    "message": "M5核心类不可用",
                    "available_classes": list(M5_CLASSES.keys())
                }
            
            # 创建测试用例
            test_case_id = test_case_name or f"acc_gate_{int(time.time())}"
            test_case = TestCase(
                case_id=test_case_id,
                case_name="防幻觉闸门准确性测试",
                description="使用M5测试框架验证输出准确性",
                project_data={"output_text": output_text},
                expected_risk_level="low",
                tags=["accuracy_gate", "hallucination_check"]
            )
            
            # 运行准确性评估
            evaluation = self.check_output(output_text, test_case_id)
            
            # 创建测试结果
            test_result = TestResult(
                case_id=test_case.case_id,
                case_name=test_case.case_name,
                status=TestStatus.PASSED if evaluation.gate_decision == GateDecision.PASS else TestStatus.FAILED,
                actual_risk_level="low" if evaluation.gate_decision == GateDecision.PASS else "high",
                expected_risk_level=test_case.expected_risk_level,
                passed=evaluation.gate_decision == GateDecision.PASS,
                start_time=evaluation.timestamp - evaluation.duration if evaluation.duration > 0 else time.time() - 1.0,
                end_time=evaluation.timestamp,
                duration=evaluation.duration,
                metrics={
                    "evidence_coverage": evaluation.evidence_coverage,
                    "confidence_score": evaluation.confidence_score,
                    "hallucination_score": evaluation.hallucination_score,
                    "conflict_score": evaluation.conflict_score,
                    "gate_decision": evaluation.gate_decision.value
                }
            )
            
            return {
                "status": "success",
                "test_case": test_case.to_dict() if hasattr(test_case, 'to_dict') else str(test_case),
                "test_result": test_result.to_dict() if hasattr(test_result, 'to_dict') else str(test_result),
                "accuracy_evaluation": evaluation.to_dict(),
                "m5_integration": True
            }
            
        except Exception as e:
            return {
                "status": "error",
                "message": f"M5集成测试失败: {str(e)}",
                "error_type": type(e).__name__
            }
    
    def check_with_m12_extreme_scenarios(self, output_text: str) -> Dict[str, Any]:
        """使用M12极端场景检查输出"""
        if not self.m12_available:
            return {
                "status": "error",
                "message": "M12模块不可用",
                "suggestion": "检查M12模块文件和依赖"
            }
        
        try:
            OODConfig = M12_CLASSES.get("OODConfig")
            
            if not OODConfig:
                return {
                    "status": "error",
                    "message": "M12 OODConfig类不可用"
                }
            
            # 创建OOD配置
            config = OODConfig()
            
            # 运行准确性评估
            evaluation = self.check_output(output_text, f"m12_ood_test_{int(time.time())}")
            
            # 分析极端场景下的表现
            is_extreme_scenario = any(keyword in output_text.lower() for keyword in [
                "崩盘", "断供", "剧变", "极端", "高压", "危机", "灾难", "失败", "倒闭"
            ])
            
            resilience_score = 0.0
            if is_extreme_scenario:
                # 极端场景下，要求更高的证据标准
                resilience_score = evaluation.evidence_coverage * 0.8 + evaluation.confidence_score * 0.2
                
                # 如果幻觉或冲突评分高，韧性分数降低
                resilience_score *= (1.0 - evaluation.hallucination_score * 0.5)
                resilience_score *= (1.0 - evaluation.conflict_score * 0.5)
            
            passes_extreme_test = resilience_score > 0.5 if is_extreme_scenario else True
            
            return {
                "status": "success",
                "is_extreme_scenario": is_extreme_scenario,
                "resilience_score": resilience_score,
                "passes_extreme_test": passes_extreme_test,
                "accuracy_evaluation": evaluation.to_dict(),
                "m12_integration": True,
                "ood_config": {
                    "output_dir": config.output_dir,
                    "max_ood_steps": getattr(config, "max_ood_steps", 24),
                    "resilience_threshold": getattr(config, "resilience_threshold", 0.6)
                }
            }
            
        except Exception as e:
            return {
                "status": "error",
                "message": f"M12集成测试失败: {str(e)}",
                "error_type": type(e).__name__
            }

# ============ 证据覆盖率报告 ============

def generate_evidence_coverage_report(evaluations: List[AccuracyEvaluation], 
                                     output_dir: str = "reports") -> Dict[str, Any]:
    """生成证据覆盖率报告"""
    
    report_data = {
        "report_id": f"coverage_report_{int(time.time())}",
        "generated_at": datetime.now().isoformat(),
        "total_evaluations": len(evaluations),
        "summary": {
            "avg_evidence_coverage": 0.0,
            "avg_confidence_score": 0.0,
            "total_statements": 0,
            "verified_statements": 0,
            "problematic_statements": 0
        },
        "evaluation_details": [],
        "trend_analysis": {},
        "recommendations": []
    }
    
    if not evaluations:
        return report_data
    
    # 计算汇总统计
    total_coverage = 0.0
    total_confidence = 0.0
    total_statements = 0
    total_verified = 0
    total_problematic = 0
    
    for eval_obj in evaluations:
        total_coverage += eval_obj.evidence_coverage
        total_confidence += eval_obj.confidence_score
        total_statements += eval_obj.total_statements
        total_verified += eval_obj.verified_statements
        total_problematic += (eval_obj.unverified_statements + 
                             eval_obj.conflicting_statements + 
                             eval_obj.hallucinated_statements)
        
        # 添加详细记录
        report_data["evaluation_details"].append({
            "output_id": eval_obj.output_id,
            "gate_decision": eval_obj.gate_decision.value,
            "evidence_coverage": eval_obj.evidence_coverage,
            "confidence_score": eval_obj.confidence_score,
            "total_statements": eval_obj.total_statements,
            "verified_statements": eval_obj.verified_statements,
            "problematic_statements": (eval_obj.unverified_statements + 
                                      eval_obj.conflicting_statements + 
                                      eval_obj.hallucinated_statements),
            "warnings": eval_obj.warnings[:3] if eval_obj.warnings else []
        })
    
    # 计算平均值
    report_data["summary"]["avg_evidence_coverage"] = total_coverage / len(evaluations)
    report_data["summary"]["avg_confidence_score"] = total_confidence / len(evaluations)
    report_data["summary"]["total_statements"] = total_statements
    report_data["summary"]["verified_statements"] = total_verified
    report_data["summary"]["problematic_statements"] = total_problematic
    
    # 趋势分析
    if len(evaluations) >= 3:
        # 按时间排序（假设evaluations已按时间排序）
        recent_coverage = [e.evidence_coverage for e in evaluations[-3:]]
        trend = "improving" if recent_coverage[-1] > recent_coverage[0] else "declining"
        
        report_data["trend_analysis"] = {
            "recent_trend": trend,
            "coverage_trend": recent_coverage,
            "suggested_action": "增加证据收集" if trend == "declining" else "保持当前实践"
        }
    
    # 生成建议
    coverage_rate = total_verified / total_statements if total_statements > 0 else 0
    
    if coverage_rate < 0.5:
        report_data["recommendations"].append("⚠️ 证据覆盖率严重不足，建议加强证据收集和引用")
    elif coverage_rate < 0.7:
        report_data["recommendations"].append("⚠️ 证据覆盖率偏低，建议优化证据管理")
    else:
        report_data["recommendations"].append("✅ 证据覆盖率良好，继续保持")
    
    if total_problematic > total_statements * 0.3:
        report_data["recommendations"].append("⚠️ 问题声明比例过高，建议加强质量检查")
    
    # 保存报告
    output_path = Path(output_dir) / f"evidence_coverage_{int(time.time())}.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(report_data, f, indent=2, ensure_ascii=False)
    
    print(f"📄 证据覆盖率报告已保存: {output_path}")
    
    return report_data

# ============ 使用示例 ============

if __name__ == "__main__":
    print("=" * 60)
    print("准确性评测与防幻觉闸门系统")
    print("=" * 60)
    
    # 1. 初始化闸门
    gate = AccuracyGate()
    
    # 2. 添加一些证据
    gate.add_evidence(
        content="机器学习项目平均开发周期为6-9个月",
        source_type="external",
        source_name="行业报告",
        evidence_type="expert_opinion",
        confidence=ConfidenceLevel.MEDIUM
    )
    
    # 3. 测试输出
    test_outputs = [
        {
            "id": "output_001",
            "text": "根据行业报告，机器学习项目平均需要6-9个月开发时间。这个项目预计在3个月内完成，因为我们的团队经验丰富。"
        },
        {
            "id": "output_002",
            "text": "这个项目肯定会成功，市场前景非常好。我们已经验证了所有技术方案。"
        },
        {
            "id": "output_003",
            "text": "市场增长率为15%。不对，应该是25%。可能实际是20%。"
        }
    ]
    
    evaluations = []
    
    for test in test_outputs:
        print(f"\n📝 测试输出: {test['id']}")
        print(f"内容: {test['text'][:100]}...")
        
        evaluation = gate.check_output(test["text"], test["id"])
        evaluations.append(evaluation)
        
        print(f"决策: {evaluation.gate_decision.value}")
        print(f"证据覆盖率: {evaluation.evidence_coverage:.1%}")
        print(f"置信度评分: {evaluation.confidence_score:.2f}")
        
        if evaluation.warnings:
            print("警告:")
            for warning in evaluation.warnings[:3]:
                print(f"  ⚠️ {warning}")
    
    # 4. 运行回归测试
    print("\n" + "=" * 60)
    regression_results = gate.run_regression_tests()
    
    # 5. 生成证据覆盖率报告
    print("\n" + "=" * 60)
    report = generate_evidence_coverage_report(evaluations, "reports")
    
    print(f"\n📊 报告摘要:")
    print(f"  平均证据覆盖率: {report['summary']['avg_evidence_coverage']:.1%}")
    print(f"  总声明数: {report['summary']['total_statements']}")
    print(f"  已验证声明: {report['summary']['verified_statements']}")
    
    # 6. 保存证据数据库
    gate.save_evidence_db("evidence_db.json")
    
    print("\n" + "=" * 60)
    print("✅ 准确性闸门系统测试完成")
    print("=" * 60)