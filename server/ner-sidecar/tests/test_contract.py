"""Contract tests: the committed JSON Schema is what contract.py exports, the shared fixtures (also run by the Node
client's tests) validate exactly as labelled, and what the service really emits fits the contract.

Run: cd server/ner-sidecar && NER_POC_ROOT=... python -m pytest tests
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pydantic import ValidationError  # noqa: E402

import contract  # noqa: E402

FIXTURES = json.loads(contract.FIXTURES_PATH.read_text(encoding="utf-8"))


def _valid(model, body) -> bool:
    try:
        model.model_validate(body)
        return True
    except ValidationError:
        return False


def test_committed_schema_is_the_exported_one():
    assert contract.SCHEMA_PATH.read_text(encoding="utf-8") == contract.schema_text(), "run: python contract.py"


def test_schema_says_optional_fields_are_absent_not_null():
    text = contract.schema_text()
    assert '"null"' not in text
    span = contract.json_schema()["$defs"]["LinkedSpan"]
    assert span["x-invariants"] == contract.INVARIANTS


def test_fixtures_cover_every_kind():
    kinds = {f["kind"] for f in FIXTURES["extractResponse"]}
    assert kinds == {"good", "ambiguous", "empty", "malformed"}


def test_extract_response_fixtures():
    wrong = [f["name"] for f in FIXTURES["extractResponse"] if _valid(contract.ExtractResponse, f["body"]) != f["valid"]]
    assert not wrong, wrong


def test_extract_request_fixtures():
    wrong = [f["name"] for f in FIXTURES["extractRequest"] if _valid(contract.ExtractRequest, f["body"]) != f["valid"]]
    assert not wrong, wrong


def test_service_output_fits_the_contract():
    from tests.test_scopes import S  # stub GLiNER, real EntityIndex

    for text, scope, version in (
        ("Email Sarah Johnson about the renewal", "ask", "v1"),
        ("Deals at Globx", "ask", "v1"),
        ("What deals are open at Clear Finance?", None, None),
        ("ping ana@acme.example or ct_31", None, None),
        ("nothing to see here", None, None),
    ):
        raw = S.extract("req_x", text, scope, version)
        out = contract.ExtractResponse.model_validate(raw)
        assert out.versions and out.versions.code and out.versions.model
        assert None not in json.loads(out.model_dump_json(exclude_none=True)).values()
        if scope:
            assert out.versions.index == f"{scope}:{version}"
