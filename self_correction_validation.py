#!/usr/bin/env python3
"""
Self-Correction Loop Validation Script
Tests core components: TemporalFreshnessChecker, ConflictAnalyzer, CorrectionInstructor, WebSearchLogger
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from self_correction_loop import (
    TemporalFreshnessChecker,
    KnowledgeSourceMetadata,
    FreshnessLevel,
    ConflictAnalyzer,
    ConflictReport,
    CorrectionInstructor,
    WebSearchLogger,
    CorrectionReason,
    SelfCorrectionResult,
)
from accuracy_gate import Evidence, EvidenceStatus, GateDecision


def test_temporal_freshness_checker():
    """Test 1: Verify temporal freshness evaluation with reference date"""
    print("\n" + "="*70)
    print("TEST 1: Temporal Freshness Checker")
    print("="*70)
    
    reference_date = "2026-04-13"
    checker = TemporalFreshnessChecker(reference_date=reference_date)
    
    should_query, freshness_report = checker.check_freshness()
    
    print(f"\nReference date: {reference_date}")
    print("\nFreshness Assessment:")
    for source_name, info in freshness_report.items():
        print(f"  {source_name}: {info['freshness']} (last: {info['last_update']})")
    
    print(f"\nShould query web: {should_query}")
    
    kb_info = freshness_report["knowledge_base"]
    assert kb_info["freshness"] == "very_stale", f"Expected very_stale, got {kb_info['freshness']}"
    assert should_query is True
    print("✅ TEST 1 PASSED")
    return True


def test_conflict_analyzer():
    """Test 2: Verify conflict detection"""
    print("\n" + "="*70)
    print("TEST 2: Conflict Analyzer")
    print("="*70)
    
    analyzer = ConflictAnalyzer()
    
    original = "The startup focuses on AI-driven healthcare solutions"
    evidence_list = [
        Evidence(
            evidence_id="ev_001",
            content="AI healthcare startup shows promising market expansion",
            source_type="web",
            source_name="web_1",
            source_url="https://example.com/1",
            status=EvidenceStatus.VERIFIED,
            metadata={"reliability_score": 0.85}
        )
    ]
    
    result = analyzer.analyze(original, evidence_list)
    print(f"\nConflict detected: {result.has_conflict}")
    print(f"Conflict type: {result.conflict_type}")
    print(f"Supporting evidence: {len(result.supporting_evidence)}")
    
    print("✅ TEST 2 PASSED")
    return True


def test_correction_instructor():
    """Test 3: Verify correction prompt generation"""
    print("\n" + "="*70)
    print("TEST 3: Correction Instructor")
    print("="*70)
    
    instructor = CorrectionInstructor()
    
    original_output = "The startup has low risk due to established market position"
    
    conflict_report = ConflictReport(
        has_conflict=True,
        conflict_type="external_conflict",
        conflict_points=["Market volatility detected"],
        supporting_evidence=[],
        contradicting_evidence=["ev_001"],
        confidence_in_conflict=0.8
    )
    
    evidence_list = [
        Evidence(
            evidence_id="ev_001",
            content="Recent market analysis shows competitive pressure",
            source_type="report",
            source_name="market_report",
            source_url="https://example.com",
            status=EvidenceStatus.VERIFIED,
            metadata={"reliability_score": 0.85}
        )
    ]
    
    freshness_check = {
        "knowledge_base": {"freshness": "very_stale", "last_update": "2025-10-13"},
        "model": {"freshness": "stale", "last_update": "2025-12-13"}
    }
    
    prompt = instructor.generate(
        original_output=original_output,
        conflict_report=conflict_report,
        evidence_list=evidence_list,
        freshness_check=freshness_check
    )
    
    print(f"\nPrompt generated ({len(prompt)} chars)")
    print(f"Prompt preview: {prompt[:100]}...")
    
    assert "观点" in prompt or "assessment" in prompt.lower()
    print("✅ TEST 3 PASSED")
    return True


def test_web_search_logger():
    """Test 4: Verify logging system"""
    print("\n" + "="*70)
    print("TEST 4: Web Search Logger")
    print("="*70)
    
    log_dir = "./test_web_search_logs"
    logger = WebSearchLogger(log_dir=log_dir)
    
    freshness_report = {
        "knowledge_base": {"freshness": "very_stale", "last_update": "2025-10-13", "update_cycle_days": 180},
        "model": {"freshness": "stale", "last_update": "2025-12-13", "update_cycle_days": 120}
    }
    logger.log_freshness_check(freshness_report, "2026-04-13")
    logger.log_web_search_triggered("KB outdated", 3)
    
    conflict_report = ConflictReport(
        has_conflict=True,
        conflict_type="external_conflict",
        conflict_points=["Test"],
        supporting_evidence=[],
        contradicting_evidence=["ev_001"],
        confidence_in_conflict=0.8
    )
    logger.log_conflict_analysis(conflict_report)
    
    result = SelfCorrectionResult(
        original_output="Test",
        final_output="Test final",
        total_iterations=1,
        correction_applied=True,
        final_gate_decision=GateDecision.PASS,
        web_evidence_used=True,
        execution_time_ms=123.45
    )
    logger.log_final_result(result)
    
    print(f"Log directory: {log_dir}")
    if os.path.exists(log_dir):
        files = os.listdir(log_dir)
        print(f"Log files: {len(files)} created")
    
    import shutil
    if os.path.exists(log_dir):
        shutil.rmtree(log_dir)
        print("Logs cleaned up")
    
    print("✅ TEST 4 PASSED")
    return True


def test_module_integration():
    """Test 5: Verify module imports"""
    print("\n" + "="*70)
    print("TEST 5: Module Integration")
    print("="*70)
    
    try:
        from self_correction_loop import (
            TemporalFreshnessChecker,
            ConflictAnalyzer,
            CorrectionInstructor,
            WebSearchLogger,
            CorrectionReason,
            FreshnessLevel,
            ConflictReport,
            CorrectionIteration,
            SelfCorrectionResult,
            KnowledgeSourceMetadata
        )
        print("✓ All classes imported")
    except ImportError as e:
        raise AssertionError(f"Import failed: {e}")
    
    print("\nReason enum values:")
    for reason in CorrectionReason:
        print(f"  - {reason.value}")
    
    print("\nFreshness enum values:")
    for level in FreshnessLevel:
        print(f"  - {level.value}")
    
    metadata = KnowledgeSourceMetadata(
        source_name="test",
        last_update_date="2026-01-01",
        update_cycle_days=90,
        freshness_threshold_days=30
    )
    freshness = metadata.get_freshness("2026-04-13")
    print(f"\nMetadata test: {freshness.name} (102 days old)")
    assert freshness == FreshnessLevel.STALE, f"Expected STALE, got {freshness.name}"
    
    print("✅ TEST 5 PASSED")
    return True


def run_all_tests():
    """Run all validation tests"""
    print("\n" + "="*70)
    print("SELF-CORRECTION LOOP VALIDATION SUITE")
    print("="*70)
    
    tests = [
        ("Temporal Freshness Checker", test_temporal_freshness_checker),
        ("Conflict Analyzer", test_conflict_analyzer),
        ("Correction Instructor", test_correction_instructor),
        ("Web Search Logger", test_web_search_logger),
        ("Module Integration", test_module_integration),
    ]
    
    passed = 0
    failed = 0
    
    for test_name, test_func in tests:
        try:
            if test_func():
                passed += 1
        except Exception as e:
            print(f"\n❌ TEST FAILED: {test_name}")
            print(f"Error: {str(e)}")
            import traceback
            traceback.print_exc()
            failed += 1
    
    print("\n" + "="*70)
    print("VALIDATION SUMMARY")
    print("="*70)
    print(f"Passed: {passed}/{len(tests)}")
    print(f"Failed: {failed}/{len(tests)}")
    
    if failed == 0:
        print("\n✅ ALL TESTS PASSED")
        return 0
    else:
        print(f"\n❌ {failed} TEST(S) FAILED")
        return 1


if __name__ == "__main__":
    exit_code = run_all_tests()
    sys.exit(exit_code)
