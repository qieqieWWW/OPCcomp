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
        raw = resp.get("raw", {}) if isinstance(resp.get("raw"), dict) else {}
        choices = raw.get("choices", []) if isinstance(raw.get("choices"), list) else []
        if not choices:
            return ""
        msg = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
        return str(msg.get("content", ""))
