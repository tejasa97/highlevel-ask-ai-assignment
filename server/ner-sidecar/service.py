"""GLiNER extract + PoC EntityIndex link, shaped to the Ask AI NER contract.

Thin wrapper: imports ``entity_index`` from the PoC via PYTHONPATH
(or NER_POC_SCRIPTS). Does not retrain or copy model weights.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import subprocess
import sys
import threading
from collections import OrderedDict
from contextlib import contextmanager
import time
from pathlib import Path
from typing import Any, Iterator

from ids import linked_entity_for_label, to_store_id
from model_pin import PinnedModel, resolve_embedder, resolve_gliner

log = logging.getLogger("ner-sidecar")

__version__ = "0.2.0"

DEFAULT_POC_ROOT = Path(os.environ.get("NER_POC_ROOT", str(Path(__file__).resolve().parents[3] / "ask-ai-ner-poc")))
DEFAULT_PEOPLE = Path(os.environ.get("NER_PEOPLE_PATH", str(DEFAULT_POC_ROOT / "data" / "people.jsonl")))
DEFAULT_COMPANIES = Path(
    os.environ.get("NER_COMPANIES_PATH", str(DEFAULT_POC_ROOT / "data" / "companies.jsonl"))
)
DEFAULT_ANN_DIR = Path(os.environ.get("NER_ANN_DIR", str(DEFAULT_POC_ROOT / "data" / "ann")))
DEFAULT_EMBED_THRESHOLD = float(os.environ.get("NER_EMBED_THRESHOLD", "0.9"))
DEFAULT_SUGGEST_THRESHOLD = float(os.environ.get("NER_SUGGEST_THRESHOLD", "0.75"))
DEFAULT_EDIT_MAX_DISTANCE = int(os.environ.get("NER_EDIT_MAX_DISTANCE", "1"))
DEFAULT_GLINER_THRESHOLD = float(os.environ.get("NER_GLINER_THRESHOLD", "0.4"))
# Bounded concurrency: inference runs one at a time (self.lock); up to NER_MAX_QUEUE more requests wait at most
# NER_QUEUE_TIMEOUT_MS for it. Anything beyond that gets a fast 503 instead of piling up behind the model.
MAX_QUEUE = int(os.environ.get("NER_MAX_QUEUE", "4"))
QUEUE_TIMEOUT_S = int(os.environ.get("NER_QUEUE_TIMEOUT_MS", "500")) / 1000
WARMUP_UTTERANCE = "Email Sarah Johnson at Acme about the renewal"

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


class ScopeUnavailable(Exception):
    """A caller asked for a named scope that isn't registered (or is stale). Never fall back to the big index."""


class Overloaded(Exception):
    """The wait queue is full, or the wait for the model ran out: answer 503 now rather than queue without bound."""


def code_version() -> str:
    """Sidecar code version: NER_CODE_VERSION (the image build sets it to the git sha), else the checkout's HEAD."""
    sha = os.environ.get("NER_CODE_VERSION")
    if not sha:
        try:
            sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=Path(__file__).parent, capture_output=True, text=True, timeout=2).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            sha = ""
    return f"{__version__}+{sha}" if sha else __version__


def seed_version(paths: list[Path], *extra: str) -> str:
    """Content hash of the seed files (and the row limits applied), naming the default index."""
    h = hashlib.sha256()
    for p in paths:
        with p.open("rb") as f:
            while block := f.read(1 << 22):
                h.update(block)
    h.update("|".join(extra).encode())
    return "seed:" + h.hexdigest()[:16]


