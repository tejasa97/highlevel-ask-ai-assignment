# Shared planner changes: what changed and why

The rationale and the mechanics of the planner's shared lookup, retrieval and outcome handling. Current measurements are in [BENCHMARK.md](../BENCHMARK.md).

[Scoped child lookup and argument-bound clarification](SCOPED-LOOKUPS-AND-CLARIFICATIONS.md) extends the foundation and section 1 below.

Everything here is shared by every `Planner` provider. There is no provider or model-name branch, no second executor and no change of embedding model.

## The problem we were trying to solve

Retrieving a relevant action is only the first part of completing a request. The model must also find the right records, pass valid IDs, preserve qualifiers, use the right dates, finish the requested operation and respect approvals. Several failures happened **after the correct action was already offered**. A stronger embedding model would not, by itself, fix those failures.

The design choice was therefore to improve the shared interface and move deterministic work into code. Models still interpret requests and compose plans. Code handles known lookup rules, calendar arithmetic, eligibility filtering and checks on the declared plan. These changes apply to every provider using this planner, not only the model it was first validated on. That is an architectural property, not evidence that every model's success rate has improved.

## Foundation: consistent record lookup

**What changed.** Module-owned resolvers cover 45 entity types. An ID argument can hold a typed `$lookup` with a name and supported exact qualifiers. The compiler turns it into the existing resolve-and-action steps. The session remembers up to 12 observed `{entity,id,name}` identities for follow-ups. Generated lookup IDs survive read/replan rounds.

**Why.** Asking the model to invent an ID or construct a long search/reference chain creates avoidable failure points. A person's name is not a ticket title; a business name may identify several directories; a stage belongs to a particular pipeline. Lookup must preserve those distinctions before selecting a record.

**Boundary.** Multiple matches are not resolved by choosing the first. Unknown qualifiers are rejected. Remembered identities are not fresh record contents. Records with neither a name nor an owner (reviews, for example) still need their proper domain search.

### Named arguments

The model can submit one action:

```json
{
  "id": "run",
  "kind": "action",
  "action": "M50.A07",
  "argsJson": "{\"reportId\":{\"$lookup\":{\"entity\":\"report\",\"name\":\"Monthly Revenue\"}}}"
}
```

The compiler expands the named argument into an ordinary read-only `resolve` step, followed by the action with a `$lookup_1.id` reference. The existing compiler and executor still validate schemas, dependencies, permissions, state, replay and confirmation. Name lookup needs no extra model round and never uses an arbitrary `items[0]`. Explicit `resolve` steps and ordinary IDs/references still work.

- **Where it works.** Any ID argument, including ones nested in objects and arrays, and calls inside a `forEach`. A fixed name inside a loop resolves once; per-item values still use `$item` references.
- **Which entity.** By default the argument name gives it (`stageId` → stage), with documented aliases such as `assigneeId` → user and `assetId` → media_asset. An action can say more: `idTypes` for an ID named for its role (`keepId` → contact), `typedIds` for a polymorphic ID whose type sits in a sibling argument (`relatedTo.id` typed by `relatedTo.type`), and `argumentLookups` for a child under a parent. The `$lookup` entity must match.
- **A name where an ID belongs.** If the model writes `"stageId": "Negotiation"` and the argument maps to one entity with a resolver and no parent, code looks it up instead of failing.
- **The same name twice.** One call naming the same record twice ("merge the two Sarah Johnsons": `keepId` and `duplicateId`) means two records. The second lookup skips whatever the first found.

### Resolvers and matching

Resolvers live in each module's `resolvers` export and are built from three helpers in [`registry/lookup.ts`](../server/src/registry/lookup.ts):

- **`tableResolver`** for a table with a name or title column, plus optional qualifier fields and parent names.
- **`namedResolver`** for anything that needs custom records, labels or inactive rules.
- **`ownedResolver`** for records that belong to a contact and have no name of their own: invoices, quotes, orders, subscriptions and enrollments. They are named by owner, state, type and number, so "Marco Patel's open invoice", "quote QT-1001" and "the quote" with a contact qualifier all find a record.

Names use the existing matching tiers: exact first, then whole-word/prefix matching. Ambiguity is kept, not resolved by picking the first match. Zero matches fail and dependent actions skip. Multiple usable matches pause for clarification. Inactive records are offered only when nothing active matches, and they are flagged.

