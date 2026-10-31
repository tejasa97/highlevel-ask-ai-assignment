# NER sidecar (GLiNER + PoC linker)

Python HTTP sidecar that finds names in an Ask utterance and links them to Store records. It is an **optional**
dependency: Ask behaves exactly the same when it is off, down, slow or returns garbage. A failure costs at most
`NER_TIMEOUT_MS` and means "no hints this turn"; only the user's own cancel ends a turn.

- Contract: [`contract.py`](contract.py) → [`contract/ner-sidecar.schema.json`](contract/ner-sidecar.schema.json), prose in
  [`docs/ner-sidecar-contract.md`](../../docs/ner-sidecar-contract.md)
- Node client: `server/src/retrieval/ner_client.ts` (modes, timeout, breaker, trace), `ner_ask_scope.ts` (Ask scope push)

**This process does not call live CRM/DB.** Linking uses the PoC in-memory exact
hash map + FAISS ANN (hard link cutoff **0.9**, soft suggest band default
**0.75**) + Levenshtein edit distance (default max **1**, env
`NER_EDIT_MAX_DISTANCE`) over the PoC seed (`$NER_POC_ROOT/data/`), or over a scope
the caller registered (`PUT /v1/scopes/{name}`; Ask registers its own records as `ask`).
Near-miss soft ANN / one-edit neighbors surface as `status: "ambiguous"` with
candidates ("did you mean?") — never auto-linked. Model weights stay outside this
repo; they are pinned by sha256 in `models.lock.json`.

## ID mapping (PoC → Store)

| PoC id | Wire `linkedId` / candidate `id` |
| --- | --- |
| `pe_<rest>` (people) | `ct_<rest>` |
| `co_<rest>` (companies) | `co_<rest>` (unchanged) |
| already `ct_` / `ld_` / `us_` / `tm_` | unchanged |

Examples: `pe_123` → `ct_123`, `pe_dupe_2_1` → `ct_dupe_2_1`, `co_1` → `co_1`.

Never return raw `pe_` as canonical `linkedId`. Ambiguous spans never auto-pick
the PoC top hit — `status: "ambiguous"` with `candidates[]` only (no `linkedId`).

## Linking pipeline (order)

1. **Exact** normalized name match → `linked` / `ambiguous`
2. **ANN cosine ≥ 0.9** (`NER_EMBED_THRESHOLD`) → `linked` / `ambiguous`
3. **Soft ANN ≥ 0.75** (`NER_SUGGEST_THRESHOLD`) → ambiguous suggestions (no auto-link)
4. **Levenshtein ≤ 1** (`NER_EDIT_MAX_DISTANCE`, default **1**) against in-memory
   name keys for that entity type → ambiguous suggestions; **union/dedupe** with
   soft ANN by Store/PoC id; rank by edit distance ascending, then score
5. Else **miss**

Soft ANN and edit hits feed the same clarify chips / `status: "ambiguous"` +
candidates + "Did you mean …?" copy. Never auto-pick `candidates[0]`. No new
reply/status type. Method on edit hits is `"edit"` (soft ANN remains `"embed"`).

## Linking pipeline (order)

1. **Exact** normalized name match → `linked` / `ambiguous`
2. **ANN cosine ≥ 0.9** (`NER_EMBED_THRESHOLD`) → `linked` / `ambiguous`
3. **Soft ANN ≥ 0.75** (`NER_SUGGEST_THRESHOLD`) → ambiguous suggestions (no auto-link)
4. **Levenshtein ≤ 1** (`NER_EDIT_MAX_DISTANCE`, default **1**) against in-memory
   name keys for that entity type → ambiguous suggestions; **union/dedupe** with
   soft ANN by Store/PoC id; rank by edit distance ascending, then score
5. Else **miss**

Soft ANN and edit hits feed the same clarify chips / `status: "ambiguous"` +
candidates + "Did you mean …?" copy. Never auto-pick `candidates[0]`. No new
reply/status type. Method on edit hits is `"edit"` (soft ANN remains `"embed"`).

## Modes (Node side)

