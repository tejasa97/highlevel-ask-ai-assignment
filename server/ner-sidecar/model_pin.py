"""Model pinning: every model the sidecar loads is named by revision and checked by sha256 before it is used.

models.lock.json lists the GLiNER checkpoints and the sentence embedder with the sha256 of each file that matters.
Loading a directory whose files differ (a re-export, a partial download, the wrong checkpoint) fails with both
hashes in the message, so readiness never turns green on a model nobody pinned.

- GLiNER: NER_MODEL picks a manifest entry (default gliner_small_v21_base); NER_MODEL_PATH overrides where it lives
  (default $NER_POC_ROOT/<defaultPath>). A checkpoint that isn't in the manifest (a new fine-tune) loads only with
  NER_MODEL_SHA256 set to the sha256 of its weights file.
- Embedder: the pinned Hugging Face revision, from the local cache (or downloaded once); files checked the same way.
- NER_MODEL_VERIFY=0 skips the checks for local experiments: it logs a warning and /health reports verified=false.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("ner-sidecar")

MANIFEST_PATH = Path(__file__).with_name("models.lock.json")
WEIGHT_FILES = ("pytorch_model.bin", "model.safetensors")


class ModelPinError(RuntimeError):
    """A model's files don't match what models.lock.json pins."""


@dataclass
class PinnedModel:
    name: str
    path: Path
    revision: str | None
    verified: bool
    files: dict[str, str] = field(default_factory=dict)

    @property
    def label(self) -> str:
        """name@revision (short), the model version reported on every response."""
        return f"{self.name}@{self.revision[:12]}" if self.revision else self.name

    def describe(self) -> dict:
        return {"name": self.name, "revision": self.revision, "path": str(self.path), "verified": self.verified, "sha256": self.files}


def manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()


def verify_enabled() -> bool:
    return os.environ.get("NER_MODEL_VERIFY", "1").lower() not in ("0", "false", "no", "off")


def check_files(name: str, root: Path, expected: dict[str, str]) -> dict[str, str]:
    """sha256 every expected file under root; raise ModelPinError on a missing file or a mismatch."""
    bad = []
    for rel, want in expected.items():
        p = root / rel
        if not p.is_file():
            bad.append(f"{rel}: missing")
            continue
        got = sha256_file(p)
        if got != want:
            bad.append(f"{rel}: sha256 {got}, pinned {want}")
    if bad:
        raise ModelPinError(f"{name} at {root} does not match models.lock.json: " + "; ".join(bad))
    return dict(expected)


def resolve_gliner(poc_root: Path) -> PinnedModel:
    entries = manifest()["gliner"]
    name = os.environ.get("NER_MODEL", "gliner_small_v21_base")
    entry = entries.get(name)
    override = os.environ.get("NER_MODEL_PATH")
    if entry is None and not override:
        raise ModelPinError(f"NER_MODEL={name} is not in models.lock.json ({', '.join(entries)}); set NER_MODEL_PATH and NER_MODEL_SHA256 for an unlisted checkpoint")
    path = Path(override) if override else poc_root / entry["defaultPath"]
    if not path.exists():
        raise FileNotFoundError(f"GLiNER checkpoint not found at {path}. Set NER_MODEL_PATH (or NER_POC_ROOT).")
    revision = entry.get("revision") if entry else None
    if not verify_enabled():
        log.warning("NER_MODEL_VERIFY=0: loading %s from %s without checking its sha256", name, path)
        return PinnedModel(name, path, revision, verified=False)
    sha = os.environ.get("NER_MODEL_SHA256")
    if sha:
        weights = next((w for w in WEIGHT_FILES if (path / w).is_file()), None)
        if weights is None:
            raise ModelPinError(f"no weights file ({', '.join(WEIGHT_FILES)}) under {path}")
        files = check_files(name, path, {weights: sha.lower()})
        # A pinned sha256 names the artifact; the manifest revision only applies to the manifest's own files.
        revision = f"sha256:{sha.lower()}" if entry is None or entry["files"].get(weights) != sha.lower() else revision
    elif entry is None:
        raise ModelPinError(f"{path} is not a pinned checkpoint: set NER_MODEL_SHA256 to the sha256 of its weights")
    else:
        files = check_files(name, path, entry["files"])
    return PinnedModel(name, path, revision, verified=True, files=files)


def _hf_snapshot(repo: str, revision: str) -> Path:
    """The pinned revision from the local Hugging Face cache; download it only when it isn't there (and the hub is
    reachable). Cache first, so an air-gapped or HF_HUB_OFFLINE host with the files already present never calls out."""
    from huggingface_hub import snapshot_download
    from huggingface_hub.errors import LocalEntryNotFoundError

    try:
        return Path(snapshot_download(repo, revision=revision, local_files_only=True))
    except LocalEntryNotFoundError:
        log.info("embedder %s@%s not in the local cache; downloading", repo, revision[:12])
        return Path(snapshot_download(repo, revision=revision))


def resolve_embedder() -> PinnedModel:
    entry = manifest()["embedder"]
    repo, revision = entry["repo"], entry["revision"]
    override = os.environ.get("NER_EMBED_MODEL_PATH")
    if override:
        path = Path(override)
    else:
        path = _hf_snapshot(repo, revision)
    if not verify_enabled():
        log.warning("NER_MODEL_VERIFY=0: loading embedder %s without checking its sha256", path)
        return PinnedModel(repo, path, revision, verified=False)
    return PinnedModel(repo, path, revision, verified=True, files=check_files(repo, path, entry["files"]))