**Exact qualifiers.** Both inline `where` and explicit resolve `whereJson` can carry supported exact-match qualifiers: company/email for contacts, directory for listings, productId for prices, courseId for lessons, pipeline/pipelineId for stages, contact for owned records. They filter **before** name ranking. Unknown, empty or non-string qualifiers fail validation instead of being ignored. An earlier string reference can supply a qualifier, e.g. `pipelineId: "$parent.id"`. The prompt lists supported types and qualifier keys from the registry. A qualifier said only in free text is not parsed by code: the planner must put it in `where`.

### Lookup dependencies in retrieval

Retrieval separates `produces` (including create/write actions) from `lookupFor` (read-only discovery of existing records). Discovery comes from typed list outputs, with explicit `entities.lookup` for cases such as exact-name community get. ID-only gets and writes are not discovery tools.

- **Create is not lookup.** A selected create action cannot satisfy a missing discovery dependency.
- **Single versus bulk.** For resolvable named types, built-in resolve is the single-record lookup; bulk requests still get discovery helpers where the catalog has them.
- **One helper per mention.** A name mention adds one get plus one standalone discovery helper, not every cross-module list that returns the entity. Discovery prefers the fewest required inputs before semantic rank: searching contacts does not first need a company or tag ID.
- **Full labels for linking.** Named configuration/content objects need their full label for automatic mention linking; an explicit typed lookup can still use partial-name matching.

### Follow-up identities

The session carries at most 12 `{entity,id,name}` identities seen in successful execution steps. It does not carry raw records, mutable fields or planned-but-unexecuted IDs. They appear in the per-turn `<recent_records>` block and reset with the chat. They are identity hints, not current state; handlers still recheck the record. The model must clarify when a follow-up has several plausible targets.

Tests cover every table resolver against real fixtures, zero and duplicate matches, company/directory/parent qualifiers, ID and entity validation, generated step-ID collisions, permission denial, changed-target approvals and session reset.

Code: [resolver helpers](../server/src/registry/lookup.ts), [argument entities](../server/src/registry/arguments.ts), [lookup lowering](../server/src/core/lookups.ts), [session identities](../server/src/server/records.ts). Tests: [lookup](../server/src/registry/lookup.test.ts), [child lookup](../server/src/core/child-lookups.test.ts).

## 1. Check actual matches before asking identity questions

**What changed.** A clarification names the missing input of an offered action (`missing: { action, argument, argsJson }`) and can carry a typed lookup selector. When a store is available, code validates the qualifiers and checks the resolver before returning a question. Actual duplicates produce options from real records; more than eight matches ask for a narrower name or qualifier. A unique, missing or inactive match gets a grounded replan instead of a question. Asking again about the same unique match fails safely. Lookup itself never changes records or bypasses inactive-user checks.

**Why.** The planner had asked “which partner tag?” when exactly one matched, and “which Dan?” when the matching user was deactivated. The first needs no human identity choice; the second needs an eligibility failure, not an invented ambiguity. Account facts should be checked before asking the user to supply them again.

**Boundary.** Genuine duplicates still need the user. The `clarification` category (identity, content, choice) is only a display label: code routes by the bound argument and its entity, so a model calling “which Sales team?” a business choice no longer skips the check. A model can still ask about the wrong argument, or name a record in a way the resolver can't match.

Code: [identity checks](../server/src/planner/contracts.ts), [clarification checks](../server/src/planner/clarification.ts), [turn handling](../server/src/planner/turn.ts). Tests: [contracts](../server/src/planner/contracts.test.ts), [clarification](../server/src/planner/clarification.test.ts), [turns](../server/src/planner/turn.test.ts).

## 2. Preserve the final requested operation across intermediate reads

**What changed.** Planner replies declare `outcome: {effect, actions, destination}`. `actions` names the final requested catalog operations, not prerequisite reads. The first declared outcome is kept within the turn; an initially empty action list can be filled after discovery. Compilation checks for missing declared operations. A requested change cannot finish with only reads or a prose answer. A read request cannot add writes. A plan that sends when the user asked only for a draft, or only creates a record the user asked to send, goes back for repair.

