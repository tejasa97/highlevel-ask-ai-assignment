# Shared planner changes: what changed and why

Branch: `codex/planner-outcomes-and-retrieval`. This branch was created at `d583fb3`, retaining the existing lookup, retrieval, outcome-handling and validation commits. Creating the branch did not rebase onto main, squash history, change providers or rerun benchmarks. The original batch through `57a6d59` was subsequently pushed on request.

The follow-on [scoped child lookup and argument-bound clarification batch](SCOPED-LOOKUPS-AND-CLARIFICATIONS.md) extends the historical foundation and section 1 below. Those original measurements and limitations remain checkpoint-specific; the follow-on has separate validation.

This is the rationale and reading guide. [Lookup implementation](PLANNER-RECORD-LOOKUPS.md) and [outcome implementation](PLANNER-OUTCOMES.md) describe the mechanics; their separate validation reports record the measurements and limitations.

## The problem we were trying to solve

Retrieving a relevant action is only the first part of completing a request. The model must also find the right records, pass valid IDs, preserve qualifiers, use the right dates, finish the requested operation and respect approvals. Several failures happened **after the correct action was already offered**. A stronger embedding model would not, by itself, fix those failures.

The design choice was therefore to improve the shared interface and move deterministic work into code. Models still interpret requests and compose plans. Code handles known lookup rules, calendar arithmetic, eligibility filtering and checks on the declared plan. These changes apply to every provider using this planner, not only Luna. That is an architectural property, not evidence that every model's success rate has improved.

## Foundation: consistent record lookup

This was implemented before the seven follow-on improvements and is retained on this branch.

**What changed.** Module-owned resolvers cover 39 entity types. An ID argument can contain a typed `$lookup` with a name and supported exact qualifiers. The compiler turns it into the existing resolve-and-action steps. The session remembers up to 12 observed `{entity,id,name}` identities for follow-ups. Generated lookup IDs survive read/replan rounds.

**Why.** Asking the model to invent an ID or construct a long search/reference chain creates avoidable failure points. A person's name is not a ticket title; a business name may identify several directories; a stage belongs to a particular pipeline. Lookup must preserve those distinctions before selecting a record.

**Boundary.** Multiple matches are not resolved by choosing the first. Unknown qualifiers are rejected. Remembered identities are not fresh record contents. Nested child selection, such as form field IDs and community channel IDs, is not generally solved by top-level named lookup.

Code: [resolver helpers](../server/src/registry/lookup.ts), [lookup lowering](../server/src/core/lookups.ts), [session identities](../server/src/server/records.ts). Details and evidence: [lookup notes](PLANNER-RECORD-LOOKUPS.md), [lookup validation](PLANNER-RECORD-LOOKUPS-VALIDATION.md).

## 1. Check actual matches before asking identity questions

**What changed.** Clarifications have a category. An identity clarification supplies a typed lookup selector. When a store is available, code validates its qualifiers and checks the resolver before returning a question. Actual duplicates produce grounded options. Unique, missing or inactive matches get at most one extra planner round; repeated invalid/unique-match questions fail safely. Corrected selectors are checked again without another model retry.

**Why.** The planner had asked “which partner tag?” when exactly one matched, and “which Dan?” when the matching user was deactivated. The first needs no human identity choice; the second needs an eligibility failure, not an invented ambiguity. Account facts should be checked before asking the user to supply them again.

**Boundary.** Genuine duplicates still need the user. A model can misclassify an identity question as a business/content choice and miss this path; the live Sales-team failure demonstrates that limitation.

Code: [identity checks](../server/src/planner/contracts.ts), [bounded turn handling](../server/src/planner/turn.ts). Tests: [contracts](../server/src/planner/contracts.test.ts), [turns](../server/src/planner/turn.test.ts).

## 2. Preserve the final requested operation across intermediate reads

