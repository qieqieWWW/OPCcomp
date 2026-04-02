from __future__ import annotations

import argparse
import importlib
import json
from pathlib import Path
import sys


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = PROJECT_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", default="跨境医疗SaaS项目，资金压力较大，且暂无技术团队。")
    parser.add_argument("--host", default="http://10.7.88.150:8080")
    parser.add_argument("--model", default="test")
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--try-remote-llm", action="store_true")
    args = parser.parse_args()

    DynamicRoutingPipeline = importlib.import_module("opc_router").DynamicRoutingPipeline
    AISV2Client = importlib.import_module("opc_router.service_client").AISV2Client

    project_root = PROJECT_ROOT
    pipeline = DynamicRoutingPipeline(
        project_root=project_root,
        service_host=args.host,
        service_model=args.model,
        api_key=args.api_key,
    )

    result = pipeline.run(user_text=args.text, try_remote_llm=args.try_remote_llm)
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if result.get("remote_llm"):
        text = AISV2Client.extract_text(result["remote_llm"])
        if text:
            print("\n[Remote LLM]\n" + text)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
