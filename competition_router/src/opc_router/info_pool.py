from __future__ import annotations

import json
import math
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Tuple


def _ngrams(text: str, n: int = 2) -> List[str]:
    t = "".join((text or "").split())
    if len(t) < n:
        return [t] if t else []
    return [t[i : i + n] for i in range(len(t) - n + 1)]


def _vec(text: str) -> Counter:
    return Counter(_ngrams(text))


def _cos(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    ks = set(a) & set(b)
    dot = sum(a[k] * b[k] for k in ks)
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


def load_records(path: str) -> List[Dict[str, Any]]:
    p = Path(path)
    if not p.exists():
        return []
    with p.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return [x for x in data if isinstance(x, dict)] if isinstance(data, list) else []


def retrieve_from_info_pool(query: str, records: List[Dict[str, Any]], top_k: int = 3) -> List[Dict[str, Any]]:
    qv = _vec(query)
    scored: List[Tuple[float, Dict[str, Any]]] = []

    for rec in records:
        text = " ".join(
            [
                str(rec.get("title", "")),
                str(rec.get("industry", "")),
                " ".join(str(k) for k in rec.get("keywords", []) if isinstance(k, str)),
                str(rec.get("guideline", "")),
            ]
        )
        score = _cos(qv, _vec(text))
        if score > 0:
            scored.append((score, rec))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [{"score": round(s, 4), "record": r} for s, r in scored[: max(1, top_k)]]