**What changed.** New planner replies declare `outcome: {effect, actions, destination}`. `actions` names the final requested catalog operations, not prerequisite reads. The first declared outcome is retained within the turn; an initially empty action list can be filled after discovery. Compilation checks for missing declared operations. A requested change cannot finish with only reads or a prose answer. Repair uses the existing bounded budget.

**Why.** “Find the payment” is not “request the refund”; “list the tasks” is not “reassign the tasks”. Previously, any action call could make a plan appear complete, even if it only located records. Keeping a stable declared target makes this kind of premature stop detectable.

**Boundary.** This checks the model's own declaration. It does not independently prove that the model understood the request, selected every target, used the correct filter, or reached the final domain state. Wrong initial declarations can still cause failures. Historical saved replies remain parseable without the new fields; the new wire schema requires them.

Code: [reply schema](../server/src/planner/submit-plan.ts), [coverage checks](../server/src/planner/contracts.ts), [turn continuation](../server/src/planner/turn.ts). Tests: [contracts](../server/src/planner/contracts.test.ts), [turns](../server/src/planner/turn.test.ts).

## 3. Retrieve the final action and the right lookup dependencies

**What changed.** Module-owned general synonyms join the generated search-card synonyms in both lexical and embedding retrieval. Assignment now describes workload handoff; team membership distinguishes joining an existing team from creating one or changing its manager. Refund requests declare their payment dependency. Task creation declares optional relationships separately, rather than letting generated metadata treat all of them as mandatory. Optional dependencies expand only for relevant typed mentions. The foundation also distinguishes existing-record discovery from creation and prefers standalone lookup helpers.

**Why.** Natural language often describes an outcome, not a catalog label: covering a colleague's work requires assignment, not just task search. Conversely, adding every related action makes the prompt larger and noisier. A create action returning an entity is also not a valid way to discover an existing one. Better metadata and selective dependencies address these problems without replacing the embedding model.

**Boundary.** No scenario sentences were copied into synonyms, no wholesale sibling expansion was added, and no larger embedding model was introduced. Retrieval remains imperfect; seeing a tool does not guarantee the planner uses it correctly.

Code: [card construction](../server/src/retrieval/cards.ts), [retrieval expansion](../server/src/retrieval/retrieve.ts), [tasks](../server/src/modules/m06-tasks/index.ts), [refunds](../server/src/modules/m33-refunds/index.ts), [teams](../server/src/modules/m49-teams/index.ts). Tests: [retrieval](../server/src/retrieval/retrieve.test.ts).

## 4. Compute ordinary weekday dates in code

**What changed.** The dynamic `<now>` block supplies seven precomputed weekday dates. Bare weekdays mean the upcoming occurrence, including today; “next Friday” means the strictly future occurrence. Calculation uses the account's `America/New_York` date. The block snapshots one instant so a midnight rollover cannot make its fields disagree.

**Why.** A routine “due Friday” request had stalled on an unnecessary “which Friday?” question. Models should not repeatedly do calendar arithmetic when the application already owns the clock. An explicit convention also makes evaluations reproducible.

**Boundary.** This is a documented product convention, not a universal interpretation of English. Conflicting dates and required-but-unspecified times still need clarification. The client/user timezone does not silently replace the account timezone.

Code and tests: [clock](../server/src/store/clock.ts), [clock tests](../server/src/store/clock.test.ts).

## 5. Filter reminder eligibility before planning sends

**What changed.** Overdue-invoice lookup (`M28.A10`) accepts `notRemindedSince`, an ISO date interpreted from account-local midnight. A reminder on or after that date excludes the invoice. Older reminders and null reminders remain eligible. Filtering happens before pagination.

**Why.** “Skip anyone reminded this week” had been interpreted as “skip anyone ever reminded”. The distinction changes who receives a reminder. A typed query predicate makes the date boundary and null behavior deterministic instead of asking the model to reconstruct eligibility from a list.

**Boundary.** The query only reads. It does not send, grant permission or bypass the existing 24-hour reminder limit. Send handlers and approval checks still run normally.

