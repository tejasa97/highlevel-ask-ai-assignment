# NER sidecar request/response contract (phase 0/1)

**Status:** Contract frozen; Python sidecar + TypeScript facade (`ner_client.ts`) wired behind `NER_SIDECAR=1`.

**Grounding:** [`ask-ai-ner-poc/docs/integration-ask-ai-repo.md`](../../ask-ai-ner-poc/docs/integration-ask-ai-repo.md) (PoC analysis); TypeScript types in [`server/src/retrieval/ner_sidecar_contract.ts`](../server/src/retrieval/ner_sidecar_contract.ts).

## Standing rules

1. **No live CRM/DB inside the sidecar** to resolve entities. Linking uses an in-memory / prebuilt index only (exact map ± ANN). The assignment Store is already local; remote HighLevel APIs must not appear on this path.
2. **Ambiguous → clarify.** Never auto-resolve a PoC top `linked` hit into writes when the span status is `ambiguous`. PoC `LinkResult` may still set `linked` to the top neighbor; consumers of this contract must ignore that for write binding and force clarify.
3. **Canonical ids are Store ids:** `ct_` (contact), `ld_` (lead), `us_` (user), `co_` (company), `tm_` (team). PoC corpus ids (`pe_…`) must **not** leak as canonical `linkedId` / candidate `id` on this wire.
4. This phase freezes the facade ↔ sidecar JSON shape and the clarify mapping. Later phases add the sidecar process and a feature-flagged mention merge.

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
| `method` | `"exact"` \| `"embed"` \| `"rule"` | Optional |
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
(`suggest_threshold` ≤ sim &lt; `embed_threshold`, defaults 0.75 / 0.9) reuse
`status: "ambiguous"` with candidates — **no** `linkedId`, never auto-pick.
True misses (no neighbor ≥ suggest threshold) stay `miss` with empty candidates.

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

## Out of scope this phase

- Python GLiNER process, FAISS index build, or HTTP/stdio client
- Changes to `planTurn`, `mentions.ts`, or the `/api/ask` path
- Auto-committing top ambiguous hits
- Persisting NER scores on CRM rows

## Related paths

| Concern | Path |
| --- | --- |
| Contract types | `server/src/retrieval/ner_sidecar_contract.ts` |
| Mentions (unchanged) | `server/src/retrieval/mentions.ts` |
| Plan turn (unchanged) | `server/src/planner/turn.ts` |
| Clarification / execute | `server/src/core/execute.ts` |
| Reply SSE | `server/src/server/conversation.ts` |
| PoC integration analysis | `ask-ai-ner-poc/docs/integration-ask-ai-repo.md` |
