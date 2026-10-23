# Module contract

How a breadth module (one of the 32 not yet built) is added, so several can be built side by side and merged without conflicts. `server/src/modules/m07-notes` is the pattern to copy; this page says what is fixed up front and what each module owns.

## What already exists (do not redesign)

- **`schema.ts` in every module folder.** The row shape, status enums and the cross-module references are settled. A module may add fields or tighten types in *its own* `schema.ts`; if it needs a field on another module's record, stop and tell the integrator (the seams below are the known ones).
- **`store/entities.ts`.** Every table, its id prefix and its owning module. New tables are added here and only here; `entities.test.ts` fails on a duplicate prefix, on a table that isn't in the map, and on an `insert(...)`/`make(...)` that uses a different prefix than the map. M45–M47 (`rrq`, `rv`, `bl`, `tic`) are in the map too.
- **Seams in v1 records.** `contacts.companyId` (M01, null until M02 links it), `appointments.calendarId` (M21, null until M20/M22 book on a calendar). Editing a contact's company *name* unlinks the company record (M01.A04); merging contacts (M01.A06) carries the link along with a filled-in company name. A dev database made before this change lacks the two fields: `npm run db:reset`.

## Files a module adds (and only these)

```
modules/mNN-name/
  schema.ts        given — extend only your own
  index.ts         default export { actions: [...10 actions], resolvers?: {...} }  (ModuleExports)
  fixtures.ts      builders added to Fixtures by declaration merging (see m02-companies/fixtures.ts)
  name.test.ts     behavior tests: the rules, not the happy path of every action
```

`index.ts` imports `./fixtures.js` so the builders exist whenever the actions are registered (the `example(f)` functions use them).

**Do not edit** `store/fixtures.ts`, `store/seed.ts`, `store/entities.ts`, `registry/catalog.json`, `retrieval/cards.json`, `docs/`, or any other module's folder. These are the merge-conflict surface; the integration pass (below) owns them.

## Action rules (same as v1)

- Ids and names come from `catalog.json`; a module registers all 10 of its actions or none (`smoke.test.ts` checks this against the catalog).
- `defineAction` with a `z.strictObject` input, an `output` schema, `risk` (`read | write | destructive | external`), `siblings` for look-alike actions, and an `example(f)` that succeeds on the base world plus your fixtures.
- Failures are `ActionError` with a code: `NOT_FOUND`, `DUPLICATE`, `INVALID`, `CONFLICT`, `PERMISSION`, `TIMEOUT`, `UNAVAILABLE`. Use `mustGet` for lookups. State-machine violations (editing a published page, a second default price, removing a stage with deals in it) are `CONFLICT` with a message that says what to do instead.
- Every write goes through `store.insert` with the prefix from `ENTITIES`, or `store.update`; the registry audits it.
- Tests cover business rules and cross-module effects, using `testWorld()`, `call` and `failure` from `testkit.ts`.

## Who writes what across modules

Where an action touches another module's table, the table's *owner* is named; the acting module changes only the fields listed.

| Action | Also changes | Rule |
|---|---|---|
| M02.A06 / A07 | `contacts.companyId`, `contacts.company` | link sets both; unlink nulls the id and keeps the name |
| M02.A09 merge | `contacts.companyId`/`company` of the duplicate's contacts | duplicate becomes `merged`, `mergedInto` set |
| M10.A09 | `custom_field_values` | validates against the field's type, options (a retired option is refused) and validation rules |
| M09 filters | read-only over contacts/leads/opportunities/companies | `cf.<key>` reads `custom_field_values` |
| M16.A08 | — | needs ≥1 step and a passing validation (A07); bound triggers (M17) require `published` |
| M17.A09 | `trigger_firings` (`test: true`) | evaluates conditions, never starts a `workflow_runs` row |
| M20.A10 | — | refused while upcoming appointments carry its `calendarId` |
| M22.A09 / A10 | read-only over `appointments` | slots = working hours − date blocks − appointments of the calendar's hosts − buffer, honoring notice and horizon |
| M23.A09 | — | needs a linked, public, active calendar |
| M24.A06 | `event_registrations` | over capacity → `waitlisted`; A07 cancel frees a seat but does not auto-promote; A09 promotes explicitly |
| M27.A10 | `invoices` (M28 shape, status `open`), `quotes.invoiceId` | only `accepted` quotes; lines carry over |
| M30 | — | prices must be recurring (interval ≠ `one_time`); pause/resume shifts the period |
| M31.A09 | read-only | validates window, redemption limit, product restriction, `active` |
| M32.A08 | `invoices` (open), `coupons.redemptions`, `products` inventory | computes tax from `tax_rules` unless the contact has a valid exemption; inventory shortfall is `CONFLICT` |
| M32.A09 | `invoices` → `void` | only if unpaid; restores inventory |
| M33.A09 | `payments.allocations`, `invoices` | executing a refund reopens the invoices the payment had paid, newest allocation first |
| M36.A07 | — | a step's landing page must be published before the funnel publishes |
| M37.A07 | — | a draft form can't be attached to a page being published |
| M39.A10 | `media_assets` | refused if any record's `mediaIds` contains the id |
| M41 / M42 | — | completion requires a published lesson in the learner's course; certificate only when all published lessons are done |
| M44.A07 | `enrollments` (`membershipId` set), `community_members` | grants every entitlement; A09 revoke reverses them |

Money is USD everywhere downstream of a price: adding a non-USD price to a quote or order is `CONFLICT`.

## Not in a module's scope (the integration pass does these)

1. **Seeds.** Each module's demo rows go in `store/seed.ts` after all modules land, so ids stay deterministic across modules. A module's tests build their own rows with fixtures.
2. **Resolvers** (`resolvers` in `ModuleExports`: name → id lookups such as "the Acme company"). Added once the entity names are final.
3. **Retrieval cards** (`npm run cards -- M02 M05 ...`) and a read of the generated cards.
4. **Planner/eval changes:** retrieval questions, scenarios, a benchmark run.

## Definition of done for a module

- 10 actions registered; `npm run typecheck` and `npm test` pass with only that module's folder changed (plus nothing else).
- Each rule above that involves the module has a test.
- A one-line summary of any cross-module behavior that surprised you, for the integrator.
