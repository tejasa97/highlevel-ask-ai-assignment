"""HTTP surface without a model: liveness vs readiness, the bounded queue's fast 503, exclude-none responses, and
model pinning by sha256.

Run: cd server/ner-sidecar && NER_POC_ROOT=... python -m pytest tests
"""
from __future__ import annotations

import hashlib
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

import app as app_mod  # noqa: E402
import model_pin  # noqa: E402
import service as svc  # noqa: E402

# No `with`: the lifespan (warm load) never runs.
client = TestClient(app_mod.app)


@pytest.fixture
def svc_state(monkeypatch):
    s = app_mod.service
    monkeypatch.setattr(s, "ready", False)
    monkeypatch.setattr(s, "loaded", False)
    monkeypatch.setattr(s, "load_error", None)
    monkeypatch.setattr(app_mod, "LAZY", False)
    return s


def test_live_is_up_while_not_ready(svc_state):
    assert client.get("/health/live").status_code == 200
    r = client.get("/health/ready")
    assert r.status_code == 503 and r.json()["ok"] is False
    h = client.get("/health").json()
    assert h["live"] is True and h["ready"] is False and h["versions"]["code"].startswith(svc.__version__)


def test_extract_before_ready_is_503_not_a_hang(svc_state):
    svc_state.load_error = "warm-load failed: boom"
    r = client.post("/v1/extract", json={"requestId": "r", "utterance": "hi"})
    assert r.status_code == 503 and "boom" in r.json()["detail"]


def test_ready_after_load_and_reports_versions(svc_state, monkeypatch):
    monkeypatch.setattr(svc_state, "ready", True)
    monkeypatch.setattr(svc_state, "index_version", "seed:abc")
    r = client.get("/health/ready")
    assert r.status_code == 200 and r.json()["versions"]["index"] == "seed:abc"
    h = client.get("/health").json()
    assert set(h["versions"]) == {"code", "model", "index"} and "queue" in h


def test_response_omits_absent_fields(svc_state, monkeypatch):
    monkeypatch.setattr(svc_state, "ready", True)
    monkeypatch.setattr(svc_state, "extract", lambda rid, u, scope, v, embed: {"requestId": rid, "spans": [{"text": "Acme", "label": "company", "start": 0, "end": 4, "status": "miss"}], "versions": {"code": "c", "model": "m"}})
    r = client.post("/v1/extract", json={"requestId": "r1", "utterance": "Acme"})
    assert r.status_code == 200
    assert r.json() == {"requestId": "r1", "spans": [{"text": "Acme", "label": "company", "start": 0, "end": 4, "status": "miss"}], "versions": {"code": "c", "model": "m"}}


def test_overloaded_is_a_fast_503_with_retry_after(svc_state, monkeypatch):
    monkeypatch.setattr(svc_state, "ready", True)

    def busy(*_a, **_k):
        raise svc.Overloaded("queue full")

    monkeypatch.setattr(svc_state, "extract", busy)
    r = client.post("/v1/extract", json={"requestId": "r", "utterance": "hi"})
    assert r.status_code == 503 and r.headers["retry-after"] == "1" and r.json()["overloaded"] is True


def test_queue_bounds_waiters_and_their_wait(monkeypatch):
    monkeypatch.setattr(svc, "MAX_QUEUE", 1)
    s = svc.NerService()
    held, release = threading.Event(), threading.Event()

    def hold():
        with s._turn():
            held.set()
            release.wait(5)

    t = threading.Thread(target=hold)
    t.start()
    held.wait(5)
    # One may wait: it gives up after its wait budget instead of blocking forever.
    started = time.perf_counter()
    with pytest.raises(svc.Overloaded, match="waited"):
        with s._turn(wait_s=0.05):
            pass
    assert time.perf_counter() - started < 1
    # With the one queue place taken, the next is turned away at once.
    def wait_in_queue():
        with s._turn(wait_s=2):
            pass

    waiter = threading.Thread(target=wait_in_queue)
    waiter.start()
    time.sleep(0.05)
    started = time.perf_counter()
    with pytest.raises(svc.Overloaded, match="in flight or queued"):
        with s._turn(wait_s=2):
            pass
    assert time.perf_counter() - started < 0.1
    release.set()
    t.join()
    waiter.join()
    assert s.queue_stats()["rejected"] == 2 and s.queue_stats()["inFlightOrQueued"] == 0


def _checkpoint(tmp_path: Path, payload: bytes = b"weights") -> tuple[Path, str]:
    d = tmp_path / "ckpt"
    d.mkdir()
    (d / "pytorch_model.bin").write_bytes(payload)
    return d, hashlib.sha256(payload).hexdigest()


def test_model_pin_accepts_the_pinned_sha(tmp_path, monkeypatch):
    d, sha = _checkpoint(tmp_path)
    monkeypatch.setenv("NER_MODEL", "my_finetune")
    monkeypatch.setenv("NER_MODEL_PATH", str(d))
    monkeypatch.setenv("NER_MODEL_SHA256", sha)
    m = model_pin.resolve_gliner(tmp_path)
    assert m.verified and m.revision == f"sha256:{sha}" and m.label == f"my_finetune@sha256:{sha[:5]}"


