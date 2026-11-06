# NER sidecar request/response contract (phase 0/1)

**Status:** Contract frozen and machine-checked. The Python sidecar and the TypeScript facade (`ner_client.ts`) are wired behind `NER_MODE=on|shadow` (`NER_SIDECAR=1` still means on). NER is optional: with it off, unreachable or slow, Ask behaves exactly as without it.

**Grounding:** [`ask-ai-ner-poc/docs/integration-ask-ai-repo.md`](../../ask-ai-ner-poc/docs/integration-ask-ai-repo.md) (PoC analysis); TypeScript types in [`server/src/retrieval/ner_sidecar_contract.ts`](../server/src/retrieval/ner_sidecar_contract.ts).

## Standing rules

1. **No live CRM/DB inside the sidecar** to resolve entities. Linking uses an in-memory / prebuilt index only (exact map ± ANN). The assignment Store is already local; remote HighLevel APIs must not appear on this path.
2. **Ambiguous → clarify.** Never auto-resolve a PoC top `linked` hit into writes when the span status is `ambiguous`. PoC `LinkResult` may still set `linked` to the top neighbor; consumers of this contract must ignore that for write binding and force clarify.
3. **Canonical ids are Store ids:** `ct_` (contact), `ld_` (lead), `us_` (user), `co_` (company), `tm_` (team). PoC corpus ids (`pe_…`) must **not** leak as canonical `linkedId` / candidate `id` on this wire.
4. This phase freezes the facade ↔ sidecar JSON shape and the clarify mapping. Later phases add the sidecar process and a feature-flagged mention merge.
5. **Links are hints, never bindings.** Even a `linked` span (exact or embedding) only adds a candidate; the identity resolver checks it against the store and scope and decides, and a write binds only on a unique strong key. See [ADR 0001](adr/0001-ner-suggests-resolver-decides.md).

## Wire rules (machine-checked)

The schema is defined once, as Pydantic models in [`server/ner-sidecar/contract.py`](../server/ner-sidecar/contract.py), and exported to [`server/ner-sidecar/contract/ner-sidecar.schema.json`](../server/ner-sidecar/contract/ner-sidecar.schema.json) (`python contract.py`; `--check` fails on drift). The Node client validates every response against the same schema with zod (`ner_sidecar_contract.ts`); a test compares the zod schemas with the exported JSON Schema. Both sides run the shared fixtures in `contract/fixtures.json` (good, ambiguous, empty, malformed).

- Optional fields are **absent, never `null`**. No type coercion either: `"3"` is not an offset.
- `status: "linked"` ⇔ `linkedId` is present; `start <= end`; every `linkedId` and candidate `id` has a Store prefix (`ct_ ld_ us_ co_ tm_`).
- `requestId` in the response must echo the request's.
- A response that breaks any of these is rejected as `invalid`, and the turn gets no hints. Deploy order follows from that: upgrade the sidecar with or before the Node server, since a pre-contract sidecar (which sent `null`s) is treated as invalid.
- One exception, so a sidecar can add a label first: the client drops a span whose `label` it doesn't know (logged as `evt: "ner.unknown_label"`) and validates the rest. The wire schema still lists the known labels; the fixture `malformed: unknown label` is marked `"client": "drops the span"`.
- `invalid` doesn't trip the client's circuit breaker: the sidecar answered, and quickly, so skipping it would only hide the version skew; each invalid answer is logged instead. Only outages count (unreachable, timeout, an HTTP error without `Retry-After`); a 503 with `Retry-After` pauses calls for that long.

## Parties

| Side | Role |
| --- | --- |
| TypeScript facade (`server/src/retrieval/ner_client.ts`) | Calls the sidecar; maps spans into mentions / clarify when `NER_SIDECAR=1` |
| Python GLiNER sidecar (`server/ner-sidecar/`) | Extract spans + link against PoC index; maps `pe_`→`ct_` on the wire |

## Request

Minimal body. Optional fields mirror `POST /api/ask` (`message`, `tier?`, `actorId?`) so the facade can forward context without inventing new ask-path fields.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | Correlation / logging |
| `utterance` | string | yes | Raw user text (same string mentions would see) |
| `actorId` | string | no | Ask actor |
| `tier` | `"fast"` \| `"strong"` | no | Planner tier |
| `scope` | string | no | Link only against this registered scope (`PUT /v1/scopes/{name}`); unknown scope or version → 409, never the default index |
| `scopeVersion` | string | no | Version of `scope` to link against |
| `embed` | boolean | no | `false`: link by exact name and edit distance only, no embedding (ANN) matches. Unset = on. The Node server sends `false` when `NER_EMBED=off` |

