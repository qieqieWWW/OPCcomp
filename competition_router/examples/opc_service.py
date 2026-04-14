from __future__ import annotations

import argparse
import importlib
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys
from typing import Any, Dict


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


def build_pipeline() -> Any:
    DynamicRoutingPipeline = importlib.import_module("opc_router").DynamicRoutingPipeline

    provider = (os.getenv("LLM_PROVIDER") or "qianfan").strip().lower()
    host = os.getenv("QIANFAN_HOST") or "http://10.7.88.150:8080"
    base_url = os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com"

    if provider == "deepseek":
        model = os.getenv("DEEPSEEK_MODEL") or "deepseek-chat"
        api_key = os.getenv("DEEPSEEK_API_KEY")
    else:
        model = os.getenv("QIANFAN_MODEL") or "test"
        api_key = os.getenv("QIANFAN_API_KEY")

    return DynamicRoutingPipeline(
        project_root=PROJECT_ROOT,
        provider=provider,
        service_host=host,
        service_base_url=base_url,
        service_model=model,
        api_key=api_key,
    )


class OPCServiceHandler(BaseHTTPRequestHandler):
    pipeline: Any = None

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            small_model = getattr(self.pipeline, "small_model", None)
            backend = getattr(small_model, "backend", "unknown") if small_model is not None else "unknown"
            backend_reason = getattr(small_model, "backend_reason", "") if small_model is not None else ""
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": "competition-router-opc",
                    "small_model_backend": backend,
                    "small_model_backend_reason": backend_reason,
                },
            )
            return

        self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/route":
            self._send_json(404, {"ok": False, "error": "not_found"})
            return

        started_at = time.time()
        try:
            payload = self._read_json_body()
            input_text = str(payload.get("input", "")).strip()
            try_remote_llm = bool(payload.get("try_remote_llm", False))

            if not input_text:
                self._send_json(400, {"ok": False, "error": "input is required"})
                return

            preview = input_text.replace("\n", " ").strip()
            if len(preview) > 40:
                preview = f"{preview[:40]}..."
            print(f"[opc-service] /route start try_remote_llm={try_remote_llm} input='{preview}'")

            try:
                result = self.pipeline.run(user_text=input_text, try_remote_llm=try_remote_llm)
            except Exception as route_error:  # noqa: BLE001
                # Keep routing available even if remote LLM call fails.
                if not try_remote_llm:
                    raise
                result = self.pipeline.run(user_text=input_text, try_remote_llm=False)
                runtime_trace = result.get("runtime_trace") if isinstance(result, dict) else None
                if isinstance(runtime_trace, dict):
                    runtime_trace["remote_llm_called"] = True
                    runtime_trace["remote_llm_fallback"] = True
                    runtime_trace["remote_llm_error"] = str(route_error)

            self._send_json(
                200,
                {
                    "ok": True,
                    "small_model": result.get("small_model", {}),
                    "intent": result.get("intent", {}),
                    "conversation_reply": result.get("conversation_reply"),
                    "selected_experts": result.get("selected_experts", []),
                    "collaboration_plan": result.get("collaboration_plan", {}),
                    "info_pool_hits": result.get("info_pool_hits", []),
                    "knowledge_graph_hits": result.get("knowledge_graph_hits", []),
                    "research_fusion": result.get("research_fusion", {}),
                    "ranked_candidates": result.get("ranked_candidates", []),
                    "output_attribution": result.get("output_attribution", {}),
                    "runtime_trace": result.get("runtime_trace", {}),
                    "remote_llm": result.get("remote_llm"),
                },
            )
            elapsed_ms = int((time.time() - started_at) * 1000)
            print(f"[opc-service] /route done status=200 elapsed_ms={elapsed_ms}")
        except Exception as error:  # noqa: BLE001
            self._send_json(
                500,
                {
                    "ok": False,
                    "error": "opc_router_failed",
                    "message": str(error),
                },
            )
            elapsed_ms = int((time.time() - started_at) * 1000)
            print(f"[opc-service] /route done status=500 elapsed_ms={elapsed_ms} error={error}")

    def _read_json_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}

        data = self.rfile.read(length)
        if not data:
            return {}

        return json.loads(data.decode("utf-8"))

    def _send_json(self, status_code: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The caller timed out or closed socket before receiving response.
            return


def main() -> int:
    load_env_file(PROJECT_ROOT / ".env")

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.getenv("OPC_SERVICE_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("OPC_SERVICE_PORT", "18081")))
    args = parser.parse_args()

    OPCServiceHandler.pipeline = build_pipeline()

    server = HTTPServer((args.host, args.port), OPCServiceHandler)
    print(f"[opc-service] listening on http://{args.host}:{args.port}")
    print("[opc-service] routes: GET /health, POST /route")
    server.serve_forever()


if __name__ == "__main__":
    raise SystemExit(main())
