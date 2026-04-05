from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional


class AISV2Client:
    def __init__(self, host: str, api_key: Optional[str] = None, model: str = "test") -> None:
        self.host = host.rstrip("/")
        self.api_key = api_key
        self.model = model

    @property
    def url(self) -> str:
        return f"{self.host}/apis/ais-v2/chat/completions"

    def chat(self, messages: List[Dict[str, str]], temperature: float = 0.95) -> Dict[str, Any]:
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "temperature": temperature,
            "max_completion_tokens": 512,
        }
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        req = urllib.request.Request(self.url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                parsed = json.loads(body)
                return {"ok": True, "status": resp.status, "raw": parsed}
        except urllib.error.HTTPError as e:
            err = e.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(err)
            except Exception:
                parsed = {"error_message": err}
            return {"ok": False, "status": e.code, "raw": parsed}
        except urllib.error.URLError as e:
            return {"ok": False, "status": None, "raw": {"error_message": str(e)}}

    @staticmethod
    def extract_text(resp: Dict[str, Any]) -> str:
        return extract_text(resp)


class OpenAICompatClient:
    def __init__(self, base_url: str, api_key: Optional[str] = None, model: str = "deepseek-chat") -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    @property
    def url(self) -> str:
        return f"{self.base_url}/chat/completions"

    def chat(self, messages: List[Dict[str, str]], temperature: float = 0.7) -> Dict[str, Any]:
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "temperature": temperature,
            "max_tokens": 512,
        }
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        req = urllib.request.Request(self.url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                parsed = json.loads(body)
                return {"ok": True, "status": resp.status, "raw": parsed}
        except urllib.error.HTTPError as e:
            err = e.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(err)
            except Exception:
                parsed = {"error_message": err}
            return {"ok": False, "status": e.code, "raw": parsed}
        except urllib.error.URLError as e:
            return {"ok": False, "status": None, "raw": {"error_message": str(e)}}


def build_client(
    provider: str,
    *,
    host: Optional[str] = None,
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> Any:
    p = (provider or "qianfan").strip().lower()
    if p == "deepseek":
        resolved_base_url = (base_url or "https://api.deepseek.com").rstrip("/")
        resolved_model = model or "deepseek-chat"
        return OpenAICompatClient(base_url=resolved_base_url, api_key=api_key, model=resolved_model)

    resolved_host = (host or "http://10.7.88.150:8080").rstrip("/")
    resolved_model = model or "test"
    return AISV2Client(host=resolved_host, api_key=api_key, model=resolved_model)


def extract_text(resp: Dict[str, Any]) -> str:
        raw = resp.get("raw", {}) if isinstance(resp.get("raw"), dict) else {}
        choices = raw.get("choices", []) if isinstance(raw.get("choices"), list) else []
        if not choices:
            return ""
        msg = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
        return str(msg.get("content", ""))