Code and tests: [invoices](../server/src/modules/m28-invoices/index.ts), [invoice tests](../server/src/modules/m28-invoices/invoices.test.ts).

## 6. Allow drafting ordinary wording without inventing facts

**What changed.** Shared instructions allow message composition when the user provides its purpose, such as thanking a customer for renewing. They continue to prohibit invented addresses, amounts, offers, attachments and commitments. Exact prose is requested when necessary or explicitly requested by the user.

**Why.** Asking “what should the email say?” after “thank her for renewing” adds work without resolving a missing fact. Choosing polite wording is different from inventing a price or promise. The planner needs that distinction stated clearly.

**Boundary.** This is prompt guidance, not a deterministic factuality checker. Delivery eligibility and applicable approval rules remain unchanged; composing wording does not authorize an otherwise unrequested send.

Code: [shared prompt](../server/src/planner/prompt.ts). Live behavior and caveats: [validation](PLANNER-OUTCOMES-VALIDATION.md).

## 7. Check destination support before requesting content

**What changed.** Delivery/publication actions declare a destination surface. The registry exposes supported surfaces to the planner. Code rejects an unlisted declared destination before asking content questions or running reads, and checks plans for conflicts with annotated delivery actions.

**Why.** A request to publish on an unsupported platform had triggered a question about the post's content. Collecting content cannot make that destination available. Similar verbs such as “publish” must not silently substitute a blog, community or business listing for the requested platform.

**Boundary.** This is capability metadata, not a platform-specific blacklist or a new integration. The model must still declare the intended destination correctly. Simulated directory publishing remains simulated.

Code: [action metadata](../server/src/registry/define.ts), [registry surfaces](../server/src/registry/registry.ts), [prompt](../server/src/planner/prompt.ts), [turn checks](../server/src/planner/turn.ts). Tests: [contracts](../server/src/planner/contracts.test.ts), [turns](../server/src/planner/turn.test.ts).

## Two corrections found during validation

**Bookkeeping is not the same as a user-facing change.** Report execution updates its last-run timestamp; trigger testing records a test result without starting a workflow. The initial read-outcome guard wrongly rejected them. They now declare `query: true`, allowing that quality check to recognize them without lowering execution risk or permissions. External/destructive actions cannot use this metadata. Other simulated business submissions are not automatically queries. A `look` round still accepts only actions whose execution risk is `read`.

**Round-robin items do not have a universal ID field.** The prompt incorrectly suggested `$rr.userId` for every list. It now says to follow the actual item schema: a User has `$rr.id`; some team summaries have `$rr.userId`. The reserved bindings `item` and `rr` cannot be used as step IDs. This removes contradictory interface guidance rather than relaxing reference validation.

## What deliberately did not change

- The existing catalog IDs, executor, handler permissions, confirmation/subset-approval rules, transaction rollback and replay protections remain in use.
- No new provider-specific execution path, global permission retrofit or automatic prerequisite writes were added.
- The embedding model and ranking settings were not replaced.
- Seed data, scenario assertions, retrieval questions and frozen reporting definitions were not changed to improve scores.
- No unlimited retry loop: a turn has at most one search, one read/replan, one repair and one extra identity-check replan—five planner calls maximum.

## What the evidence supports

At final source `abe136b`, 2,323 deterministic tests, typecheck and the web build passed. Combined retrieval recall was 97.6%, with 21.8 final cards on average. At checkpoint `10ee277`, complete Luna runs passed 21/23 older cases and 70/75 coverage cases, with no provider errors. The final trigger-query correction subsequently passed a selected three-case diagnostic; the complete suites were not rerun after it. This is not a substituted 71/75 result.

Earlier repeated runs also had upstream provider failures and application failures. They are preserved, not hidden by later retries. The consistency/merge gate is not cleared, and inspected regression/development cases are not an untouched holdout. See [all outcome measurements and remaining gaps](PLANNER-OUTCOMES-VALIDATION.md) for exact checkpoints and test conditions; see [the journey](JOURNEY.md) for the historical sequence.