**Why.** “Find the payment” is not “request the refund”; “list the tasks” is not “reassign the tasks”. Before this, any action call could make a plan look complete, even if it only located records. A stable declared target makes this kind of early stop detectable.

**Boundary.** This checks the model's own declaration. It does not prove the model understood the request, selected every target, used the right filter, or reached the final domain state. It is not an independent task verifier. A wrong first declaration can still cause failures. Saved replies from before the field remain parseable; the wire schema requires it now.

Code: [reply schema](../server/src/planner/submit-plan.ts), [coverage checks](../server/src/planner/contracts.ts), [turn continuation](../server/src/planner/turn.ts). Tests: [contracts](../server/src/planner/contracts.test.ts), [turns](../server/src/planner/turn.test.ts).

## 3. Retrieve the final action and the right lookup dependencies

**What changed.** Module-owned general synonyms join the generated search-card synonyms in both lexical and embedding retrieval. Assignment now describes workload handoff; team membership distinguishes joining an existing team from creating one or changing its manager. Refund requests declare their payment dependency. Task creation declares optional relationships separately, rather than letting generated metadata treat all of them as mandatory. Optional dependencies expand only for relevant typed mentions. The foundation also separates existing-record discovery from creation and prefers standalone lookup helpers.

**Why.** Natural language often describes an outcome, not a catalog label: covering a colleague's work requires assignment, not just task search. Adding every related action, on the other hand, makes the prompt larger and noisier. A create action returning an entity is also not a valid way to discover an existing one. Better metadata and selective dependencies address these problems without replacing the embedding model.

**Boundary.** No scenario sentences were copied into synonyms, no wholesale sibling expansion was added, and no larger embedding model was introduced. Retrieval remains imperfect; seeing a tool does not guarantee the planner uses it correctly.

Code: [card construction](../server/src/retrieval/cards.ts), [retrieval expansion](../server/src/retrieval/retrieve.ts), [tasks](../server/src/modules/m06-tasks/index.ts), [refunds](../server/src/modules/m33-refunds/index.ts), [teams](../server/src/modules/m49-teams/index.ts). Tests: [retrieval](../server/src/retrieval/retrieve.test.ts).

## 4. Compute ordinary weekday dates in code

**What changed.** The dynamic `<now>` block supplies seven precomputed weekday dates. Bare weekdays mean the upcoming occurrence, including today; “next Friday” means the strictly future occurrence. Calculation uses the account's `America/New_York` date. The block snapshots one instant so a midnight rollover cannot make its fields disagree. Weekend rollover and DST are tested.

**Why.** A routine “due Friday” request had stalled on an unnecessary “which Friday?” question. Models should not redo calendar arithmetic when the application already owns the clock. An explicit convention also makes evaluations reproducible.

**Boundary.** This is a documented product convention, not a universal reading of English. Conflicting dates and required-but-unspecified times still need clarification. The client/user timezone does not silently replace the account timezone.

Code and tests: [clock](../server/src/store/clock.ts), [clock tests](../server/src/store/clock.test.ts).

## 5. Filter reminder eligibility before planning sends

**What changed.** Overdue-invoice lookup (`M28.A10`) accepts `notRemindedSince`, an ISO date read from account-local midnight. A reminder on or after that date excludes the invoice. Older reminders and null reminders stay eligible. Filtering happens before pagination. “Skip anyone reminded this week” uses Monday from `<now>`.

**Why.** “Skip anyone reminded this week” had been read as “skip anyone ever reminded”. The difference changes who gets a reminder. A typed query predicate makes the date boundary and null behaviour deterministic instead of asking the model to rebuild eligibility from a list.

**Boundary.** The query only reads. It does not send, grant permission or bypass the 24-hour reminder limit. Send handlers and approval checks still run normally.

Code and tests: [invoices](../server/src/modules/m28-invoices/index.ts), [invoice tests](../server/src/modules/m28-invoices/invoices.test.ts).

## 6. Allow drafting ordinary wording without inventing facts

**What changed.** Shared instructions allow message composition when the user gives its purpose, such as thanking a customer for renewing. They still prohibit invented addresses, amounts, offers, attachments and commitments. Exact prose is asked for only when necessary or when the user wants it.

