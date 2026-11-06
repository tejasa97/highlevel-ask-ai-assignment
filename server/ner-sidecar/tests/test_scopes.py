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
    s.loaded = s.ready = True
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


def test_two_versions_of_a_scope_coexist():
    S.register_scope("ask", "v2", ASK[:1])
    (sp,) = spans("Email Sarah Johnson", "ask", "v2")
    assert sp["status"] == "linked" and sp["linkedId"] == "ct_31"
    (sp,) = spans("Email Sarah Johnson", "ask", "v1")
    assert ids(sp) == {"ct_31", "ct_32"}


if __name__ == "__main__":
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn(); print("ok  ", name)
            except Exception as e:  # noqa: BLE001
                fails += 1; print("FAIL", name, repr(e))
    sys.exit(1 if fails else 0)


def test_embed_off_links_by_exact_and_edit_only():
    # "Globx" is one edit from Globex: still a suggestion without the ANN, and the ANN is never consulted.
    s = make_service()
    idx = s.scopes["ask"]["v1"]
    calls = []
    real = idx.embed_texts
    idx.embed_texts = lambda *a, **k: calls.append(a) or real(*a, **k)
    (sp,) = s.extract("t", "Email Globx", "ask", "v1", embed=False)["spans"]
    assert ids(sp) == {"co_8"} and sp["status"] == "ambiguous" and calls == []
    s.extract("t", "Email Globx", "ask", "v1")
    assert calls, "embed on uses the ANN"
    assert idx._faiss, "the registered index keeps its ANN"


def test_scope_build_lets_extracts_in_between_chunks(monkeypatch):
    import threading
    import time as _t

    monkeypatch.setattr(svc, "SCOPE_EMBED_CHUNK", 1)
    s = make_service()
    idx_cls_embed = EntityIndex.embed_texts
    in_build = threading.Event()

    def slow_embed(self, texts, batch_size=256):
        if len(texts) == 1 and texts[0] in {"person 0", "person 1", "person 2", "person 3"}:
            in_build.set()
            _t.sleep(0.05)
        return idx_cls_embed(self, texts, batch_size=batch_size)

    monkeypatch.setattr(EntityIndex, "embed_texts", slow_embed)
    many = [{"id": f"ct_{900 + i}", "name": f"Person {i}", "entity": "contact"} for i in range(4)]
    t = threading.Thread(target=s.register_scope, args=("ask", "v2", ASK + many))
    t.start()
    in_build.wait(5)
    started = _t.perf_counter()
    s.extract("t", "Email Sarah Johnson", "ask", "v1")  # the old version still answers while v2 builds
    waited = _t.perf_counter() - started
    t.join()
    assert in_build.is_set()
    assert waited < 0.15, f"extract waited {waited:.2f}s behind the build"
    assert list(s.scopes["ask"]) == ["v1", "v2"]


def test_a_second_put_for_the_same_version_joins_the_build(monkeypatch):
    import threading

    s = make_service()
    builds = []
    gate = threading.Event()
    real = svc.NerService._build_scope

    def counted(self, name, version, entities):
        builds.append(version)
        gate.wait(5)
        return real(self, name, version, entities)

    monkeypatch.setattr(svc.NerService, "_build_scope", counted)
    out = []
    ts = [threading.Thread(target=lambda: out.append(s.register_scope("ask", "v3", ASK))) for _ in range(2)]
    for t in ts:
        t.start()
    import time as _t
    _t.sleep(0.05)
    gate.set()
    for t in ts:
        t.join()
    assert builds == ["v3"] and len(out) == 2 and out[0] == out[1]
    assert s.register_scope("ask", "v3", ASK)["unchanged"] is True