def test_model_pin_refuses_a_mismatch_or_an_unpinned_checkpoint(tmp_path, monkeypatch):
    d, _ = _checkpoint(tmp_path)
    monkeypatch.setenv("NER_MODEL", "my_finetune")
    monkeypatch.setenv("NER_MODEL_PATH", str(d))
    monkeypatch.setenv("NER_MODEL_SHA256", "0" * 64)
    with pytest.raises(model_pin.ModelPinError, match="pinned 0000"):
        model_pin.resolve_gliner(tmp_path)
    monkeypatch.delenv("NER_MODEL_SHA256")
    with pytest.raises(model_pin.ModelPinError, match="NER_MODEL_SHA256"):
        model_pin.resolve_gliner(tmp_path)


def test_model_pin_checks_manifest_files(tmp_path, monkeypatch):
    # The default manifest entry, pointed at a directory with the wrong bytes.
    d, _ = _checkpoint(tmp_path)
    monkeypatch.delenv("NER_MODEL", raising=False)
    monkeypatch.delenv("NER_MODEL_SHA256", raising=False)
    monkeypatch.setenv("NER_MODEL_PATH", str(d))
    with pytest.raises(model_pin.ModelPinError) as e:
        model_pin.resolve_gliner(tmp_path)
    assert "gliner_config.json: missing" in str(e.value) and "pytorch_model.bin: sha256" in str(e.value)


def test_model_verify_off_loads_but_says_so(tmp_path, monkeypatch):
    d, _ = _checkpoint(tmp_path)
    monkeypatch.setenv("NER_MODEL_PATH", str(d))
    monkeypatch.setenv("NER_MODEL_VERIFY", "0")
    assert model_pin.resolve_gliner(tmp_path).verified is False


def test_lifespan_loads_in_the_background_so_liveness_answers_meanwhile(svc_state, monkeypatch):
    go = threading.Event()

    def slow_load():
        go.wait(5)
        svc_state.ready = True

    monkeypatch.setattr(svc_state, "load_once", slow_load)
    with TestClient(app_mod.app) as c:  # runs the lifespan
        assert c.get("/health/live").status_code == 200
        assert c.get("/health/ready").status_code == 503
        assert "still loading" in c.post("/v1/extract", json={"requestId": "r", "utterance": "hi"}).json()["detail"]
        go.set()
        for _ in range(100):
            if c.get("/health/ready").status_code == 200:
                break
            time.sleep(0.01)
        assert c.get("/health/ready").status_code == 200


def test_a_failed_background_load_shows_on_readiness(svc_state, monkeypatch):
    def broken():
        raise model_pin.ModelPinError("pytorch_model.bin: sha256 abc, pinned def")

    monkeypatch.setattr(svc_state, "load_once", broken)
    with TestClient(app_mod.app) as c:
        for _ in range(100):
            if svc_state.load_error:
                break
            time.sleep(0.01)
        r = c.get("/health/ready")
        assert r.status_code == 503 and "pinned def" in r.json()["error"]


def test_embed_false_reaches_the_service(svc_state, monkeypatch):
    monkeypatch.setattr(svc_state, "ready", True)
    seen = []
    monkeypatch.setattr(svc_state, "extract", lambda rid, u, scope, v, embed: seen.append(embed) or {"requestId": rid, "spans": []})
    client.post("/v1/extract", json={"requestId": "a", "utterance": "x"})
    client.post("/v1/extract", json={"requestId": "b", "utterance": "x", "embed": False})
    client.post("/v1/extract", json={"requestId": "c", "utterance": "x", "embed": True})
    assert seen == [True, False, True]


def test_model_label_is_the_pinned_checkpoint_whatever_NER_MODEL_NAME_says(svc_state, monkeypatch):
    monkeypatch.setenv("NER_MODEL_NAME", "something-else")
    monkeypatch.setattr(svc_state, "gliner", type("P", (), {"label": "gliner_small@sha256:abcde"})())
    assert svc_state.model_label == "gliner_small@sha256:abcde"
    assert svc_state.versions(None)["model"] == "gliner_small@sha256:abcde"


def test_seed_version_reads_metadata_not_content(tmp_path, monkeypatch):
    f = tmp_path / "people.jsonl"
    f.write_bytes(b"a" * 1000)
    v1 = svc.seed_version([f], "", "")
    real_open = Path.open
    monkeypatch.setattr(Path, "open", lambda *a, **k: (_ for _ in ()).throw(AssertionError("seed file was read")))
    assert svc.seed_version([f], "", "") == v1
    assert svc.seed_version([f], "100", "") != v1, "the row limits are part of the version"
    monkeypatch.setattr(Path, "open", real_open)
    f.write_bytes(b"b" * 1001)
    assert svc.seed_version([f], "", "") != v1, "a replaced file has another size"
