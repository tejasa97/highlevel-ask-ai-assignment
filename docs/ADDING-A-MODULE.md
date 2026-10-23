# Adding a module

M45 Reviews, M46 Business Listings and M47 Support Tickets demonstrate this pattern. This is an implementation checklist, not a claim that their pending AI evaluation gates have passed.

## 1. Freeze the contract and test data

Use the exact ten IDs/names from `server/src/registry/catalog.json`; do not invent convenience actions. Write down states, transitions, duplicate identity, no-op behavior, permissions, consent, timezone and failure policy before handlers. Distinguish simulator decisions from actual HighLevel behavior.

Freeze seed records **and their IDs** with development and separate reporting scenarios before implementation. M45–M47's initial seed/scenarios were committed at `080618f`; `freeze.json` records their hashes and the explicitly versioned development correction. Keep reporting outcomes out of tuning. If a development assertion is wrong, preserve its original bytes/results, explain the correction and change the fingerprint; do not modify handlers to satisfy a false expectation. Record the seed version separately: the runner's scenario fingerprint does not include data.

## 2. Files and registration

Create `server/src/modules/mNN-name/schema.ts`, `index.ts` and domain tests. Export `{ actions, resolvers? } satisfies ModuleExports` as default. The loader discovers module folders; it supplies names from the catalog. No second dispatch table or executor is needed.

Each `defineAction` needs an exact catalog ID, useful description, explicit risk, **strict** Zod input, validated output, produced/consumed entities, a valid fixture-backed smoke example and a concrete handler. Optional arguments must be optional in the schema. Outputs must expose the fields downstream plans need, not just a success string.

Searches return `{ items, total }`, accurate totals before limiting, documented defaults and stable ordering. Use shared helpers for contacts, users, typed errors and dates. Throw ActionError for unsupported transitions, duplicates and unchanged updates. Do not let nonexistent IDs silently become new records.

## 3. Storage, fixtures and identity

Use existing Store transactions, deterministic per-table IDs and the shared Clock; never call wall-clock time in a domain handler. Add schema-validated fixture builders. Append seed records without inserting earlier in the RNG/ID sequence. Check hashes of **all existing rows**, not just counts or IDs. Test actual file-backed SQLite close/reopen as well as in-memory execution.

Resolvers must express real identity. Business name alone can match multiple directory/location listings. A ticket requires title words; a requester's name alone is not a ticket title. Closed tickets remain resolvable for reopening. Reviews have no unique natural name: search/filter them by reviewer/contact, rating, date or content and clarify multiple matches.

## 4. Permissions and effects

This repository currently checks permissions selectively: external/destructive operations and user/team administration, **not every read or ordinary internal write**. Follow that pattern; a global permission retrofit is separate work.

Name domain permissions explicitly. `reputation.manage` belongs to marketing/manager/admin; `tickets.manage` to support/manager/admin. Validate owner eligibility separately from actor permissions.

For new module-owned customer sends, require both the domain permission and `messaging.send`. This is a new convention; legacy invoice sends still check only `billing.manage`. Review/listing publication requires `reputation.manage` but is not customer messaging. These external actions still require executor approval.

Reuse messaging helpers, not a new transport. Module-owned emails must be refused by generic send **and schedule**, with the same routing blocker in preview. Only the owning action may update domain state and send together. Review requests obey marketing opt-outs/DND; ticket replies follow the simulator's transactional bypass but still require a valid address. Failed delivery rolls back domain, message, conversation and audit changes; errors remain in execution traces, not a falsely successful record.

Whitelist reference fields when passing structurally typed objects into other records. An email contains `contactId` and `leadId`, but also its own `id`, status and private payload; spreading the whole object into a conversation is unsafe.

## 5. Verification

- Add the module to `registry/smoke.test.ts`'s ten-action gate. Exercise every action, strict unknown fields and relevant unknown IDs.
- Domain tests cover transitions, no-ops, duplicate identity, roles, deactivated actors, consent, output shape and boundary dates. State time policies explicitly; M47 measures elapsed first-response hours, not resolution or business-hours SLA.
- Use the existing compile/execute path for bulk confirmation, changed targets, cancellation, per-item rollback and replay deduplication. Add real HTTP tests for SSE, trace, diffs and audit. Scripted plans verify plumbing, **not** natural-language AI success.
- Add natural-language development coverage for all ten actions, look-alikes, ambiguity, follow-ups, cross-module chains and failures. Run the unchanged regression suite separately. Investigate every new failure or loss of consistency, even if another repeat passes.
- Run `npm run typecheck`, `npm test` and the web build. Verify representative UI flows and the generated trajectory in a browser. Do not hide quota/provider failures as application failures.

## 6. Retrieval, reporting and completion

Registry descriptions/entities are authoritative for implemented actions; generated cards still supply synonyms and sibling links. Review both. Never write synonyms from reporting outcomes or copy benchmark paraphrases. Measure candidate links individually with recall, mean/max shortlist size and prompt characters; reject expansions without demonstrated value. Initial retrieval is not a hard 15-card ceiling: siblings, producers and mentions add cards.

`npm run eval:scenarios -- --scenario-dir eval/module-scenarios/<batch>/development --repeat 3 --label <label>` selects one folder relative to repo root. Keep reporting in a sibling folder; default `eval/scenarios` remains the regression set. Record the folder and scenario fingerprint in reports/history. Trajectory groups each folder separately and keeps `eval/scenarios` as its headline; do not change scoring/cost formulas in a module batch.

Update README scope/examples, domain policy, JOURNEY, result links and this checklist if conventions change. Rebuild trajectory. A module is complete only when handlers, persistence, retrieval, UI, deterministic checks and repeated AI evaluations are accounted for. If a gate is blocked or misses its target, say so explicitly. Keep reviewable commits and never push without authorization.
# Shared named-record lookup

For a naturally named entity, register a module-owned `tableResolver` (or `namedResolver` for nested records). See [the lookup contract](PLANNER-RECORD-LOOKUPS.md). Declare supported qualifier keys explicitly; filter them before name matching. Do not invent names for anonymous records, pick the first ambiguous match, or use a create action as an existing-record lookup. Discovery actions should return typed `{items, total}` records and identify the produced entity; unusual read-only discovery can declare `entities.lookup` explicitly.