### Example request

```json
{
  "requestId": "req_01JABC",
  "utterance": "What is Sarah Johnson's status?",
  "actorId": "us_1",
  "tier": "fast"
}
```

## Response

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | Echo of the request |
| `spans` | `NerLinkedSpan[]` | yes | May be empty |
| `model` | string | no | Sidecar / checkpoint id |
| `latencyMs` | number | no | Optional timing |
| `scope` | string | no | Echo of the scope linked against |
| `versions` | `{ code, model, index? }` | no | Sidecar code version, pinned model (`name@revision`), index version (`seed:<hash>` of the seed files' path, size, mtime and row limits, or `<scope>:<version>`) |

### Span fields (`NerLinkedSpan`)

| Field | Type | Notes |
| --- | --- | --- |
| `text` | string | Surface form |
| `label` | string | `person` \| `company` \| `email` \| `phone` \| `id` \| `team` \| `product`, or CRM-mapped `contact` \| `lead` \| `user` |
| `start` / `end` | number | Half-open UTF-16 offsets into `utterance` (`slice(start, end) === text`) |
| `status` | `"linked"` \| `"ambiguous"` \| `"miss"` | Outcome; never invent a fourth write-commit state |
| `linkedId` | string | **Only** when `status === "linked"`; Store id (`ct_` / `ld_` / `us_` / …) |
| `linkedEntity` | string | Optional CRM entity for the unique link |
| `candidates` | array | When `ambiguous`: `{ id, name, score?, entity?, detail? }[]` |
| `method` | `"exact"` \| `"embed"` \| `"edit"` \| `"rule"` | Optional |
| `score` | number | Optional best score; **must not** auto-commit ambiguous hits |

### Example — unique link

```json
{
  "requestId": "req_01JABC",
  "spans": [
    {
      "text": "Marcus Lee",
      "label": "person",
      "start": 8,
      "end": 18,
      "status": "linked",
      "linkedId": "ct_12",
      "linkedEntity": "contact",
      "method": "exact",
      "score": 1.0
    }
  ],
  "model": "gliner_small_v21_ft_head",
  "latencyMs": 42
}
```

### Example — ambiguous (must clarify; do not take top hit)

```json
{
  "requestId": "req_01JDEF",
  "spans": [
    {
      "text": "Sarah Johnson",
      "label": "person",
      "start": 11,
      "end": 24,
      "status": "ambiguous",
      "candidates": [
        { "id": "ct_31", "name": "Sarah Johnson", "score": 0.97, "entity": "contact", "detail": "Acme" },
        { "id": "ct_32", "name": "Sarah Johnson", "score": 0.95, "entity": "contact", "detail": "Brightside" }
      ],
      "method": "exact",
      "score": 0.97
    }
  ]
}
```

Consumers **must not** treat a missing `linkedId` plus a non-empty `candidates` list as “use `candidates[0]`”. Even if a future sidecar mirrors PoC and also emits a top `linked` field internally, this contract’s `status: "ambiguous"` forbids auto-binding.

### Example — near-miss → ambiguous suggestions ("did you mean?")

Typos / partials whose best ANN neighbor sits in the suggest band
(`suggest_threshold` ≤ sim &lt; `embed_threshold`, defaults 0.75 / 0.9), **or**
whose normalized name is within Levenshtein distance
`NER_EDIT_MAX_DISTANCE` (default **1**) of an indexed key, reuse
`status: "ambiguous"` with candidates — **no** `linkedId`, never auto-pick.
Edit hits use `method: "edit"`; soft ANN stays `"embed"`. Soft ANN and edit
candidates are unioned (deduped by id) and ranked by edit distance ascending,
then score. True misses (no soft ANN neighbor and no edit hit) stay `miss`
with empty candidates.

```json
{
  "requestId": "req_01JKLAR",
  "spans": [
    {
      "text": "Klar Finance",
      "label": "company",
      "start": 16,
      "end": 28,
      "status": "ambiguous",
      "candidates": [
        { "id": "co_1", "name": "Clear Finance", "score": 0.82, "entity": "company" }
      ],
      "method": "embed",
      "score": 0.82
    }
  ]
}
```

Facade clarify copy for near-misses prefers `Did you mean Clear Finance?` (one
candidate) or `Did you mean one of these instead of Klar Finance?` (several).
Exact-name duplicate ambiguous spans keep the existing "I found N matching …"
wording.

### Example — miss + rule span (email)

```json
{
  "requestId": "req_01JGHI",
  "spans": [
    {
      "text": "Zed Nowhere",
      "label": "person",
      "start": 0,
      "end": 11,
      "status": "miss"
    },
    {
      "text": "zed@example.com",
      "label": "email",
      "start": 20,
      "end": 35,
      "status": "miss",
      "method": "rule"
    }
  ]
}
```

Rule spans (`email` / `phone` / `id`) feed lookup qualifiers or create args later; they do not require a Store `linkedId`.

## Clarify-reply mapping (align with existing assignment types)

Ambiguous NER hits must feed the **existing** clarify UX, not a parallel UI.

### Real types in the repo

**`Clarification`** (`server/src/core/execute.ts`):

```ts
export interface Clarification {
  stepId: string;
  entity: string;
  name: string;
  candidates: Candidate[];
}
```

**`Candidate`** (`server/src/registry/registry.ts`):

```ts
export interface Candidate {
  id: string;
  name: string;
  detail?: string;
  inactive?: string;
}
```

**Planner early reply** (`server/src/planner/turn.ts` `TurnOutcome`):

```ts
{ kind: "reply"; status: "clarify" | "unsupported" | "answer" | "failed"; text: string; options?: string[] }
```

Planner identity / multi-match branches already return `status: "clarify"` with grounded `options` (see ~373–384 in `turn.ts`).

**Execute path:** multi-hit resolve sets step/run status `"needs_clarification"` and attaches `clarification: Clarification` (`execute.ts`).

**Conversation SSE** (`server/src/server/conversation.ts`):

- `finish` / `run` emit: `emit("reply", { status, text, options, … })`
- Clarify statuses treated as questions: `status === "clarify" || status === "needs_clarification"`
- Options from execute clarification:

  `result.clarification?.candidates.map((c) => (c.detail ? \`${c.name} (${c.detail})\` : c.name))`

### Mapping table

| Sidecar span | Assignment mechanism | Field mapping |
| --- | --- | --- |
| `status: "linked"` | Enrich mentions / later resolve with Store id | `linkedId` → Store id; `linkedEntity` or label→entity map |
| `status: "ambiguous"` | Early `TurnOutcome` clarify **or** execute `needs_clarification` | `candidates[].id/name/detail` → `Candidate`; option strings as above; reply `status: "clarify"` (planner) or `"needs_clarification"` (execute) |
| `status: "miss"` | No mention / NOT_FOUND / create path | No `linkedId`; do not invent candidates |

### Example clarify reply (planner-style SSE payload)

Built from the ambiguous Sarah span above (same shape Conversation emits on `reply`):

```json
{
  "status": "clarify",
  "text": "I found 2 matching contact records. Which one did you mean?",
  "options": [
    "Sarah Johnson (Acme)",
    "Sarah Johnson (Brightside)"
  ]
}
```

Near-miss (Klar → Clear Finance) uses did-you-mean copy, still `status: "clarify"`:

```json
{
  "status": "clarify",
  "text": "Did you mean Clear Finance?",
  "options": ["Clear Finance"]
}
```

### Example structured `Clarification` (execute-style)

```json
{
  "stepId": "s1",
  "entity": "contact",
  "name": "Sarah Johnson",
  "candidates": [
    { "id": "ct_31", "name": "Sarah Johnson", "detail": "Acme" },
    { "id": "ct_32", "name": "Sarah Johnson", "detail": "Brightside" }
  ]
}
```

Helpers `ambiguousOptions` / `clarifyFromAmbiguousSpan` in `ner_sidecar_contract.ts` encode the option-string rule; they do not call the sidecar or mutate plans.

## Out of scope

- Auto-committing top ambiguous hits
- Persisting NER scores on CRM rows

Failure handling, health endpoints, admission control and model pinning are described in [`server/ner-sidecar/README.md`](../server/ner-sidecar/README.md).

## Related paths

| Concern | Path |
| --- | --- |
| Contract types + zod | `server/src/retrieval/ner_sidecar_contract.ts` |
| Contract source + JSON Schema + fixtures | `server/ner-sidecar/contract.py`, `server/ner-sidecar/contract/` |
| Client: modes, timeout, breaker, trace | `server/src/retrieval/ner_client.ts` |
| Ask scope push | `server/src/retrieval/ner_ask_scope.ts` |
| Mentions | `server/src/retrieval/mentions.ts` |
| Plan turn (NER call) | `server/src/planner/turn.ts` |
| Clarification / execute | `server/src/core/execute.ts` |
| Reply SSE | `server/src/server/conversation.ts` |
| PoC integration analysis | `ask-ai-ner-poc/docs/integration-ask-ai-repo.md` |
