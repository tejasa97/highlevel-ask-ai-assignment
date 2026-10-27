# Model-independent record lookup and planning support

## Scope

Follow-on: the seven older-suite improvements, including bounded completion handling, are implemented separately in [Grounded planner outcomes](PLANNER-OUTCOMES.md).

This batch implements the first three agreed improvements: consistent named-record lookup, discovery dependencies in retrieval, and a smaller planner-facing representation. It is shared by every `Planner` provider. There is no provider/model-name branch, reasoning-setting change, new executor or embedding-model change. Completion tracking, unrequested prerequisite writes and whole-plan approval policy are separate work.

## Named arguments

The model can submit one action:

```json
{
  "id": "run",
  "kind": "action",
  "action": "M50.A07",
  "argsJson": "{\"reportId\":{\"$lookup\":{\"entity\":\"report\",\"name\":\"Monthly Revenue\"}}}"
}
```

The compiler expands the named argument into an ordinary read-only `resolve` followed by the action with a scalar `$lookup_1.id` reference. The existing compiler and executor still validate schemas, dependencies, permissions, state, replay and confirmation. Name lookup needs no additional model round and never uses an arbitrary `items[0]`. Legacy explicit `resolve` steps and ordinary IDs/references remain supported.

Inline lookup is for top-level scalar ID arguments. An ID argument must match its entity (including documented aliases such as `assigneeId` → user and `assetId` → media_asset). Nested/polymorphic inputs can use an explicit resolve and a reference. Within `forEach`, inline lookup can resolve a fixed named record; per-item values still use the existing `$item` references.

Module-owned resolvers now cover the newly supported named configuration/content objects: company, pipeline/stage, smart list, custom field, template, workflow, trigger, form, survey, calendar, booking page, event, product/price, coupon, tax rule, website/funnel/landing page/blog post, media asset, course/lesson, community, membership plan and saved report. Anonymous records still require their proper domain search; no synthetic names or new catalog actions are invented.

Names use the existing matching tiers (exact first, then whole-word/prefix matching), preserving ambiguity rather than selecting the first match. Zero matches fail and dependent actions skip; multiple usable matches pause for clarification; inactive handling and domain action checks remain in place.

## Exact qualifiers

Both inline lookup `where` and explicit resolve `whereJson` can carry supported exact-match qualifiers, for example company/email for contacts, directory for listings, productId for prices, courseId for lessons and pipeline/pipelineId for stages. Filters apply **before** name ranking. Unknown, empty or non-string qualifiers fail validation instead of being silently ignored. An explicit earlier string reference may supply a qualifier, e.g. `pipelineId: "$parent.id"`.

The prompt lists supported types and qualifier keys from the registry. A qualifier embedded only in free text is not automatically parsed by code: the planner must preserve it in `where` (or use the appropriate explicit search). This is not a guarantee of semantic intent recognition.

## Lookup bundles

Retrieval distinguishes `produces` (including create/write actions) from `lookupFor` (read-only discovery of existing records). Discovery is derived from implemented typed list outputs, with explicit `entities.lookup` for cases such as exact-name community get. ID-only gets and writes are not discovery tools.

A selected create action therefore cannot satisfy a missing discovery dependency. For resolvable named types, built-in resolve is the single-record lookup; bulk requests still receive discovery helpers where the catalog supports them. A name-only get cannot enumerate every record of a type. Dependency additions remain identifiable as `producer` in existing traces. No broad sibling links or extra model calls are introduced.

Name mentions add one get plus one standalone discovery helper, not every cross-module list returning the entity. Discovery prefers the fewest required inputs before semantic rank; for example, searching contacts does not first require a company or tag ID. Naturally named configuration/content objects require their full label for automatic mention linking; explicit typed lookup can still use the existing partial-name matching tiers.

## Follow-up identities

The session carries at most 12 `{entity,id,name}` identities actually observed in successful execution steps. It does not carry raw records, mutable fields or planned-but-unexecuted IDs. These appear in the rebuilt per-turn `<recent_records>` block and reset with the chat. They are identity hints, not authoritative current state; handlers still recheck the actual record. The model must clarify when a follow-up has several plausible targets.

## Tests

Tests cover actual fixtures for every table resolver, zero and duplicate matches, company/directory/parent qualifiers, ID and entity validation, generated step-ID collisions, permission denial, changed-target approvals and typed session reset. Generated resolve IDs are kept with the actual read plan after a look, and qualifier interpolation is checked with the same dependency and type rules as ordinary references. Live measurements are in [BENCHMARK.md](../BENCHMARK.md); deterministic tests alone don't show a success-rate change.