**Why.** Asking “what should the email say?” after “thank her for renewing” adds work without resolving a missing fact. Choosing polite wording is different from inventing a price or promise. The planner needs that distinction stated clearly.

**Boundary.** This is prompt guidance, not a deterministic fact checker. Delivery eligibility and approval rules are unchanged; composing wording does not authorize an unrequested send.

Code: [shared prompt](../server/src/planner/prompt.ts).

## 7. Check destination support before requesting content

**What changed.** Delivery/publication actions declare a `destination` surface. The registry publishes the supported IDs, labels and action IDs in `<delivery_surfaces>`; they include email, SMS, website, funnel, landing page, blog, community, business listing and review. The planner must keep an unsupported platform's name instead of substituting a similar blog/community action. Code rejects an unlisted declared destination before asking content questions or running reads, and checks plans against annotated delivery actions.

**Why.** A request to publish on an unsupported platform had triggered a question about the post's content. Collecting content cannot make that destination available. Similar verbs such as “publish” must not silently substitute a blog, community or business listing for the requested platform.

**Boundary.** This is capability metadata, not a platform blacklist or a new integration. The model must still declare the intended destination correctly. Simulated directory publishing remains simulated.

Code: [action metadata](../server/src/registry/define.ts), [registry surfaces](../server/src/registry/registry.ts), [prompt](../server/src/planner/prompt.ts), [turn checks](../server/src/planner/turn.ts). Tests: [contracts](../server/src/planner/contracts.test.ts), [turns](../server/src/planner/turn.test.ts).

## Two corrections found during validation

**Bookkeeping is not the same as a user-facing change.** Report execution updates its last-run timestamp; trigger testing records a test firing without starting a workflow. The first read-outcome guard wrongly rejected them. They now declare `query: true`, so that check recognizes them without lowering execution risk or permissions. Registry validation forbids the flag on external/destructive actions. Other simulated business submissions are not queries. A `look` round still accepts only actions whose execution risk is `read`.

**Round-robin items do not have a universal ID field.** The prompt had suggested `$rr.userId` for every list. It now says to follow the actual item schema: a User has `$rr.id`; some team summaries have `$rr.userId`. The reserved bindings `item` and `rr` cannot be step IDs. This removes contradictory guidance rather than relaxing reference validation.

## Planner call budget

A turn makes at most **8 planner calls**, within **180 seconds** across all of them (`MAX_PLANNER_CALLS` and `TURN_DEADLINE_MS` in [turn.ts](../server/src/planner/turn.ts)), and none once the client has gone away. Inside that, each kind of extra round has its own small allowance:

- **Search.** Up to two `search_tools` rounds. The second comes with a note that matching or de-duplicating lists is done with ops, not an action.
- **Look.** Up to two read-only look rounds. Asking for a third gets one nudge to plan with what was read.
- **Plan repair.** One round of compile or outcome errors fed back, and a second only if the first left fewer errors.
- **Clarification repair.** One repair of a malformed or unbound clarification, kept separate so it can't use up the plan's repair.
- **Identity check.** A grounded replan after a lookup answers the identity question. A second is allowed only for a different name.
- **Bad JSON.** An unparseable reply is asked for once more per turn.
- **One-off checks.** One round each for a plan that remakes what the last turn made, for a change whose filter steps are read back in plain words to check the picked records (the selection check), and for a change whose target list was already read as empty.

A spent budget ends the turn with a reply. No retry sends or writes on its own, and genuine business choices stay with the user.

## What deliberately did not change

- The existing catalog IDs, executor, handler permissions, confirmation/subset-approval rules, transaction rollback and replay protections remain in use.
- No new provider-specific execution path, global permission retrofit or automatic prerequisite writes were added.
- The embedding model and ranking settings were not replaced.
- Seed data, scenario assertions, retrieval questions and frozen reporting definitions were not changed to improve scores.

## What the evidence supports

These changes were built and checked checkpoint by checkpoint on development branches, mostly with Codex models; those reports are in git history, and [the journey](JOURNEY.md) keeps the sequence. The current measurement is [BENCHMARK.md](../BENCHMARK.md): 273 scenarios × 3 on DeepSeek, with every failing run listed. Inspected regression and development cases are not an untouched holdout. Deterministic tests show the plumbing works; they don't show a success-rate change.
