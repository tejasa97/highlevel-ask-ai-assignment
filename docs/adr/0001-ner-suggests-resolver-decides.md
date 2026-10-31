# ADR 0001: NER suggests, the resolver decides, the user settles doubt

**Status:** Accepted, 1 November 2026.

## Context

The planner writes `$lookup` arguments, which compile to `resolve` steps. Before this change, `bindNerLookups` ([ner_bind.ts](../../server/src/planner/ner_bind.ts)) took a sidecar `linkedId` for that name and stored it on the step as `pinned`. That included embedding matches scoring 0.9 or more. The executor then used the pin with no store lookup. The pin also recorded the user's own text as the record's name. So "Email Ana Ruis" could send to Ana Ruiz without asking, and the approval card and step output showed "Ana Ruis". A record deleted or merged after the sidecar's index was built could still be written to. The sidecar's index is a separate, periodically rebuilt copy of the store. Its links are a model's opinion about a span, not a fact about the store.

## Decision

One deterministic identity resolver, [core/identity.ts](../../server/src/core/identity.ts), decides every binding. NER links and embedding matches are only candidate sources.

- **Input:** `{entity, text, where, qualifiers, actionRisk, hints}`. Candidates are limited to the expected entity type and parent scope: every candidate, whatever produced it, must be one that entity's store resolver returns for that scope.
- **Candidate generators,** each tagged with a `matchReason` and score: exact id, exact email, exact normalized name, looser name tiers (whole word, prefix), alias, and edit distance ≤ 1 (used only when nothing else matched). After these come hints (`ner`, `embed`), capped below the strong keys at 0.9.
- **Result:** a typed, exported `IdentityResolution`. It is `bound`, `ambiguous`, `suggest` or `not_found`, with ranked candidates `{id, name, detail, matchReason, score}` and a one-line `decision`.
- **Risk policy:**
  - **Reads:** a name used as a filter never reaches the resolver. A single-record read binds the unique store match and asks only when several match. It never offers near misses.
  - **Creates:** a same-named record is a duplicate warning, never a binding or a picker.
  - **Single-target writes and sends:** these bind only on a unique strong key: an id, an email, or an exact normalized name that is unique in scope. Several strong matches are narrowed by a detail in the user's words ("at Brightside"). Otherwise they are `ambiguous`. A partial name, an alias, an edit or a hint is a `suggest` ("Did you mean …?").
- **Bindings:** a binding stores the record's own name, a fingerprint of its identity, and how it was made. That provenance is `exact-unique`, `lookup` (narrowed or read), or `user-selected` (for the clarification flow). NER pinning is removed.
- **Revalidation:** execution re-checks a binding made before it ran, and refuses with `STALE_IDENTITY` if the record is gone, merged or archived, or its identity (name, detail, status) changed. It compares the identity fingerprint rather than `updatedAt`, so a plan's own earlier write (for example a tag added before an approval resumes) does not refuse its own recipient.
- **Configuration:** thresholds are set by `RESOLVER_EDIT_MAX_DISTANCE`, `RESOLVER_SUGGEST_MAX`, `RESOLVER_HINT_MIN_SCORE` and `RESOLVER_WRITE_BIND` (`strong` by default; `unique` restores binding a unique partial name on writes).
- **Tracing:** every decision is an `identity.resolved` event, from both the executor and the turn.
- **Approval card:** the card's `pending.identities` lists how each record was bound.

**The planner's job stays small, deliberately.** The aim is that small, cheap planner models (for example GPT 6 Luna) plan reliably, and [JOURNEY §16](../JOURNEY.md#16-codex-integration-implementation-verified-ai-acceptance-remains-unmet) logs Luna failing on unnecessary clarification and invented step references. So the planner only emits a plain selector for a record argument: the existing `$lookup` with entity, the user's words, and an optional `where` scope. This change adds no planner field and no prompt text. Matching, ranking, ambiguity and the decision to ask all happen in code. The qualifier that narrows "Sarah Johnson at Brightside" is read from the user's message, not from anything the planner fills in. A future change should add a planner field only when code cannot recover the information.

## Rejected options

Each option carries the measured trigger that would reopen it. Triggers are read from the `identity.resolved` trace and the sidecar's own timings.

| Option | Why not now | Revisit when |
| --- | --- | --- |
| NER as authority: bind writes on a sidecar link | The index lags the store, and an embedding score is not identity. One wrong send costs more than a question. | On a labelled sample of at least 1,000 write-path mentions, exact sidecar links agree with the resolver's strong-key binding at least 99.9% of the time, and the index is updated in the same transaction as the store. |
| Vector database | The store resolver plus the sidecar's in-memory index cover the seed sizes, and embeddings are only hints. | One scope holds more than 100k records, or embedding lookup p95 exceeds 50 ms, or the in-memory index exceeds 1 GB. |
| Separate resolver service | The resolver is a pure function over the local store. A network hop adds latency and a failure mode. | A second caller outside the ask path needs identity resolution, or resolver time exceeds 10% of turn p95. |
| Incremental index sync | Stale hints are harmless now: the resolver drops ids the store no longer holds, and revalidation catches the rest. | Full scope rebuilds exceed 5 s, or more than 1% of hinted write lookups end `not_found` or `STALE_IDENTITY` because the index was stale. |
| Multi-tenancy in the resolver or index | The app serves one simulated account per process. | Two accounts share a server process or a sidecar index. |

## Consequences

- **Writes that ask now:** writes and sends whose name is only a first name, a partial name or a one-edit typo now ask "Did you mean …?" before running. They used to bind the unique partial match or fail `NOT_FOUND`.
- **Option labels:** option labels in "which one" questions come from the store's detail, not the sidecar's.
- **NER links:** NER links never bind on their own, including exact ones. Without a store, the planner turn can still ask from NER ambiguity or suggestions, but never binds.
- **Clarification flow:** the flow that answers a `suggest` or `ambiguous` question builds on the exported `IdentityResolution`, the clarification's `resolution` field, and `userSelected()`.

Tests: [identity](../../server/src/core/identity.test.ts), [NER hints](../../server/src/planner/ner_hints.test.ts).
