"""FastAPI NER sidecar — contract: contract.py (exported to contract/ner-sidecar.schema.json)

Endpoints:
  GET  /health/live    the process is up (liveness: restart it if this fails)
  GET  /health/ready   model + index loaded and a warmup extract has run (readiness: send traffic only when 200)
  GET  /health         both, plus code/model/index versions, queue and load stats
  POST /v1/extract     (also POST /extract)
  PUT  /v1/scopes/{name}, GET /v1/scopes/{name}
"""
from __future__ import annotations

import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from contract import ExtractRequest, ExtractResponse, ScopeRequest, ScopeResponse
from service import Overloaded, ScopeUnavailable, service

logging.basicConfig(
    level=os.environ.get("NER_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("ner-sidecar")

LAZY = os.environ.get("NER_LAZY_LOAD", "").lower() in ("1", "true", "yes")


def _warm_load() -> None:
    log.info("warm-loading model + entity index...")
    try:
        service.load_once()
    except Exception as e:
        log.exception("warm-load failed")
        service.load_error = f"warm-load failed: {e}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    if LAZY:
        log.info("NER_LAZY_LOAD set — model/index load deferred to first /v1/extract")
    else:
        # In the background: uvicorn serves nothing until the lifespan yields, and liveness must answer while the
        # model loads. Readiness turns green when this finishes; a failure stays on /health/ready.
        threading.Thread(target=_warm_load, name="ner-warm-load", daemon=True).start()
    yield


app = FastAPI(title="Ask AI NER Sidecar", version=service.code_version, lifespan=lifespan)


class Busy(Exception):
    pass


@app.exception_handler(Busy)
async def busy(_req, exc: Busy) -> JSONResponse:
    # Fast 503 with a hint; the Node client treats it as "no hints this turn".
    return JSONResponse(status_code=503, content={"detail": str(exc), "overloaded": True}, headers={"Retry-After": "1"})


def _ensure_ready() -> None:
    if service.ready:
        return
    if not LAZY:
        raise HTTPException(status_code=503, detail=f"sidecar not ready: {service.load_error or 'still loading'}")
    log.info("lazy-loading model + index on first request...")
    try:
        service.load_once()
    except Exception as e:
        service.load_error = str(e)
        log.exception("lazy load failed")
        raise HTTPException(status_code=503, detail=f"sidecar load failed: {e}") from e


@app.get("/health/live")
def live() -> dict[str, Any]:
    return {"ok": True}


@app.get("/health/ready")
def ready() -> JSONResponse:
    body = {"ok": service.ready, "error": service.load_error, "versions": service.versions(service.index_version)}
    return JSONResponse(status_code=200 if service.ready else 503, content=body)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": service.ready,
        "live": True,
        "ready": service.ready,
        "model": service.model_label if service.loaded else None,
        "versions": service.versions(service.index_version),
        "scopes": {name: list(v.keys()) for name, v in service.scopes.items()},
        "queue": service.queue_stats(),
        "stats": service.stats if service.ready else None,
        "error": service.load_error,
    }


def _extract(body: ExtractRequest) -> ExtractResponse:
    _ensure_ready()
    t0 = time.perf_counter()
    try:
        raw = service.extract(body.requestId, body.utterance, body.scope, body.scopeVersion)
    except ScopeUnavailable as e:
        # Fail closed: a scoped caller never gets the big index.
        log.info("extract requestId=%s scope=%s outcome=scope_unavailable", body.requestId, body.scope)
        raise HTTPException(status_code=409, detail=str(e)) from e
    except Overloaded as e:
        log.warning("extract requestId=%s outcome=overloaded %s", body.requestId, e)
        raise Busy(f"sidecar overloaded: {e}") from e
    out = ExtractResponse(**raw)
    log.info(
        "extract requestId=%s scope=%s spans=%d model_ms=%s total_ms=%.1f",
        body.requestId, body.scope or "default", len(out.spans), raw.get("latencyMs"), (time.perf_counter() - t0) * 1000,
    )
    return out


@app.post("/v1/extract", response_model=ExtractResponse, response_model_exclude_none=True)
def extract_v1(body: ExtractRequest) -> ExtractResponse:
    return _extract(body)


@app.post("/extract", response_model=ExtractResponse, response_model_exclude_none=True)
def extract_alias(body: ExtractRequest) -> ExtractResponse:
    return _extract(body)


@app.put("/v1/scopes/{name}", response_model=ScopeResponse, response_model_exclude_none=True)
def put_scope(name: str, body: ScopeRequest) -> ScopeResponse:
    _ensure_ready()
    t0 = time.perf_counter()
    try:
        out = service.register_scope(name, body.version, [e.model_dump(exclude_none=True) for e in body.entities])
    except Overloaded as e:
        log.warning("scope %s version=%s outcome=overloaded %s", name, body.version, e)
        raise Busy(f"sidecar overloaded: {e}") from e
    log.info("scope %s version=%s entities=%d unchanged=%s ms=%.1f", name, body.version, len(body.entities), bool(out.get("unchanged")), (time.perf_counter() - t0) * 1000)
    return ScopeResponse(**out)


@app.get("/v1/scopes/{name}")
def get_scope(name: str) -> dict[str, Any]:
    got = service.scopes.get(name)
    if got is None:
        raise HTTPException(status_code=404, detail=f"scope {name!r} is not registered")
    return {"scope": name, "versions": list(got.keys())}
