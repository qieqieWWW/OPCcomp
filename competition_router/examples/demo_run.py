from __future__ import annotations

import argparse
import importlib
import json
import os
from pathlib import Path
import sys


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = PROJECT_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value

def main() -> int:
    load_env_file(PROJECT_ROOT / ".env")

    parser = argparse.ArgumentParser()
    parser.add_argument("--text", default="跨境医疗SaaS项目，资金压力较大，且暂无技术团队。")
    parser.add_argument("--provider", choices=["qianfan", "deepseek"], default=None)
    parser.add_argument("--host", default=None)
    parser.add_argument("--base-url", default=None)
    parser.add_argument("--model", default=None)
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--try-remote-llm", action="store_true")
    args = parser.parse_args()

    DynamicRoutingPipeline = importlib.import_module("opc_router").DynamicRoutingPipeline
    extract_text = importlib.import_module("opc_router.service_client").extract_text

    provider = (args.provider or os.getenv("LLM_PROVIDER") or "qianfan").strip().lower()
    host = args.host or os.getenv("QIANFAN_HOST") or "http://10.7.88.150:8080"
    base_url = args.base_url or os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com"

    if args.model:
        model = args.model
    elif provider == "deepseek":
        model = os.getenv("DEEPSEEK_MODEL") or "deepseek-chat"
    else:
        model = os.getenv("QIANFAN_MODEL") or "test"

    if args.api_key:
        api_key = args.api_key
    elif provider == "deepseek":
        api_key = os.getenv("DEEPSEEK_API_KEY")
    else:
        api_key = os.getenv("QIANFAN_API_KEY")

    project_root = PROJECT_ROOT
    pipeline = DynamicRoutingPipeline(
        project_root=project_root,
        provider=provider,
        service_host=host,
        service_base_url=base_url,
        service_model=model,
        api_key=api_key,
    )

    result = pipeline.run(user_text=args.text, try_remote_llm=args.try_remote_llm)
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if result.get("remote_llm"):
        text = extract_text(result["remote_llm"])
        if text:
            print("\n[Remote LLM]\n" + text)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
