#!/usr/bin/env python
# coding: utf-8

"""
角色D模块可用性检查

检查内容:
1. accuracy_gate 核心类是否可导入
2. M5 / M12 文件是否可发现
3. 回归测试与融合入口是否可执行
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict


def check_role_d_modules() -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "status": "ok",
        "checks": [],
        "suggestions": [],
    }

    project_root = Path(__file__).resolve().parents[1]
    scripts_dir = project_root / "scripts"

    # 1) 核心模块导入检查
    try:
        from accuracy_gate import AccuracyGate, GateDecision, generate_evidence_coverage_report

        gate = AccuracyGate()
        smoke = gate.check_output(
            "根据 evidence:EV-KS-2025-MARKET 判断，该赛道存在增长空间。",
            "smoke_case",
        )

        # 融合入口 smoke test
        payload = {
            "claims": [
                {"claim_id": "c1", "claim": "项目有增长空间", "evidence_ids": ["EV-KS-2025-MARKET"]},
                {"claim_id": "c2", "claim": "项目无任何风险"},
            ],
            "evidence_trace": {"c1": ["EV-KS-2025-MARKET"]},
        }
        payload_eval = gate.evaluate_router_payload(payload, output_id="payload_smoke")
        packet = gate.to_runtime_gate_packet(payload_eval)

        report = generate_evidence_coverage_report([smoke, payload_eval], output_dir=str(project_root / "reports"))

        result["checks"].append(
            {
                "name": "accuracy_gate_import_and_smoke",
                "passed": True,
                "smoke_decision": smoke.gate_decision.value,
                "payload_decision": payload_eval.gate_decision.value,
                "packet_gate": packet.get("gate_decision"),
                "report_saved": report.get("saved_path"),
                "gate_enum_sample": GateDecision.PASS.value,
            }
        )
    except Exception as exc:
        result["status"] = "error"
        result["checks"].append(
            {
                "name": "accuracy_gate_import_and_smoke",
                "passed": False,
                "error": str(exc),
            }
        )

    # 2) M5/M12 可发现性
    m5_file = scripts_dir / "M5_AutoTest_Suite.py"
    m12_file = scripts_dir / "M12环境增强与OOD测试.py"

    m5_exists = m5_file.exists()
    m12_exists = m12_file.exists()

    result["checks"].append(
        {
            "name": "m5_m12_file_presence",
            "passed": m5_exists and m12_exists,
            "m5_exists": m5_exists,
            "m12_exists": m12_exists,
            "m5_path": str(m5_file),
            "m12_path": str(m12_file),
        }
    )

    if not m5_exists:
        result["suggestions"].append("缺少 scripts/M5_AutoTest_Suite.py，需补齐或调整路径")
    if not m12_exists:
        result["suggestions"].append("缺少 scripts/M12环境增强与OOD测试.py，需补齐或调整路径")

    if result["status"] == "ok" and not result["suggestions"]:
        result["suggestions"].append("角色D核心链路可用，建议接入 CI 每日回归")

    return result


def main() -> None:
    result = check_role_d_modules()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
