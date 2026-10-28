# Adding a module

All 50 catalog modules are built. This page is the contract they follow and the checklist for changing one or adding another. `server/src/modules/m07-notes` is the smallest example to copy. M45 Reviews, M46 Business Listings and M47 Support Tickets show the full process, including frozen eval data.

## 1. Freeze the contract and test data

Use the exact ten IDs/names from `server/src/registry/catalog.json`; do not invent convenience actions. Write down states, transitions, duplicate identity, no-op behaviour, permissions, consent, timezone and failure policy before handlers. Distinguish simulator decisions from actual HighLevel behaviour.

Freeze test data with development and separate reporting scenarios before implementation. M45–M47's initial seed/scenarios were committed at `080618f`; `eval/module-scenarios/m45-m47/freeze.json` records their hashes and the explicitly versioned development correction. Keep reporting outcomes out of tuning. If a development assertion is wrong, preserve its original bytes/results, explain the correction and change the fingerprint; do not modify handlers to satisfy a false expectation. Record the seed version separately: the runner's scenario fingerprint does not include data.

## 2. Files and registration

A module folder holds:

```
server/src/modules/mNN-name/
  schema.ts      row shapes, status enums, cross-module references
  index.ts       default export { actions, resolvers? } satisfies ModuleExports
  fixtures.ts    builders added to Fixtures by declaration merging (see m02-companies/fixtures.ts)
  name.test.ts   behaviour tests: the rules, not the happy path of every action
```

- **Loading.** The loader discovers module folders and registers each `index.ts`; display names come from the catalog. No second dispatch table or executor is needed.
- **Fixtures.** `index.ts` imports `./fixtures.js`, so the builders exist whenever the actions are registered (the `example(f)` functions use them). A module adds builders in its own `fixtures.ts`, not in `store/fixtures.ts`.
- **Tables.** Every table, its ID prefix and its owning module are listed in `server/src/store/entities.ts` (`ENTITIES`). New tables go there. `entities.test.ts` fails on a duplicate prefix, a table outside the map, or an `insert(...)`/`make(...)` that uses a different prefix from the map.
- **All or nothing.** A module registers all ten of its catalog actions or none. `registry/smoke.test.ts` checks this against the catalog.

## 3. Actions

Each `defineAction` needs an exact catalog ID, a useful description, explicit `risk` (`read | write | destructive | external`), a **strict** Zod input (`z.strictObject`), a validated output, produced/consumed entities, a fixture-backed `example(f)` and a concrete handler. Optional arguments must be optional in the schema. Outputs must expose the fields downstream plans need, not just a success string. Declare `siblings` for look-alike actions in other modules; the link is made mutual when cards are built.

Searches return `{ items, total }`, accurate totals before limiting, documented defaults and stable ordering. Use shared helpers for contacts, users, typed errors and dates.

- **Errors.** Failures are `ActionError` with a code: `NOT_FOUND`, `DUPLICATE`, `INVALID`, `CONFLICT`, `PERMISSION`, `TIMEOUT`, `UNAVAILABLE`. Use `mustGet` for lookups. State-machine violations (editing a published page, a second default price, removing a stage with deals in it) are `CONFLICT` with a message that says what to do instead. An unchanged update throws through `noChange`. Nonexistent IDs never silently become new records.
- **Writes.** Every write goes through `store.insert` with the prefix from `ENTITIES`, or `store.update`; the registry audits it.

Optional metadata on an action, from [`registry/define.ts`](../server/src/registry/define.ts):

