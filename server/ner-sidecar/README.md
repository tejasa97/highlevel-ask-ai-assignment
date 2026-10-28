# NER sidecar (GLiNER + PoC linker)

Python HTTP sidecar that implements the frozen Ask AI contract:

- Types: `server/src/retrieval/ner_sidecar_contract.ts`
- Docs: `docs/ner-sidecar-contract.md`

**This process does not call live CRM/DB.** Linking uses the PoC in-memory exact
hash map + FAISS ANN (hard link cutoff **0.9**, soft suggest band default
**0.75**) + Levenshtein edit distance (default max **1**, env
`NER_EDIT_MAX_DISTANCE`) over the PoC seed at `/workspace/ask-ai-ner-poc/data/`.
Near-miss soft ANN / one-edit neighbors surface as `status: "ambiguous"` with
candidates ("did you mean?") — never auto-linked. Model weights stay in the PoC
tree (path / symlink); they are **not** copied into this repo.

Phase note: the TypeScript ask path is wired behind **`NER_SIDECAR=1`** (or
`ASK_NER=1`) via `server/src/retrieval/ner_client.ts` → `planTurn`. Ambiguous
spans return a clarify reply **before** the planner LLM. Default (flag off)
keeps Title-Case `mentions()` only.

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

## Layout

| Path | Role |
| --- | --- |
| `app.py` | FastAPI: `GET /health`, `POST /v1/extract` (+ `/extract`) |
| `service.py` | Warm-load GLiNER + `EntityIndex`; extract + link → contract JSON |
| `ids.py` | Deterministic PoC → Store id mapper |
| PoC `scripts/entity_index.py` | Exact map + FAISS ANN (imported via `PYTHONPATH`) |

## Env defaults

| Variable | Default |
| --- | --- |
| `NER_POC_ROOT` | `/workspace/ask-ai-ner-poc` |
| `NER_POC_SCRIPTS` | `$NER_POC_ROOT/scripts` (on `PYTHONPATH`) |
| `NER_MODEL_PATH` | `$NER_POC_ROOT/models/gliner_small_v21_ft_head/final` |
| `NER_PEOPLE_PATH` | `$NER_POC_ROOT/data/people.jsonl` |
| `NER_COMPANIES_PATH` | `$NER_POC_ROOT/data/companies.jsonl` |
| `NER_ANN_DIR` | `$NER_POC_ROOT/data/ann` |
| `NER_EMBED_THRESHOLD` | `0.9` (hard link / ambiguous-at-threshold) |
| `NER_SUGGEST_THRESHOLD` | `0.75` (near-miss → ambiguous suggestions) |
| `NER_EDIT_MAX_DISTANCE` | `1` (Levenshtein ≤ N → ambiguous suggestions) |
| `NER_GLINER_THRESHOLD` | `0.4` |
| `NER_LAZY_LOAD` | unset = warm-load on startup; `1` = load on first request |
| `NER_PEOPLE_LIMIT` / `NER_COMPANIES_LIMIT` | optional caps for smoke tests |
| `NER_MAX_CANDIDATES` | `20` (0 = no cap; exact-dupe buckets can be huge) |
| `PORT` | `8091` |

Optional local symlink (does not copy ~600MB weights):

```bash
ln -s /workspace/ask-ai-ner-poc/models/gliner_small_v21_ft_head/final \
  server/ner-sidecar/model
# then: export NER_MODEL_PATH="$(pwd)/server/ner-sidecar/model"
```

## Setup

**Recommended — reuse the PoC venv** (already has torch / gliner / faiss):

```bash
cd /workspace/ask-ai-repo/server/ner-sidecar
source /workspace/ask-ai-ner-poc/.venv/bin/activate
pip install fastapi 'uvicorn[standard]' pydantic   # if missing
export PYTHONPATH=/workspace/ask-ai-ner-poc/scripts
```

**Fresh venv** (large download):

```bash
cd /workspace/ask-ai-repo/server/ner-sidecar
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export PYTHONPATH=/workspace/ask-ai-ner-poc/scripts
```

PoC seed + ANN must already exist (see ask-ai-ner-poc README): `people.jsonl`,
`companies.jsonl`, and `data/ann/{person,company}.faiss`.

## Run

```bash
cd /workspace/ask-ai-repo/server/ner-sidecar
source /workspace/ask-ai-ner-poc/.venv/bin/activate   # or .venv
export PYTHONPATH=/workspace/ask-ai-ner-poc/scripts
export PORT=8091
uvicorn app:app --host 127.0.0.1 --port "$PORT"
```

Warm-load logs index + model readiness. First startup over 2M people can take
tens of seconds to a few minutes depending on disk.

Health:

```bash
curl -s http://127.0.0.1:8091/health | jq .
```

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

- Request: `{ requestId, utterance, actorId?, tier? }`
- Span `status`: `linked` | `ambiguous` | `miss`
- `linkedId` only when `status === "linked"` and always Store-prefixed
- Offsets are UTF-16 code units into `utterance` (BMP text matches Python indices)
