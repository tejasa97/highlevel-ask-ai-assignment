"""Scoped indexes: a caller-registered scope (the Ask app's "ask") links only against its own records; a request
without a scope keeps the default (fine-tuning seed) index; an unknown or stale scope fails closed.

GLiNER is stubbed (spans come from a fixed list); linking uses the real EntityIndex: exact -> ANN -> soft -> edit<=1.
Run: cd server/ner-sidecar && NER_POC_ROOT=... python -m pytest tests  (or python tests/test_scopes.py)
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import service as svc  # noqa: E402

svc._ensure_poc_scripts_on_path()
from entity_index import Entity, EntityIndex  # type: ignore  # noqa: E402

# The Ask app's own records, as askEntities() sends them (store/seed.ts: two Sarah Johnson contacts).
ASK = [
    {"id": "ct_31", "name": "Sarah Johnson", "entity": "contact", "detail": "Brightside"},
    {"id": "ct_32", "name": "Sarah Johnson", "entity": "contact", "detail": "sjohnson@gmail.example"},
    {"id": "ct_3", "name": "Ana Ruiz", "entity": "contact", "detail": "Acme"},
    {"id": "co_7", "name": "Acme", "entity": "company"},
    {"id": "co_8", "name": "Globex", "entity": "company"},
]
BIG_IDS = {"ct_2984", "ct_4803", "ct_dupe_2_1", "ct_dupe_2_2", "co_1"}


class StubModel:
    def predict_entities(self, text, labels, threshold=0.4):
        out = []
        for name, label in (("Sarah Johnson", "person"), ("Clear Finance", "company"), ("Clear Finace", "company"), ("Globex", "company"), ("Globx", "company")):
            i = text.find(name)
            if i >= 0 and not any(o["start"] <= i < o["end"] for o in out):
                out.append({"text": name, "label": label, "start": i, "end": i + len(name), "score": 0.9})
        return out


def big_index() -> EntityIndex:
    """A slice shaped like the fine-tuning seed: the ids that leaked into Ask before."""
    idx = EntityIndex()
    for id_, role, co in (("pe_2984", "lead", "North Collective 27664"), ("pe_4803", "lead", "Iron Collective 48429"), ("pe_dupe_2_1", "contact", "Golden Network 115049"), ("pe_dupe_2_2", "contact", "Vertex Logistics 151553")):
        idx.add(Entity(id=id_, name="Sarah Johnson", entity_type="person", role=role, company=co))
    idx.add(Entity(id="co_1", name="Clear Finance", entity_type="company"))
    idx.add(Entity(id="co_2", name="Northwind Labs", entity_type="company"))
    idx.build_ann()
    return idx


def make_service() -> svc.NerService:
    s = svc.NerService()
    s.model = StubModel()
    s.index = big_index()
    s.ready = True
    s.register_scope("ask", "v1", ASK)
    return s


S = make_service()


def ids(span) -> set[str]:
    return {c["id"] for c in span.get("candidates") or []} | ({span["linkedId"]} if span.get("linkedId") else set())


def spans(text, scope=None, version=None):
    return S.extract("t", text, scope, version)["spans"]


def test_ask_sarah_is_only_asks_two_contacts():
    (sp,) = spans("Email Sarah Johnson about the renewal", "ask", "v1")
    assert sp["status"] == "ambiguous" and sp["method"] == "exact"
    assert ids(sp) == {"ct_31", "ct_32"}
    assert {c["entity"] for c in sp["candidates"]} == {"contact"}


def test_ask_clear_finance_has_no_link_and_no_big_ids():
    for text in ("What deals are open at Clear Finance?", "Email someone at Clear Finace about billing"):
        for sp in spans(text, "ask", "v1"):
            assert not sp.get("linkedId"), sp
            assert not (ids(sp) & BIG_IDS), sp


def test_ask_never_returns_big_index_ids():
    for text in ("Email Sarah Johnson about the renewal", "What deals are open at Clear Finance?", "How many leads are named Sarah Johnson?"):
        for sp in spans(text, "ask", "v1"):
            assert not (ids(sp) & BIG_IDS), sp


def test_ask_scope_keeps_exact_and_edit_linking():
    (sp,) = spans("Deals at Globex", "ask", "v1")
    assert sp["status"] == "linked" and sp["linkedId"] == "co_8" and sp["method"] == "exact"
    (sp,) = spans("Deals at Globx", "ask", "v1")
    assert ids(sp) == {"co_8"} and sp["status"] in ("ambiguous", "linked")


def test_default_caller_still_gets_the_big_index():
    (sp,) = spans("Email Sarah Johnson about the renewal")
    assert ids(sp) == {"ct_2984", "ct_4803", "ct_dupe_2_1", "ct_dupe_2_2"}
    (sp,) = spans("What deals are open at Clear Finance?")
    assert sp["linkedId"] == "co_1"


def test_unknown_or_stale_scope_fails_closed():
    for scope, version in (("nope", None), ("ask", "v0")):
        try:
            spans("Email Sarah Johnson", scope, version)
        except svc.ScopeUnavailable:
            continue
        raise AssertionError(f"{scope}/{version} should fail closed")


if __name__ == "__main__":
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn(); print("ok  ", name)
            except Exception as e:  # noqa: BLE001
                fails += 1; print("FAIL", name, repr(e))
    sys.exit(1 if fails else 0)
