"""The sidecar's wire contract: Pydantic models, and the JSON Schema exported from them.

These models are the source of truth. `python contract.py` writes contract/ner-sidecar.schema.json, which the Node
client's zod schemas (server/src/retrieval/ner_sidecar_contract.ts) are checked against, and both sides run the
shared fixtures in contract/fixtures.json. Change a model here, regenerate, and both test suites tell you what else
has to follow.

Wire rules the schema states:
- Optional fields are absent, never null: responses are serialized with exclude_none, and the exported schema says
  so (no null branch on optional properties).
- Unknown fields are ignored on both sides, so a field can be added without breaking an older client.

Span invariants (cross-field, so not expressible in plain JSON Schema; both sides enforce them, listed under
"x-invariants" in the schema):
- status "linked" has a linkedId; "ambiguous" and "miss" have none.
- start <= end.
- every linkedId and candidate id is a Store id (ct_, ld_, us_, co_, tm_), never a PoC pe_ id.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.json_schema import models_json_schema

SCHEMA_PATH = Path(__file__).with_name("contract") / "ner-sidecar.schema.json"
FIXTURES_PATH = Path(__file__).with_name("contract") / "fixtures.json"

STORE_ID_PREFIXES = ("ct_", "ld_", "us_", "co_", "tm_")
INVARIANTS = [
    "status 'linked' requires linkedId; 'ambiguous' and 'miss' must not have one",
    "start <= end",
    "linkedId and candidate ids start with a Store prefix: " + ", ".join(STORE_ID_PREFIXES),
]

SpanLabel = Literal["person", "company", "email", "phone", "id", "team", "product", "contact", "lead", "user"]
LinkMethod = Literal["exact", "embed", "edit", "rule"]
SpanStatus = Literal["linked", "ambiguous", "miss"]
ScopeEntityKind = Literal["contact", "lead", "user", "company"]


class Wire(BaseModel):
    """Optional fields are absent on the wire, never null: an explicit null is rejected, as the schema says.
    Strict: no coercion either ("3" is not an offset), so Pydantic accepts exactly what the JSON Schema does."""

    model_config = ConfigDict(strict=True)

    @model_validator(mode="before")
    @classmethod
    def _no_nulls(cls, data: Any) -> Any:
        if isinstance(data, dict):
            nulls = [k for k, v in data.items() if v is None and k in cls.model_fields]
            if nulls:
                raise ValueError(f"null is not allowed for {', '.join(nulls)}: omit the field instead")
        return data


class ExtractRequest(Wire):
    requestId: str = Field(..., min_length=1)
    utterance: str
    actorId: Optional[str] = None
    tier: Optional[Literal["fast", "strong"]] = None
    # Link only against this registered scope's index (the Ask app sends "ask"). Unset = the default seed index.
    scope: Optional[str] = None
    scopeVersion: Optional[str] = None
    # false: link by exact name and edit distance only, no embedding matches. Unset = on.
    embed: Optional[bool] = None


class Candidate(Wire):
    id: str = Field(..., min_length=1)
    name: str
    score: Optional[float] = None
    entity: Optional[str] = None
    detail: Optional[str] = None


class LinkedSpan(Wire):
    model_config = {"json_schema_extra": {"x-invariants": INVARIANTS}}

    text: str
    label: SpanLabel
    start: int = Field(..., ge=0)
    end: int = Field(..., ge=0)
    status: SpanStatus
    linkedId: Optional[str] = None
    linkedEntity: Optional[str] = None
    candidates: Optional[list[Candidate]] = None
    method: Optional[LinkMethod] = None
    score: Optional[float] = None

    @model_validator(mode="after")
    def _invariants(self) -> "LinkedSpan":
        if self.status == "linked" and not self.linkedId:
            raise ValueError("a linked span needs a linkedId")
        if self.status != "linked" and self.linkedId:
            raise ValueError(f"a {self.status} span must not carry a linkedId")
        if self.start > self.end:
            raise ValueError("start is after end")
        for id_ in [self.linkedId, *(c.id for c in self.candidates or [])]:
            if id_ and not id_.startswith(STORE_ID_PREFIXES):
                raise ValueError(f"{id_} is not a Store id")
        return self


class Versions(Wire):
    """What produced the spans: sidecar code, model (name@revision) and the index linked against."""

    code: str
    model: str
    index: Optional[str] = None


class ExtractResponse(Wire):
    requestId: str
    spans: list[LinkedSpan]
    model: Optional[str] = None
    latencyMs: Optional[float] = Field(default=None, ge=0)
    # The scope the spans were linked against, echoed back.
    scope: Optional[str] = None
    versions: Optional[Versions] = None


class ScopeEntity(Wire):
    id: str = Field(..., min_length=1)
    name: str
    entity: ScopeEntityKind
    detail: Optional[str] = None


class ScopeRequest(Wire):
    version: str = Field(..., min_length=1)
    entities: list[ScopeEntity]


class ScopeResponse(Wire):
    scope: str
    version: str
    unchanged: Optional[bool] = None
    entities: Optional[int] = None
    ann: Optional[dict[str, Any]] = None


EXPORTED = [
    (ExtractRequest, "validation"),
    (ExtractResponse, "serialization"),
    (ScopeRequest, "validation"),
    (ScopeResponse, "serialization"),
]


def _absent_not_null(node: Any, required: set[str] | None = None, key: str | None = None) -> Any:
    """Drop the null branch Pydantic gives Optional fields (the wire omits them) and per-property titles/defaults."""
    if isinstance(node, list):
        return [_absent_not_null(n) for n in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for k, v in node.items():
        if k == "properties":
            req = set(node.get("required", []))
            props = {}
            for name, prop in v.items():
                prop = {pk: pv for pk, pv in prop.items() if pk not in ("title", "default")}
                branches = prop.get("anyOf")
                if name not in req and isinstance(branches, list):
                    rest = [b for b in branches if b != {"type": "null"}]
                    if len(rest) == 1:
                        prop = {**{pk: pv for pk, pv in prop.items() if pk != "anyOf"}, **rest[0]}
                props[name] = _absent_not_null(prop)
            out[k] = props
        else:
            out[k] = _absent_not_null(v)
    return out


def json_schema() -> dict[str, Any]:
    _, doc = models_json_schema(EXPORTED, ref_template="#/$defs/{model}")
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "ner-sidecar.schema.json",
        "title": "Ask AI NER sidecar wire contract",
        "description": "Generated from server/ner-sidecar/contract.py by `python contract.py`. Do not edit by hand.",
        **_absent_not_null(doc),
    }


def schema_text() -> str:
    return json.dumps(json_schema(), indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    if "--check" in sys.argv:
        if SCHEMA_PATH.read_text(encoding="utf-8") != schema_text():
            sys.exit(f"{SCHEMA_PATH} is stale: run python contract.py")
        print("schema up to date")
    else:
        SCHEMA_PATH.parent.mkdir(exist_ok=True)
        SCHEMA_PATH.write_text(schema_text(), encoding="utf-8")
        print(f"wrote {SCHEMA_PATH}")
