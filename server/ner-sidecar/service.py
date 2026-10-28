"""GLiNER extract + PoC EntityIndex link, shaped to the Ask AI NER contract.

Thin wrapper: imports ``entity_index`` from the PoC via PYTHONPATH
(or NER_POC_SCRIPTS). Does not retrain or copy model weights.
"""
from __future__ import annotations

import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

from ids import linked_entity_for_label, to_store_id

log = logging.getLogger("ner-sidecar")

DEFAULT_POC_ROOT = Path(os.environ.get("NER_POC_ROOT", "/workspace/ask-ai-ner-poc"))
DEFAULT_MODEL = Path(
    os.environ.get(
        "NER_MODEL_PATH",
        str(DEFAULT_POC_ROOT / "models" / "gliner_small_v21_ft_head" / "final"),
    )
)
DEFAULT_PEOPLE = Path(os.environ.get("NER_PEOPLE_PATH", str(DEFAULT_POC_ROOT / "data" / "people.jsonl")))
DEFAULT_COMPANIES = Path(
    os.environ.get("NER_COMPANIES_PATH", str(DEFAULT_POC_ROOT / "data" / "companies.jsonl"))
)
DEFAULT_ANN_DIR = Path(os.environ.get("NER_ANN_DIR", str(DEFAULT_POC_ROOT / "data" / "ann")))
DEFAULT_EMBED_THRESHOLD = float(os.environ.get("NER_EMBED_THRESHOLD", "0.9"))
DEFAULT_GLINER_THRESHOLD = float(os.environ.get("NER_GLINER_THRESHOLD", "0.4"))
MODEL_NAME = os.environ.get("NER_MODEL_NAME", "gliner_small_v21_ft_head")

LABELS = ["person", "company", "team", "product"]

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
ID_RE = re.compile(r"\b(?:us|co|ct|ld|tk|tm)_\d+(?:_\d+)*\b", re.I)
PHONE_RE = re.compile(r"\+\d{10,15}\b")


def _ensure_poc_scripts_on_path() -> Path:
    scripts = Path(os.environ.get("NER_POC_SCRIPTS", str(DEFAULT_POC_ROOT / "scripts")))
    scripts_s = str(scripts.resolve())
    if scripts_s not in sys.path:
        sys.path.insert(0, scripts_s)
    return scripts


def rule_spans(text: str) -> list[dict]:
    out = []
    for rx, typ in ((EMAIL_RE, "email"), (ID_RE, "id"), (PHONE_RE, "phone")):
        for m in rx.finditer(text):
            out.append(
                {
                    "text": m.group(0),
                    "label": typ,
                    "start": m.start(),
                    "end": m.end(),
                    "score": 1.0,
                    "source": "rule",
                }
            )
    return out


def utf16_len(s: str) -> int:
    """JS string length (UTF-16 code units)."""
    return sum(2 if ord(c) > 0xFFFF else 1 for c in s)


def to_utf16_offsets(text: str, start: int | None, end: int | None, span_text: str) -> tuple[int, int]:
    """Convert Python str indices to UTF-16 offsets; fall back to locating span_text."""
    if start is not None and end is not None and 0 <= start <= end <= len(text):
        if text[start:end] == span_text:
            return utf16_len(text[:start]), utf16_len(text[:end])
    idx = text.find(span_text)
    if idx >= 0:
        return utf16_len(text[:idx]), utf16_len(text[: idx + len(span_text)])
    return int(start or 0), int(end or 0)


