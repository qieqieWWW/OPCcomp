#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, List

from openai import OpenAI


DEFAULT_HOST = "http://10.7.88.150:8080"
V2_PATH = "/apis/ais-v2/chat/completions"
V1_PATH = "/apis/ais/chat/completions"


def build_messages(user_text: str) -> List[Dict[str, str]]:
    return [{"role": "user", "content": user_text}]


def build_payload(model: str, user_text: str, stream: bool = False) -> Dict[str, Any]:
    return {
        "model": model,
        "messages": build_messages(user_text),
        "stream": stream,
        "max_completion_tokens": 128,
        "temperature": 0.95,
    }


def call_v2_via_openai_sdk(
    host: str,
    model: str,
    user_text: str,
    api_key: str | None = None,
    stream: bool = False,
) -> Dict[str, Any]:
    if not api_key:
        # OpenAI SDK默认会附带Authorization头；免鉴权服务可直接走原生HTTP以避免无效鉴权头。
        v2_url = host.rstrip("/") + V2_PATH
        payload = build_payload(model=model, user_text=user_text, stream=stream)
        return post_json(url=v2_url, payload=payload, api_key=None)

    base_url = host.rstrip("/") + "/apis/ais-v2"
    client = OpenAI(
        api_key=api_key,
        base_url=base_url,
        default_headers={"Content-Type": "application/json"},
    )

    try:
        resp = client.chat.completions.create(
            model=model,
            messages=build_messages(user_text),
            stream=stream,
            max_completion_tokens=128,
            temperature=0.95,
        )

        if stream:
            chunks: List[Dict[str, Any]] = []
            for chunk in resp:
                chunks.append(chunk.model_dump())
            return {
                "ok": True,
                "status": 200,
                "body": json.dumps({"chunks": chunks}, ensure_ascii=False),
            }

        return {
            "ok": True,
            "status": 200,
            "body": json.dumps(resp.model_dump(), ensure_ascii=False),
        }
    except Exception as e:
        status = getattr(e, "status_code", None)
        body = getattr(e, "response", None)
        body_text = str(body) if body is not None else str(e)
        return {
            "ok": False,
            "status": status,
            "body": body_text,
        }


def post_json(url: str, payload: Dict[str, Any], api_key: str | None = None) -> Dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    req = urllib.request.Request(url=url, data=body, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            return {
                "ok": True,
                "status": resp.status,
                "body": text,
            }
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        return {
            "ok": False,
            "status": e.code,
            "body": err_body,
        }
    except urllib.error.URLError as e:
        return {
            "ok": False,
            "status": None,
            "body": str(e),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Call AIS chat completion service (V1/V2).")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Service host, e.g. http://10.7.88.150:8080")
    parser.add_argument("--version", choices=["v1", "v2"], default="v2", help="API version path")
    parser.add_argument("--model", default="test", help="Interface name / model")
    parser.add_argument("--text", default="你好，请用一句话介绍你自己。", help="User prompt text")
    parser.add_argument("--api-key", default=None, help="Optional API key for Authorization Bearer")
    args = parser.parse_args()

    if args.version == "v2":
        print(f"[INFO] Request Base URL: {args.host.rstrip('/') + '/apis/ais-v2'}")
        print(f"[INFO] Endpoint: /chat/completions")
        print(f"[INFO] Model: {args.model}")
        print(f"[INFO] Payload: {json.dumps(build_payload(args.model, args.text), ensure_ascii=False)}")
        result = call_v2_via_openai_sdk(
            host=args.host,
            model=args.model,
            user_text=args.text,
            api_key=args.api_key,
        )
    else:
        path = V1_PATH
        url = args.host.rstrip("/") + path
        payload = build_payload(model=args.model, user_text=args.text)
        print(f"[INFO] Request URL: {url}")
        print(f"[INFO] Model: {args.model}")
        print(f"[INFO] Payload: {json.dumps(payload, ensure_ascii=False)}")
        result = post_json(url=url, payload=payload, api_key=args.api_key)

    print(f"[INFO] HTTP status: {result['status']}")
    print("[INFO] Response body:")
    print(result["body"])

    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