| `NER_MODE` | Effect |
| --- | --- |
| `off` (default) | Never called. Title-Case `mentions()` only. |
| `shadow` | Called and traced (`ner` turn event, logs); nothing reaches retrieval or the planner. Use to watch latency and outcomes in production before turning it on. |
| `on` | Linked spans become planner hints. `NER_SIDECAR=1` / `ASK_NER=1` still mean `on`. |

Each call gets `min(NER_TIMEOUT_MS, the turn's deadline)` via `AbortSignal.any` with the turn's own signal. Every
outcome is classified: `ok`, `skipped` (breaker open / no time left), `unreachable`, `timeout`, `http` (with status,
e.g. 503 overloaded, 409 scope unavailable), `invalid` (non-JSON, schema violation, requestId mismatch), `cancelled`
(the user's cancel: the turn ends). Everything but `cancelled` means "no hints". An in-process circuit breaker per
sidecar URL opens after `NER_BREAKER_FAILURES` consecutive failures, skips calls for `NER_BREAKER_COOLDOWN_MS`, then
lets one probe through; each state change is logged (`evt: "ner.breaker"`). Cancels don't count as failures.

Every turn that calls NER emits a `ner` trace event and (per `NER_LOG`) one JSON log line on stderr:
`{evt: "ner", requestId, mode, outcome, latencyMs, timeoutMs, breaker, status?, error?, spans?, versions: {code, model, index}}`.
The same `requestId` is sent as `x-request-id` and in the body, and appears in the sidecar's log lines.

## Endpoints

| Endpoint | Meaning |
| --- | --- |
| `GET /health/live` | The process answers (liveness: restart on failure). Up within a second of start, while the model loads. |
| `GET /health/ready` | 200 only once both models are pinned and loaded, the index is built and one warmup extract has run (readiness: route traffic on this). 503 with `error` while loading or after a failed load. |
| `GET /health` | Both, plus `versions`, `queue` (in flight/queued, rejected), load stats, registered scopes. |
| `POST /v1/extract` (also `/extract`) | Extract + link. 503 + `Retry-After: 1` when overloaded or not ready; 409 for an unknown scope/version (fail closed: never the default index). |
| `PUT /v1/scopes/{name}`, `GET /v1/scopes/{name}` | Register / list a scope's versions (`NER_SCOPE_VERSIONS` kept per scope). |

**Admission control.** Inference and scope builds take turns (torch + faiss in one process are not safe to run
concurrently on macOS). One runs; up to `NER_MAX_QUEUE` wait, each at most `NER_QUEUE_TIMEOUT_MS`. Beyond that the
request gets an immediate 503, which the client treats as "no hints", instead of queuing behind a slow model.

## Layout

| Path | Role |
| --- | --- |
| `app.py` | FastAPI: health, extract, scopes; background warm load |
| `service.py` | Warm-load GLiNER + `EntityIndex`; extract + link → contract JSON; admission queue; scopes |
| `contract.py`, `contract/` | Pydantic wire models, exported JSON Schema, shared fixtures (Python and Node tests both run them) |
| `model_pin.py`, `models.lock.json` | Model revision + sha256 pins, checked at load |
| `ids.py` | Deterministic PoC → Store id mapper |
| `requirements.in`, `requirements.lock` | Direct pins; full lock with hashes (linux x86_64, Python 3.11, CPU torch) |
| `Dockerfile` | Production image |
| PoC `scripts/entity_index.py` | Exact map + FAISS ANN (imported via `NER_POC_SCRIPTS`) |

## Env

Sidecar:

| Variable | Default |
| --- | --- |
| `NER_POC_ROOT` | `../../../ask-ai-ner-poc` relative to the repo checkout (sibling of the repo) |
| `NER_POC_SCRIPTS` | `$NER_POC_ROOT/scripts` |
| `NER_MODEL` | `gliner_small_v21_base` (an entry in `models.lock.json`) |
| `NER_MODEL_PATH` | `$NER_POC_ROOT/<defaultPath of NER_MODEL>` |
| `NER_MODEL_SHA256` | required for a checkpoint not in `models.lock.json` (sha256 of its weights file) |
| `NER_MODEL_VERIFY` | `1`; `0` skips the sha256 checks (local experiments; `/health` shows `verified: false`) |
| `NER_EMBED_MODEL_PATH` | unset = the pinned revision from the Hugging Face cache (cache first, download only if missing) |
| `NER_MODEL_NAME` | overrides the reported model label |
| `NER_CODE_VERSION` | git sha (the image build sets it); else `git rev-parse` of the checkout |
| `NER_PEOPLE_PATH` / `NER_COMPANIES_PATH` | `$NER_POC_ROOT/data/{people,companies}.jsonl` |
| `NER_ANN_DIR` | `$NER_POC_ROOT/data/ann` (`NER_REBUILD_ANN=1` rebuilds) |
| `NER_PEOPLE_LIMIT` / `NER_COMPANIES_LIMIT` | optional caps for smoke tests |
| `NER_EMBED_THRESHOLD` / `NER_SUGGEST_THRESHOLD` / `NER_EDIT_MAX_DISTANCE` | `0.9` / `0.75` / `1` |
| `NER_GLINER_THRESHOLD` | `0.4` |
| `NER_MAX_CANDIDATES` | `20` (0 = no cap) |
| `NER_MAX_QUEUE` / `NER_QUEUE_TIMEOUT_MS` | `4` / `500` |
| `NER_SCOPE_VERSIONS` | `16` |
| `NER_LAZY_LOAD` | unset = warm-load at start (in the background); `1` = on the first request |
| `NER_LOG_LEVEL` | `INFO` |
| `PORT` | `8091` |

Node (`server/`):

| Variable | Default |
| --- | --- |
| `NER_MODE` | `off` (`NER_SIDECAR=1` / `ASK_NER=1` = `on`) |
| `NER_SIDECAR_URL` | `http://127.0.0.1:8091` |
| `NER_TIMEOUT_MS` | `1500` (capped by the turn deadline) |
| `NER_BREAKER_FAILURES` / `NER_BREAKER_COOLDOWN_MS` | `3` / `30000` |
| `NER_LOG` | `errors` (`all` logs successes too; `off`) |

## Setup and run (local)

```bash
cd server/ner-sidecar
python3.11 -m venv .venv && . .venv/bin/activate
pip install --require-hashes -r requirements.lock   # linux; on macOS: pip install -r requirements.in
export NER_POC_ROOT=/path/to/ask-ai-ner-poc         # seed, ANN cache, GLiNER checkpoint, scripts/
uvicorn app:app --host 127.0.0.1 --port 8091 --workers 1
```

PoC seed + ANN must already exist (see ask-ai-ner-poc README): `people.jsonl`, `companies.jsonl`,
`data/ann/{person,company}.faiss`. A checkpoint whose files don't match `models.lock.json` refuses to load and
`/health/ready` says which file and both hashes. To regenerate the lock, see the header of `requirements.in`.

Tests (no model needed; the stub GLiNER + real `EntityIndex`):

```bash
NER_POC_ROOT=/path/to/ask-ai-ner-poc python -m pytest tests
python contract.py --check   # the committed JSON Schema matches contract.py
```

## Docker

See the header of the [`Dockerfile`](Dockerfile) for build and run. Code and the hash-locked dependencies are baked
in; weights and seed data are mounted read-only, the image runs offline (`HF_HUB_OFFLINE=1`) as a non-root user,
and its `HEALTHCHECK` is liveness only. Gate traffic on `/health/ready`. Run exactly **one worker** per container:
scopes and the admission queue are in-process state. Scale by containers, each pushed its scope by the Node server
(scope pushes are versioned and idempotent).

**Deploy order:** the Node client rejects responses that break the contract (e.g. `null` for an absent field, as
sidecars before this version sent). Upgrade the sidecar with or before the Node server; in the other order the only
effect is outcome `invalid` and no hints.

## Measurements

Measured once on 2026-11-01. Hardware: Apple M1 Pro (10 cores), 16 GB, macOS 15.7.9, Python 3.11.16, CPU torch
2.14.1, one uvicorn worker. Model `gliner_small_v21_base@4e091416cf7c` (pinned, verified), embedder
all-MiniLM-L6-v2. Default index capped at `NER_PEOPLE_LIMIT=5000`, `NER_COMPANIES_LIMIT=500` (1800 + 500 ANN keys,
loaded from cache). Sequential requests from one client on localhost; latencies include HTTP.

| What | Result |
| --- | --- |
| Cold start → `/health/live` | 0.53 s |
| Cold start → `/health/ready` | 9.75 s (model pinning 0.6 s, embedder + ANN load ~3 s, GLiNER load 3.7 s, warmup extract 0.87 s) |
| RSS at ready | 910 MB (491 MB after the run below; macOS reclaims load-time pages) |
| Extract, default index (n=200) | p50 61.8 ms, p95 81.3 ms, max 339 ms |
| Extract, `ask` scope, 93 entities (n=200) | p50 53.7 ms, p95 68.8 ms, max 92 ms |
| Scope push, new version, 93 entities (n=20) | p50 15.2 ms, p95 69.7 ms (the first push loads the embedding path) |
| Scope push, unchanged version (n=50) | p50 0.8 ms, p95 1.1 ms |
| Scope push, new version, 1000 entities (n=5) | p50 95 ms, p95 113 ms |

Not measured:

- The full ~2M-person default index (cold start, RSS, ANN build): only the capped index above.
- Linux / the Docker image: the Docker daemon wasn't available, so the image was not built and the lock was not
  installed from; timings on a Linux x86 host will differ.
- The fine-tuned head (`gliner_small_v21_ft_head`): not pinned in `models.lock.json` yet; the base model is the
  default.
- Concurrency: latency under parallel load and the 503 rate at a given QPS (the queue's behaviour is covered by
  tests, not benchmarked).
- Node-side overhead end to end (the `ner` trace event's `latencyMs` reports it per turn).

## Example curl

```bash
# Ambiguous person (many Sarah Johnson rows in PoC seed)
curl -s http://127.0.0.1:8091/v1/extract \
  -H 'content-type: application/json' \
  -d '{"requestId":"req_sarah","utterance":"What is Sarah Johnson'\''s status?","tier":"fast"}' | jq .

# Unique-ish company + miss person
curl -s http://127.0.0.1:8091/v1/extract \
  -H 'content-type: application/json' \
  -d '{"requestId":"req_miss","utterance":"Email Zed Nowhere at Clear Finance"}' | jq .

# Rule span (email)
curl -s http://127.0.0.1:8091/v1/extract \
  -H 'content-type: application/json' \
  -d '{"requestId":"req_email","utterance":"ping ana.ruiz@brightside.example"}' | jq .

# Near-miss typo → ambiguous suggestions (did you mean Clear Finance?)
curl -s http://127.0.0.1:8091/v1/extract \
  -H 'content-type: application/json' \
  -d '{"requestId":"req_klar","utterance":"Email someone at Klar Finance"}' | jq .

# One-edit typo (Clear Finace → Clear Finance, Levenshtein distance 1)
curl -s http://127.0.0.1:8091/v1/extract \
  -H 'content-type: application/json' \
  -d '{"requestId":"req_finace","utterance":"What is Clear Finace status?"}' | jq .
```

### Clarify-shaped mapping (for a future TS facade)

Ambiguous span → planner clarify (do **not** take `candidates[0]`):

```json
{
  "status": "clarify",
  "text": "Which one did you mean?",
  "options": ["Sarah Johnson (Acme…)", "Sarah Johnson (…)"]
}
```

Option strings follow `c.detail ? \`${c.name} (${c.detail})\` : c.name`.

## Contract reminder

- Request: `{ requestId, utterance, actorId?, tier?, scope?, scopeVersion? }`
- Response: `{ requestId, spans, model?, latencyMs?, scope?, versions? }`; optional fields are absent, never `null`
- Span `status`: `linked` | `ambiguous` | `miss`
- `linkedId` only when `status === "linked"` and always Store-prefixed
- Offsets are UTF-16 code units into `utterance` (BMP text matches Python indices)