class NerService:
    def __init__(self) -> None:
        self.model = None
        self.index = None
        self.ready = False
        self.model_path = DEFAULT_MODEL
        self.load_error: str | None = None
        self.stats: dict[str, Any] = {}

    def warm_load(self) -> None:
        t0 = time.time()
        _ensure_poc_scripts_on_path()
        from entity_index import EntityIndex  # type: ignore

        people_limit = os.environ.get("NER_PEOPLE_LIMIT")
        companies_limit = os.environ.get("NER_COMPANIES_LIMIT")
        people_limit_i = int(people_limit) if people_limit else None
        companies_limit_i = int(companies_limit) if companies_limit else None

        log.info("building entity index from %s + %s", DEFAULT_PEOPLE, DEFAULT_COMPANIES)
        t_idx = time.time()
        self.index = EntityIndex.from_seed(
            DEFAULT_PEOPLE,
            DEFAULT_COMPANIES,
            people_limit=people_limit_i,
            companies_limit=companies_limit_i,
        )
        log.info("exact maps ready in %.1fs", time.time() - t_idx)

        t_ann = time.time()
        ann_stats = self.index.ensure_ann(
            DEFAULT_ANN_DIR,
            embed_model=os.environ.get("NER_EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2"),
            rebuild=os.environ.get("NER_REBUILD_ANN", "").lower() in ("1", "true", "yes"),
        )
        log.info("ANN ready in %.1fs", time.time() - t_ann)

        if not self.model_path.exists():
            raise FileNotFoundError(
                f"GLiNER checkpoint not found at {self.model_path}. "
                "Set NER_MODEL_PATH or symlink the PoC final/ directory."
            )

        log.info("loading GLiNER from %s", self.model_path)
        t_m = time.time()
        from gliner import GLiNER

        self.model = GLiNER.from_pretrained(str(self.model_path))
        log.info("GLiNER ready in %.1fs", time.time() - t_m)

        self.stats = {
            "ann": ann_stats,
            "model_path": str(self.model_path),
            "warm_load_s": round(time.time() - t0, 2),
            "people_path": str(DEFAULT_PEOPLE),
            "companies_path": str(DEFAULT_COMPANIES),
            "ann_dir": str(DEFAULT_ANN_DIR),
            "embed_threshold": DEFAULT_EMBED_THRESHOLD,
        }
        self.ready = True
        log.info("sidecar warm-load complete in %.1fs", time.time() - t0)

    def _candidate_from_hit(self, hit, label: str) -> dict[str, Any]:
        e = hit.entity
        item: dict[str, Any] = {
            "id": to_store_id(e.id, entity_type=e.entity_type),
            "name": e.name,
            "score": round(float(hit.score), 4),
        }
        entity = linked_entity_for_label(label, e.role or e.entity_type)
        if entity:
            item["entity"] = entity
        if e.company:
            item["detail"] = e.company
        elif e.role:
            item["detail"] = e.role
        return item

    def _span_from_link(self, span: dict, utterance: str, link) -> dict[str, Any]:
        """Map a PoC LinkResult into a contract NerLinkedSpan. Never auto-pick ambiguous."""
        text = span.get("text") or ""
        label = span.get("label") or "person"
        start, end = to_utf16_offsets(utterance, span.get("start"), span.get("end"), text)
        out: dict[str, Any] = {
            "text": text,
            "label": label,
            "start": start,
            "end": end,
        }

        if link is None:
            out["status"] = "miss"
            if span.get("source") == "rule":
                out["method"] = "rule"
            if span.get("score") is not None:
                out["score"] = float(span["score"])
            return out

        if link.miss:
            out["status"] = "miss"
            if link.method:
                out["method"] = link.method
            return out

        method = link.method or "exact"
        score = link.score

        if link.ambiguous:
            # Contract: ambiguous → clarify. Ignore PoC top `linked` for write binding.
            # Cap list size for huge exact-dupe buckets (PoC seed has ~1k Sarah Johnsons).
            max_cands = int(os.environ.get("NER_MAX_CANDIDATES", "20"))
            hits = list(link.hits[:max_cands]) if max_cands > 0 else list(link.hits)
            out["status"] = "ambiguous"
            out["candidates"] = [self._candidate_from_hit(h, label) for h in hits]
            out["method"] = method
            if score is not None:
                out["score"] = float(score)
            return out

        if not link.linked:
            out["status"] = "miss"
            return out

        e = link.linked
        out["status"] = "linked"
        out["linkedId"] = to_store_id(e.id, entity_type=e.entity_type)
        entity = linked_entity_for_label(label, e.role or e.entity_type)
        if entity:
            out["linkedEntity"] = entity
        out["method"] = method
        if score is not None:
            out["score"] = float(score)
        return out

    def extract(self, request_id: str, utterance: str) -> dict:
        if not self.ready or self.model is None or self.index is None:
            raise RuntimeError("NER service not ready")

        t0 = time.time()
        ents = self.model.predict_entities(utterance, LABELS, threshold=DEFAULT_GLINER_THRESHOLD)
        spans = [
            {
                "text": e["text"],
                "label": e["label"],
                "start": e.get("start"),
                "end": e.get("end"),
                "score": float(e.get("score", 0)),
                "source": "gliner",
            }
            for e in ents
        ]
        spans.extend(rule_spans(utterance))

        seen: set[tuple] = set()
        uniq: list[dict] = []
        for s in spans:
            key = (s.get("start"), s.get("end"), s["label"], s["text"].lower())
            if key in seen:
                continue
            seen.add(key)
            uniq.append(s)

        embed_threshold = DEFAULT_EMBED_THRESHOLD
        embed_topk = int(os.environ.get("NER_EMBED_TOPK", "5"))
        ambiguous_margin = float(os.environ.get("NER_AMBIGUOUS_MARGIN", "0.03"))

        contract_spans: list[dict] = []
        for s in uniq:
            label = s.get("label", "")
            if s.get("source") == "rule" or label in ("email", "id", "phone", "team", "product"):
                contract_spans.append(self._span_from_link(s, utterance, None))
                continue
            link = self.index.link(
                s.get("text", ""),
                label,
                embed_threshold=embed_threshold,
                embed_topk=embed_topk,
                ambiguous_margin=ambiguous_margin,
            )
            contract_spans.append(self._span_from_link(s, utterance, link))

        latency_ms = round((time.time() - t0) * 1000, 1)
        return {
            "requestId": request_id,
            "spans": contract_spans,
            "model": MODEL_NAME,
            "latencyMs": latency_ms,
        }


service = NerService()