class NerService:
    def __init__(self) -> None:
        self.model = None
        self.index = None
        # Named, caller-supplied indexes (scope -> (version, EntityIndex)). The Ask app registers "ask" with its own
        # records; a request naming a scope links only against that scope's index.
        # Several versions per scope are kept (each Ask conversation may hold its own copy of the data), newest last.
        self.scopes: dict[str, "OrderedDict[str, Any]"] = {}
        # FastAPI runs sync endpoints on a thread pool. Two threads embedding at once (a scope build next to a link)
        # crashes torch/faiss on macOS, so building a scope and linking take turns.
        self.lock = threading.Lock()
        self._load_lock = threading.Lock()
        self._admit_lock = threading.Lock()
        self._admitted = 0
        self.rejected = 0
        # loaded: model + index in memory. ready: loaded and one warmup extract has run (readiness probe).
        self.loaded = False
        self.ready = False
        self.load_error: str | None = None
        self.stats: dict[str, Any] = {}
        self.code_version = code_version()
        self.gliner: PinnedModel | None = None
        self.embedder: PinnedModel | None = None
        self.index_version: str | None = None

    @property
    def model_label(self) -> str:
        return os.environ.get("NER_MODEL_NAME") or (self.gliner.label if self.gliner else "unloaded")

    def versions(self, index: str | None) -> dict[str, Any]:
        return {"code": self.code_version, "model": self.model_label, **({"index": index} if index else {})}

    @contextmanager
    def _turn(self, wait_s: float = QUEUE_TIMEOUT_S) -> Iterator[None]:
        """Take the model: one at a time, at most MAX_QUEUE waiting, each for at most wait_s."""
        with self._admit_lock:
            if self._admitted >= 1 + MAX_QUEUE:
                self.rejected += 1
                raise Overloaded(f"{self._admitted} requests in flight or queued (NER_MAX_QUEUE={MAX_QUEUE})")
            self._admitted += 1
        try:
            if not self.lock.acquire(timeout=wait_s):
                with self._admit_lock:
                    self.rejected += 1
                raise Overloaded(f"waited {int(wait_s * 1000)} ms for the model")
            try:
                yield
            finally:
                self.lock.release()
        finally:
            with self._admit_lock:
                self._admitted -= 1

    def queue_stats(self) -> dict[str, Any]:
        return {"inFlightOrQueued": self._admitted, "maxQueue": MAX_QUEUE, "queueTimeoutMs": int(QUEUE_TIMEOUT_S * 1000), "rejected": self.rejected}

    def load_once(self) -> None:
        """warm_load unless another thread already did (lazy mode: the first requests race to load)."""
        with self._load_lock:
            if not self.ready:
                self.warm_load()

    def warm_load(self) -> None:
        t0 = time.time()
        _ensure_poc_scripts_on_path()
        # torch before faiss (entity_index imports it): the other way round, GLiNER.from_pretrained segfaults on
        # macOS, since both bundle an OpenMP runtime.
        import torch  # noqa: F401
        from entity_index import EntityIndex  # type: ignore

        # Pin first: a wrong checkpoint should fail in milliseconds, not after a minute of indexing.
        t_pin = time.time()
        self.gliner = resolve_gliner(DEFAULT_POC_ROOT)
        self.embedder = resolve_embedder()
        log.info("models pinned in %.1fs: %s, %s", time.time() - t_pin, self.gliner.label, self.embedder.label)

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
        t_ver = time.time()
        self.index_version = seed_version([DEFAULT_PEOPLE, DEFAULT_COMPANIES], people_limit or "", companies_limit or "")
        log.info("default index version %s (hashed in %.1fs)", self.index_version, time.time() - t_ver)

        from sentence_transformers import SentenceTransformer

        t_ann = time.time()
        # The index keys its ANN cache by the repo name; the weights it embeds with are the pinned snapshot.
        self.index._embedder = SentenceTransformer(str(self.embedder.path))
        ann_stats = self.index.ensure_ann(
            DEFAULT_ANN_DIR,
            embed_model=self.embedder.name,
            rebuild=os.environ.get("NER_REBUILD_ANN", "").lower() in ("1", "true", "yes"),
        )
        log.info("ANN ready in %.1fs", time.time() - t_ann)

        log.info("loading GLiNER from %s", self.gliner.path)
        t_m = time.time()
        from gliner import GLiNER

        self.model = GLiNER.from_pretrained(str(self.gliner.path))
        log.info("GLiNER ready in %.1fs", time.time() - t_m)
        self.loaded = True

        # Readiness means a request will be answered at normal speed: run one extract so lazy torch/tokenizer
        # initialisation happens here, not on a user's turn.
        t_w = time.time()
        with self.lock:
            self._extract("warmup", WARMUP_UTTERANCE, None, None)
        warmup_ms = round((time.time() - t_w) * 1000, 1)

        self.stats = {
            "ann": ann_stats,
            "model": self.gliner.describe(),
            "embedder": self.embedder.describe(),
            "warm_load_s": round(time.time() - t0, 2),
            "warmup_ms": warmup_ms,
            "people_path": str(DEFAULT_PEOPLE),
            "companies_path": str(DEFAULT_COMPANIES),
            "ann_dir": str(DEFAULT_ANN_DIR),
            "embed_threshold": DEFAULT_EMBED_THRESHOLD,
            "suggest_threshold": DEFAULT_SUGGEST_THRESHOLD,
            "edit_max_distance": DEFAULT_EDIT_MAX_DISTANCE,
        }
        self.load_error = None
        self.ready = True
        log.info("sidecar ready in %.1fs (warmup extract %.0f ms)", time.time() - t0, warmup_ms)

    def register_scope(self, name: str, version: str, entities: list[dict]) -> dict[str, Any]:
        """Build an in-memory EntityIndex (exact + ANN + edit) from the caller's own records."""
        with self._turn():
            got = self.scopes.get(name)
            if got is not None and version in got:
                got.move_to_end(version)
                return {"scope": name, "version": version, "unchanged": True}
            return self._build_scope(name, version, entities)

    def _build_scope(self, name: str, version: str, entities: list[dict]) -> dict[str, Any]:
        _ensure_poc_scripts_on_path()
        from entity_index import Entity, EntityIndex  # type: ignore

        idx = EntityIndex()
        for e in entities:
            kind = (e.get("entity") or "").lower()
            idx.add(
                Entity(
                    id=e["id"],
                    name=e["name"],
                    entity_type="company" if kind == "company" else "person",
                    role=None if kind == "company" else kind,
                    company=e.get("detail"),
                )
            )
        # Share the big index's embedder when it is loaded, so registering a scope never reloads the model.
        if self.index is not None and getattr(self.index, "_embedder", None) is not None:
            idx._embedder = self.index._embedder
        ann = idx.build_ann(embed_model=self.embedder.name if self.embedder else "sentence-transformers/all-MiniLM-L6-v2") if entities else {}
        versions = self.scopes.setdefault(name, OrderedDict())
        versions[version] = idx
        while len(versions) > int(os.environ.get("NER_SCOPE_VERSIONS", "16")):
            versions.popitem(last=False)
        return {"scope": name, "version": version, "entities": len(entities), "ann": ann}

    def _index_for(self, scope: str | None, version: str | None):
        if scope is None:
            return self.index
        got = self.scopes.get(scope)
        if got is None:
            raise ScopeUnavailable(f"scope {scope!r} is not registered")
        if version is None:
            return next(reversed(got.values()))
        if version not in got:
            raise ScopeUnavailable(f"scope {scope!r} has no version {version}")
        got.move_to_end(version)
        return got[version]

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
            # Near-miss soft hits → ambiguous suggestions ("did you mean?"); never linkedId.
            if link.hits:
                max_cands = int(os.environ.get("NER_MAX_CANDIDATES", "20"))
                hits = list(link.hits[:max_cands]) if max_cands > 0 else list(link.hits)
                out["status"] = "ambiguous"
                out["candidates"] = [self._candidate_from_hit(h, label) for h in hits]
                out["method"] = link.method or "embed"
                if link.score is not None:
                    out["score"] = float(link.score)
                return out
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

    def extract(self, request_id: str, utterance: str, scope: str | None = None, scope_version: str | None = None) -> dict:
        with self._turn():
            return self._extract(request_id, utterance, scope, scope_version)

    def _scope_version(self, scope: str, version: str | None) -> str | None:
        got = self.scopes.get(scope)
        return version or (next(reversed(got.keys())) if got else None)

    def _extract(self, request_id: str, utterance: str, scope: str | None, scope_version: str | None) -> dict:
        if not self.loaded or self.model is None or self.index is None:
            raise RuntimeError("NER service not ready")
        index = self._index_for(scope, scope_version)
        index_version = self._scope_version(scope, scope_version) if scope else self.index_version

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
        suggest_threshold = DEFAULT_SUGGEST_THRESHOLD
        edit_max_distance = DEFAULT_EDIT_MAX_DISTANCE
        embed_topk = int(os.environ.get("NER_EMBED_TOPK", "5"))
        ambiguous_margin = float(os.environ.get("NER_AMBIGUOUS_MARGIN", "0.03"))
        max_candidates = int(os.environ.get("NER_MAX_CANDIDATES", "20"))

        contract_spans: list[dict] = []
        for s in uniq:
            label = s.get("label", "")
            if s.get("source") == "rule" or label in ("email", "id", "phone", "team", "product"):
                contract_spans.append(self._span_from_link(s, utterance, None))
                continue
            link = index.link(
                s.get("text", ""),
                label,
                embed_threshold=embed_threshold,
                suggest_threshold=suggest_threshold,
                embed_topk=embed_topk,
                ambiguous_margin=ambiguous_margin,
                edit_max_distance=edit_max_distance,
                max_candidates=max_candidates,
            )
            contract_spans.append(self._span_from_link(s, utterance, link))

        latency_ms = round((time.time() - t0) * 1000, 1)
        return {
            "requestId": request_id,
            "spans": contract_spans,
            "model": self.model_label,
            "latencyMs": latency_ms,
            **({"scope": scope} if scope else {}),
            "versions": self.versions(f"{scope}:{index_version}" if scope and index_version else index_version),
        }


service = NerService()