- **`synonyms`** — general user-language paraphrases, indexed by both lexical and semantic retrieval.
- **`entities.optionalConsumes`** — relationships the action can use but doesn't need; they expand retrieval only for a matching typed mention.
- **`entities.lookup`** — marks an unusual read-only action as the discovery helper for an entity type.
- **`argumentLookups`** — a child ID bound to its parent: `"answers[].fieldId": { entity: "form_field", scope: { formId: "formId" } }`.
- **`typedIds`** — a polymorphic ID whose record type is in a sibling argument: `{ "relatedTo.id": "relatedTo.type" }`.
- **`idTypes`** — an ID named for its role rather than its type: `{ keepId: ["contact"] }`.
- **`inputAlternatives`** — the real alternative input groups when required inputs are conditional (send an email by `emailId`, or by `contactId` plus `subject` and `body`).
- **`destination`** — `{ id, label }` of the delivery surface a send/publish action reaches.
- **`query`** — a read whose only writes are internal bookkeeping (a report's last-run time). It doesn't lower execution risk.
- **`preflight`** — a side-effect-free eligibility check that returns the targets to bind to approval (see [subset confirmation](PARTIAL-CONFIRMATION.md)).
- **`caveat`** — for an action that records a failed outcome instead of throwing (a bounced email); returns the clause the reply adds after "Done: …, but".

## 4. Storage, fixtures and identity

Use existing Store transactions, deterministic per-table IDs and the shared Clock; never call wall-clock time in a domain handler. Add schema-validated fixture builders. Test actual file-backed SQLite close/reopen as well as in-memory execution.

**Test data.** `store/seed.ts` holds the v1 data, and `store/module-seed.ts` appends the frozen M45–M47 manifest. Other modules seed nothing: their scenarios create what they need with `setup` steps (fixture builders and injected faults), and their tests build their own rows with fixtures. If a module does append seed rows, add them without inserting earlier in the RNG/ID sequence, and check hashes of **all existing rows**, not just counts or IDs.

**Seams in v1 records.** `contacts.companyId` (null until M02 links a company) and `appointments.calendarId` (null until a booking names a calendar). Editing a contact's company *name* unlinks the company record (M01.A04); merging contacts (M01.A06) carries the link along with the company name.

Resolvers must express real identity. Business name alone can match multiple directory/location listings. A ticket needs title words; a requester's name alone is not a ticket title. Closed tickets stay resolvable for reopening. Reviews have no unique natural name: search/filter them by reviewer/contact, rating, date or content and clarify multiple matches.

## 5. Permissions and effects

This repository checks permissions selectively: external/destructive operations and user/team administration, **not every read or ordinary internal write**. Follow that pattern; a global permission retrofit is separate work.

Name domain permissions explicitly. `reputation.manage` belongs to marketing/manager/admin; `tickets.manage` to support/manager/admin. Validate owner eligibility separately from actor permissions.

For new module-owned customer sends, require both the domain permission and `messaging.send`. Legacy invoice sends still check only `billing.manage`. Review/listing publication requires `reputation.manage` but is not customer messaging. These external actions still require executor approval.

Reuse messaging helpers, not a new transport. Module-owned emails must be refused by generic send **and schedule**, with the same routing blocker in preview. Only the owning action may update domain state and send together. Review requests obey marketing opt-outs/DND; ticket replies follow the simulator's transactional bypass but still require a valid address. Failed delivery rolls back domain, message, conversation and audit changes; errors stay in execution traces, not a falsely successful record.

Whitelist reference fields when passing structurally typed objects into other records. An email contains `contactId` and `leadId`, but also its own `id`, status and private payload; spreading the whole object into a conversation is unsafe.

### Who writes what across modules

Where an action touches another module's table, the acting module changes only the fields listed.

| Action | Also changes | Rule |
|---|---|---|
| M02.A06 / A07 | `contacts.companyId`, `contacts.company` | link sets both; unlink nulls the id and keeps the name |
| M02.A09 merge | `companyId`/`company` of the duplicate's contacts | duplicate becomes `merged` |
| M10.A09 | `custom_field_values` | checks the field's type, validation, and refuses a retired option |
| M09 filters | read-only over contacts/leads/opportunities/companies | `cf.<key>` reads `custom_field_values` |
| M17.A09 | trigger test firing | evaluates conditions, never starts a workflow run |
| M20.A10 | — | refused while upcoming appointments are booked on the calendar |
| M22.A09 / A10 | read-only over `appointments` | working hours or overrides, minus blocks and booked time plus buffer, within notice and horizon |
| M23.A09 | — | needs a linked, public, active calendar |
| M24.A06 / A07 / A09 | `event_registrations` | over capacity → waitlisted; cancel frees a seat but doesn't promote; A09 promotes explicitly |
| M27.A10 | `invoices` (open), the quote | only accepted quotes; lines carry over |
| M31.A09 | read-only | returns `valid: false` for an inactive, out-of-window, used-up or product-restricted coupon |
| M32.A08 | `invoices` (open), coupon redemptions, product inventory | computes tax unless the contact is exempt; inventory shortfall is `CONFLICT` |
| M32.A09 | invoice → void, coupon redemption, inventory | only while the invoice is unpaid |
| M33.A09 | payment allocations, `invoices` | reopens the invoices the payment had paid, newest allocation first; cash is `CONFLICT` |
| M36.A07 | — | the landing page must already be published |
| M37.A07 | — | a draft form can't be attached to a published page |
| M39.A10 | `media_assets` | refused while any landing page, blog post or lesson references the asset |
| M44.A07 / A09 | enrollments, `community_members` | grant enrolls and adds to communities; revoke undoes only what the grant did |

Money is USD everywhere downstream of a price: a non-USD price on a quote or order is `CONFLICT`.

## 6. Verification

- `registry/smoke.test.ts` runs every registered action automatically: its example must succeed, a made-up parameter must be `INVALID`, and an unknown required ID must be `NOT_FOUND`. Keep `example(f)` valid on the base world plus your fixtures.
- Domain tests cover transitions, no-ops, duplicate identity, roles, deactivated actors, consent, output shape and boundary dates, using `testWorld()`, `call` and `failure` from `server/src/testkit.ts`. State time policies explicitly; M47 measures elapsed first-response hours, not resolution or business-hours SLA.
- Use the existing compile/execute path for bulk confirmation, changed targets, cancellation, per-item rollback and replay deduplication. Add real HTTP tests for SSE, trace, diffs and audit. Scripted plans verify plumbing, **not** natural-language AI success.
- Add natural-language development coverage for all ten actions, look-alikes, ambiguity, follow-ups, cross-module chains and failures. Run the unchanged regression suite separately. Investigate every new failure or loss of consistency, even if another repeat passes.
- Run `npm run typecheck` and `npm test` in `server/`, and `npm run build` in `web/`. Verify representative UI flows in a browser. Do not hide quota/provider failures as application failures.

## 7. Retrieval, reporting and completion

Module-owned `synonyms` may add general paraphrases; never copy a scenario sentence. Use `entities.optionalConsumes` for genuinely optional relationships: these override generated mandatory-dependency fallback. Declare `destination` on delivery/publication actions, reusing an existing surface ID where it fits; this advertises capabilities, not real integrations or permissions. Document required side effects in the action description. Shared planner outcome tracking checks declared final action coverage, not final-state correctness; module and scenario assertions still verify actual effects. See [shared planner changes](PLANNER-CHANGES.md).

`query: true` is only for queries whose writes are internal bookkeeping, such as a last-run timestamp or a trigger-test record that never starts a workflow. Never use it for real domain changes, simulated business submissions, sends or destructive actions; registry validation rejects the external and destructive risk classes.

Registry descriptions/entities are authoritative for implemented actions; generated cards (`npm run cards -- M45 M46`) still supply synonyms and sibling links. Review both. Never write synonyms from reporting outcomes or copy benchmark paraphrases. Measure candidate links individually with recall, mean/max shortlist size and prompt characters; reject expansions without demonstrated value. Initial retrieval is not a hard 15-card ceiling: siblings, producers and mentions add cards.

`npm run eval:scenarios -- --scenario-dir eval/module-scenarios/<batch>/development --repeat 3 --label <label>` selects one folder relative to the repo root. Keep reporting in a sibling folder; default `eval/scenarios` remains the regression set. Record the folder and scenario fingerprint in reports/history. The trajectory (`npm run trajectory`) groups each folder separately and keeps `eval/scenarios` as its headline; do not change scoring/cost formulas in a module batch.

Update README scope/examples, domain policy, JOURNEY, result links and this checklist if conventions change. A module is complete only when handlers, persistence, retrieval, UI, deterministic checks and repeated AI evaluations are accounted for. If a gate is blocked or misses its target, say so explicitly.

## Shared named-record lookup

For a naturally named entity, register a module-owned resolver built with one of the helpers in `registry/lookup.ts`: `tableResolver` for a table with a name or title column, `namedResolver` for nested records or custom labels, or `ownedResolver` for records that belong to a contact and have no name of their own (invoices, quotes, orders, subscriptions, enrollments). See [the lookup foundation](PLANNER-CHANGES.md#foundation-consistent-record-lookup). Declare supported qualifier keys explicitly; they filter before name matching. Do not invent names for anonymous records, pick the first ambiguous match, or use a create action as an existing-record lookup. Discovery actions should return typed `{items, total}` records and name the produced entity; unusual read-only discovery can declare `entities.lookup`.

For child IDs, declare `argumentLookups` with the entity and scope mapping. Require parent qualifiers on resolvers that have no global identity. Test repeated labels under different parents, duplicate labels within one parent, missing children and contradictory qualifiers. Prefer typed entries over model-constructed ID-keyed maps; keep existing input compatibility when extending a handler. Per-item variable-parent lookups cannot be hoisted from a loop.

Clarifications must bind `missing: { action, argument, argsJson }` to a real missing input of an offered action; the category label is not the grounding gate. Declare real conditional routes in `inputAlternatives` when a strict schema alone cannot express them. Test that a complete route does not trigger questions for another route, and that optional unspecified fields are not required. Metadata does not replace handler validation, permission or approval. See [scoped lookup and clarification conventions](SCOPED-LOOKUPS-AND-CLARIFICATIONS.md).
