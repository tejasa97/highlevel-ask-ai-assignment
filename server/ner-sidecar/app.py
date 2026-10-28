"""FastAPI NER sidecar — contract: docs/ner-sidecar-contract.md

Endpoints:
  GET  /health
  POST /v1/extract   (also POST /extract)
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Literal, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from service import MODEL_NAME, service

logging.basicConfig(
    level=os.environ.get("NER_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("ner-sidecar")


class ExtractRequest(BaseModel):
    requestId: str = Field(..., min_length=1)
    utterance: str
    actorId: Optional[str] = None
    tier: Optional[Literal["fast", "strong"]] = None


class Candidate(BaseModel):
    id: str
    name: str
    score: Optional[float] = None
    entity: Optional[str] = None
    detail: Optional[str] = None


class LinkedSpan(BaseModel):
    text: str
    label: str
    start: int
    end: int
    status: Literal["linked", "ambiguous", "miss"]
    linkedId: Optional[str] = None
    linkedEntity: Optional[str] = None
    candidates: Optional[list[Candidate]] = None
    method: Optional[Literal["exact", "embed", "edit", "rule"]] = None
    score: Optional[float] = None


class ExtractResponse(BaseModel):
    requestId: str
    spans: list[LinkedSpan]
    model: Optional[str] = None
    latencyMs: Optional[float] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    lazy = os.environ.get("NER_LAZY_LOAD", "").lower() in ("1", "true", "yes")
    if lazy:
        log.info("NER_LAZY_LOAD set — model/index load deferred to first /v1/extract")
    else:
        log.info("warm-loading model + entity index on startup...")
        try:
            service.warm_load()
        except Exception:
            log.exception("warm-load failed")
            service.load_error = "warm-load failed; see logs"
            # Still start so /health can report the failure
    yield


app = FastAPI(title="Ask AI NER Sidecar", version="0.1.0", lifespan=lifespan)


def _ensure_ready() -> None:
    if service.ready:
        return
    if service.load_error and not os.environ.get("NER_LAZY_LOAD"):
        raise HTTPException(status_code=503, detail=f"sidecar not ready: {service.load_error}")
    log.info("lazy-loading model + index on first request...")
    try:
        service.warm_load()
    except Exception as e:
        service.load_error = str(e)
        log.exception("lazy load failed")
        raise HTTPException(status_code=503, detail=f"sidecar load failed: {e}") from e


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": service.ready,
        "model": MODEL_NAME if service.ready else None,
        "stats": service.stats if service.ready else None,
        "error": service.load_error,
    }


def _extract(body: ExtractRequest) -> ExtractResponse:
    _ensure_ready()
    raw = service.extract(body.requestId, body.utterance)
    return ExtractResponse(**raw)


@app.post("/v1/extract", response_model=ExtractResponse)
def extract_v1(body: ExtractRequest) -> ExtractResponse:
    return _extract(body)


@app.post("/extract", response_model=ExtractResponse)
def extract_alias(body: ExtractRequest) -> ExtractResponse:
    return _extract(body)
