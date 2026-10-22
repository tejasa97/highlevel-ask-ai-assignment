# M45–M47: complete implementation scope

Date: 22 October 2026
Status: thirty actions implemented on the worktree branch; deterministic, persistence, HTTP and retrieval checks pass. Repeated real-planner evaluation remains pending after a provider quota stop. See M45-M47-VERIFICATION.md for current evidence and unmet gates.
Base: main at 3d4588d (also origin/main when checked).
Branch: codex/m45-m47-complete, in a separate managed worktree.

## Commitment

Build Reviews, Business Listings and Support Tickets to the same functional and integration standard as the existing implemented modules. Thirty handlers alone are not completion. Each action must be usable through the real conversation path, searchable, validated, stateful, observable, tested and documented.

Use the existing registry, executor, SQLite store, clock, confirmation system, audit log, fault injection, summary generator and evaluation runner. Extend shared infrastructure only where these modules require it. Existing planner/provider work stays with its current owners. This note does not claim those separate production gaps are solved.

## Exact catalog coverage

Keep the existing catalog IDs and names, exactly ten per module. Enrich argument/output schemas and descriptions as needed; do not replace the catalog with generic CRUD actions or add uncatalogued actions for convenience.

| ID | Action |
|---|---|
| M45.A01 | Create review request |
| M45.A02 | Send review request |
| M45.A03 | Cancel unsent review request |
| M45.A04 | List review requests |
| M45.A05 | Record simulated customer review |
| M45.A06 | Search reviews |
| M45.A07 | Get review details |
| M45.A08 | Draft review response |
| M45.A09 | Publish review response |
| M45.A10 | Get review rating summary |
| M46.A01 | Create business listing |
| M46.A02 | Get listing details |
| M46.A03 | Search business listings |
| M46.A04 | Update listing name |
| M46.A05 | Update listing address |
| M46.A06 | Update listing phone |
| M46.A07 | Set listing business hours |
| M46.A08 | Set listing categories |
| M46.A09 | Publish listing to simulated directory |
| M46.A10 | Get listing sync status |
| M47.A01 | Create support ticket |
| M47.A02 | Get ticket details |
| M47.A03 | Search tickets |
| M47.A04 | Assign ticket owner |
| M47.A05 | Set ticket priority |
| M47.A06 | Update ticket status |
| M47.A07 | Add internal ticket note |
| M47.A08 | Reply to ticket requester |
| M47.A09 | Link ticket to contact |
| M47.A10 | Get ticket SLA status |

## Required for every action

- Register through the normal module loader; source the display name from the catalog.
- Define strict Zod inputs and validated outputs, useful field descriptions, optional/required values, enums and record references. Reject invented parameters and invalid values.
- Provide a concrete handler with meaningful persistent results. Searches return useful records, filters, deterministic ordering, capped items and accurate totals.
- Implement domain rules, duplicate/no-op handling and allowed state transitions. Throw the project's typed errors with useful messages; do not return success unconditionally.
- Define read/write/destructive/external risk explicitly. Use existing approval gates for applicable actions and bulk changes.
- Apply and test permissions appropriate to the domain. Extend the role-to-permission map explicitly if needed; distinguish permission to act from whether an assigned owner is usable.
- Declare produced/consumed entities and relevant sibling actions. Give the planner the correct compact input/output signature automatically through the registry.
- Supply a valid smoke-test example using fixtures. Exercise success, unknown parameters and unknown record IDs where applicable, supplementing the generic smoke test for additional references and optional IDs.
- Use the shared invocation path so audit entries, injected failures, handler traces and output validation behave consistently.
- Verify transactions, approval resume and write deduplication for representative workflows using these new handlers. Do not build a second execution system.

## Domain behavior

### Permissions

- Add `tickets.manage` to support, manager and admin; add `reputation.manage` to marketing, manager and admin. Other roles do not receive these permissions implicitly.
- Match the existing selective permission pattern: do not introduce blanket checks on reads or ordinary internal writes. Require module permission for external and destructive operations. Applying permission checks to all reads/writes across the 50 modules is separate work; this guide must not imply that it already exists.
- For this batch, sending a review request requires reputation.manage plus messaging.send; replying to a ticket requester requires tickets.manage plus messaging.send. This two-permission rule is an explicit convention for new module-specific customer sends; legacy invoice sends retain their existing checks. The guide must distinguish this new convention from legacy behavior.
- Cancelling an unsent review request is classified destructive and requires reputation.manage. It remains subject to confirmation. Internal ticket status/priority/owner/link/note writes do not acquire a new module-permission gate in this batch; owner eligibility is still validated independently.
- Publishing a review response or listing requires `reputation.manage`, not `messaging.send`: publication is external but is not a direct customer message. Both still require the executor's external-action confirmation.
- Permission-gated operations reject deactivated actors through the existing helper. Permission failures must leave domain state and the write audit unchanged. Test each permitted role and representative denied roles. Do not claim ordinary legacy-style reads/writes gain a global active-actor check.

### Reviews

Persist review requests, customer reviews and response draft/publication state, with contact relationships and timestamps. Request states are draft, sent, cancelled and fulfilled. A draft may be sent or cancelled; only a sent request can be fulfilled by a recorded review; sent/fulfilled requests cannot be cancelled. Repeat sends, cancellation and publication are rejected as conflicts. A request can have at most one recorded review; a contact may have multiple requests and independent reviews over time. Validate integer ratings 1–5 and non-empty content. Compute rating summaries from stored reviews, including an explicit empty-data result.

Sending requests and publishing responses are simulated external actions requiring confirmation. Review requests use email kind review_request and follow the existing marketing-email reachability, DND and opt-out checks. Persist delivery outcomes using the existing simulated messaging behavior. Internal drafts must remain distinct from public responses. Drafting uses the supplied response text and adds no separate LLM call.

Reviews have no unique natural-language name. Locate them using contact/reviewer, date, rating and content, with clarification if multiple records remain. A contact's name alone must not acquire a review entity mention. Record-review input can reference a sent request (deriving its contact) or explicitly identify the contact for an independent review; conflicting contact/request inputs are invalid. Tests cover repeated reviewers, repeated requests, duplicate fulfillment and unknown contacts.

### Business Listings

Persist listing identity, directory, address, phone, categories, hours and publication/sync state. Duplicate identity is normalized business name plus normalized address plus directory; the same business on different directories is valid, as are different branches at different addresses. Recheck duplicate identity on name/address changes. A listing lookup by business name can yield several directories or addresses: ask which directory/location rather than choosing one silently.

Use a weekly schedule with one opening/closing interval per day or an explicit closed day; opening must precede closing. Overnight and split shifts are rejected with an explicit limitation. Use the app's America/New_York timezone. Updates affect stored data and distinguish pending changes from the last published state. Duplicate-free updates that change nothing return a conflict.

Publishing is simulated and confirmation-gated. Sync status must be derived from the stored publication outcome and any later changes. Exercise success and injected directory failure; never present a simulated publication as an actual external listing.

### Support Tickets

Persist requester/contact links, title/body, owner, priority, status, internal notes, replies and relevant timestamps. Priorities are low, normal, high and urgent; default normal. Assigned owners must be active, available users with tickets.manage. Resolve tickets by title or explicit ticket reference, with contact as a qualifier; a person's name alone must not name their ticket.

Allowed status changes (same-status requests are conflicts):

| From | Allowed destinations |
|---|---|
| open | in_progress, resolved, closed |
| in_progress | open, resolved, closed |
| resolved | open, closed |
| closed | open |

Resolved and closed tickets must be reopened before replying or changing owner, priority or contact link. Internal notes may be appended in any status, remain internal, and do not reopen a ticket. A successful requester reply moves open to in_progress; in_progress remains in_progress. A failed reply leaves status and response timestamps unchanged. Reopening clears active resolution/closure timestamps while history records prior transitions.

Replies are simulated external actions requiring confirmation plus tickets.manage and messaging.send. Use email kind ticket_reply. Use the requester's explicit email or linked contact consistently and reject conflicting identity/address inputs; use existing transactional-email delivery rules. Reuse messaging behavior rather than implementing another transport. Validate contact links and distinguish internal notes from requester-visible replies.

Get ticket SLA status explicitly reports `policy: first_response`, `timeBasis: elapsed`, the priority target, createdAt, dueAt, firstResponseAt, evaluatedAt and pending/met/breached status. It does not claim to measure resolution SLA. Targets are urgent 1 hour, high 4 hours, normal 24 hours, low 72 hours from ticket creation. Internal notes, automated acknowledgements, failed sends, resolution and closure do not count as a first response. Automated acknowledgements are not implemented or sent by this simulator; do not add an acknowledgement feature. Only the first successfully delivered human requester reply stops this clock; exactly at dueAt meets the target, while unanswered tickets breach strictly after dueAt. Closing without replying does not waive the SLA. Reopening never resets the original clock or first response.

Priority changes before the first reply recalculate dueAt from original createdAt; persist/freeze the deadline used when the first response succeeds, so later changes do not rewrite its SLA result. Arithmetic uses elapsed UTC durations, so the 1 November America/New_York clock change does not add or remove an SLA hour. Test before/at/after deadlines, priority changes, failed replies, reopening and the DST boundary. Document this as the simulator's policy, not HighLevel's actual SLA rules.

## Shared email changes

The existing EMAIL_KINDS contains only general, invoice, invoice_reminder and campaign. Extend it with review_request and ticket_reply, and update the email module's descriptions, preview/search schemas, transactional-kind classification, fixture support and relevant tests. Review requests are marketing: missing address, DND, disabled email and opt-out block them. Ticket replies are transactional under the existing simulator policy: a valid reachable recipient is required, but marketing opt-out/DND preferences are bypassed as for existing invoice emails. Document and test this simulator rule explicitly.

Preserve existing email behavior for all old kinds. New modules reuse existing delivery/conversation helpers and keep a link to the originating request/ticket in their own records. M13.A03 (send) and M13.A04 (schedule) must refuse stored emails of kind review_request or ticket_reply, even for an authorized actor, with an actionable typed error naming Send review request (M45.A02) or Reply to ticket requester (M47.A08). Check before delivery, scheduling or other mutations. Adding permission checks in M13 is insufficient: those routes would still bypass request status transitions, ticket state and first-response SLA updates. Each owning module's action is the only supported send path and commits its domain updates and email effects together through the existing transaction. Preview/get/search remain available. Tests verify both kinds are refused by both generic entry points without state, audit, conversation or SLA changes; the owning actions must produce all expected side effects. Keep these narrow shared-code changes in a distinct integration commit. No new transport or provider is required.

M13.A02 preview must agree with generic send/schedule: for review_request and ticket_reply return canSend: false and a routing blocker naming M45.A02 or M47.A08 respectively. Include any other relevant blockers, and make clear that this is a restriction on the generic email route, not a claim that the owning module can never send it. Test both kinds through preview, send and schedule so a positive generic preview cannot contradict the later refusal.

Transactional consent bypass must never bypass reachability. Add a ticket-reply test for an otherwise usable linked contact with no email address and no explicitly supplied valid requester address: the owning action must fail before delivery, leaving the ticket status, firstResponseAt, SLA result, conversation and write audit unchanged. Test the existing helper's address-before-transactional ordering directly where appropriate. Also verify a valid-address contact with marketing opt-out/DND can receive a transactional reply, while an equivalent review request remains blocked.

## Cross-module workflows and action overlaps

Add scenarios for these chains, asserting exact target records, selected actions and final state:

- Completed appointments this week → linked contacts → review requests, deduplicating contacts with more than one completed appointment; send only after confirmation and apply consent rules.
- Contacts with an overdue invoice and an inbound reply in the last seven days → one support ticket per matching contact, even if several invoices/messages match. Use checkable timestamps and direction, not sentiment or an undefined anger classifier.
- Resolve Sarah's specific ticket → requester reply → follow-up task assigned to an eligible user; test confirmation, task arguments and a declined send.

Measure these confusing action pairs explicitly, including negative assertions that the wrong action did not run:

- Ticket requester reply versus SMS send, email send and conversation reply.
- Internal ticket note versus a note attached to a contact.
- Ticket owner assignment versus task/contact owner assignment.
- Review response publication versus listing publication.

Sibling links are selective, not an all-to-all expansion. Test candidate links on development queries and report recall plus average/maximum final shortlist size and prompt size before/after. Preserve changes only when their selection benefit justifies the added candidates.

## Data, names and retrieval

- Add schema-validated fixture builders for review requests, reviews, listings and tickets. Fixtures must support happy paths, invalid states, duplicates, failures and ambiguous names.
- Before module implementation, freeze a declarative manifest of the proposed new seed records, their explicit IDs, relationships and timestamps together with development/reporting scenario definitions and expected record references. This manifest fixes the test data without requiring working handlers or fixture builders first. When schemas, fixtures and seed loading are implemented, verify that they reproduce the manifest's records/IDs and preserve existing IDs; do not discover or alter reporting targets from planner outputs. Freeze any additional reporting-specific setup records and their IDs too.
- Append reproducible seed records without changing existing seeded IDs or random draws. Include enough variety for searches, summaries, sync states and SLA examples to be meaningful. Fresh reset and persistent dev-store behavior must work.
- Keep ordinary new seed names clear of names relied on by the existing 23 regression scenarios. Put deliberate name collisions in isolated fixtures and test them explicitly, including one business on multiple directories and one contact with multiple reviews/tickets.
- Add name resolvers where records have a useful natural-language identity. Test exact/partial matches, ambiguity and inactive records. Avoid a contact's name alone accidentally being interpreted as a ticket or review; existing appointment fixes demonstrate this risk.
- Review all 30 existing search cards against their implemented handlers. Correct description, synonyms, entity dependencies and siblings as needed. Keep the search-card catalog at 500; implementation changes availability rather than creating duplicate cards.
- Verify BM25 and real local-embedding retrieval, direct language, paraphrases, multi-intent requests and follow-ups. Ensure changed card text refreshes vector caches through the existing mechanism.
- Keep evaluation questions out of the card generator and preserve an untouched reporting split. Report final shortlist size alongside recall because dependency additions can exceed fifteen cards.

## Conversation and UI integration

- Exercise the normal Conversation → retrieval → planner → compile → execute → summarize path, including use in a read-only look when relevant.
- Verify passing results between steps, list filtering, exclusions, forEach and carried actions in follow-ups.
- Test missing details and ambiguous entities through the existing clarification path. Do not claim that saved-plan clarification resumption is implemented globally.
- Confirm approval preview, approve/cancel behavior, changed targets and resume work for new external/destructive/bulk workflows.
- Ensure summaries correctly name these records and show useful results, empty searches, failures and partial success without exposing raw IDs as the primary answer.
- Verify streamed progress, action traces, audit entries, database diffs and records in the existing web data browser. Update module labels/counts and add representative UI examples where appropriate. This does not require three new management screens.

## Verification and measurement

### Scenario folders and runner support

- Preserve eval/scenarios/ unchanged as the existing 23-scenario regression suite and default runner input.
- Put the new sets outside that folder: eval/module-scenarios/m45-m47/development/ and eval/module-scenarios/m45-m47/reporting/. Merely running the default command must not load either new folder.
- Add a small --scenario-dir option, resolving relative paths from repository root and accepting an explicit absolute path. It selects exactly one directory; no recursive folder merging. Examples from server/: npm run eval:scenarios -- --scenario-dir eval/module-scenarios/m45-m47/development --repeat 3 --label m45-m47-dev; use the reporting directory only for final measurement.
- Record the chosen repository-relative directory and content fingerprint in result metadata/history. Preserve existing default-suite fingerprint calculation. Test default selection, explicit selection, missing/empty directories and that default/development runs never load reporting files.
- The scenario fingerprint covers scenario definitions only, not seed data. Adding new seeded records intentionally leaves the original 23-scenario fingerprint unchanged, while changing the database the scenarios run against. The JOURNEY entry and before/after comparison must explicitly disclose that seed data changed, identify the measured code commits, and describe the append-only seed additions and preserved old IDs. A matching scenario fingerprint is not a claim that the starting databases were identical. Do not change the fingerprint algorithm to hide this distinction; rerunning the original scenarios against the expanded data is the intended regression check.
- Plan 45 development scenarios: 30 primarily exercise one catalog action each; 15 add cross-module chains, paraphrases, confusing actions, follow-ups, ambiguity, unsupported requests, permission/consent failures, declined confirmation and partial failures. Cases can overlap categories but coverage must be explicit.
- Plan 12 additional reporting scenarios (roughly four per new module), written and frozen together with the new seed/setup manifest and record IDs before module implementation or planner results, including multi-module combinations and unseen phrasings. Validate the manifest against the implemented seed loader before running them. If schema integration requires a correction, record and refreeze the affected manifest/scenarios before any reporting execution; disclose the correction rather than claiming the earlier frozen version was evaluated. Every action is covered by development cases; 12 reporting cases are a limited generalization check, not comprehensive statistical proof.
- Update trajectory.ts, not just its annotations: group scenario histories by canonical scenario folder and draw a separate labeled line for each folder. Interleaved old-suite, development and reporting runs must not become points on one connected line. Preserve fingerprint-change breaks within a folder, as well as existing provider/tier, reverted-run and infrastructure caveats. Label the folder in tooltips and the results table; separate folder-based latency/cost series too, wherever currently drawn from the combined scenario list.
- Keep the original eval/scenarios/ suite as the headline scenario-pass tile, using its eligible runs under the existing repeat/measurement rules. A later development or reporting run must not replace that headline or silently switch its planner/tier selection. Treat historical scenario entries without folder metadata as eval/scenarios/; do not rewrite their set fingerprints. If there is no eligible original-suite run, show that fact instead of falling back to another folder.
- Add trajectory regression tests with interleaved folders, legacy entries without folder metadata, changed fingerprints within one folder, different provider/tier runs and reverted runs. Assert independent series and original-suite headline selection. Rebuild and visually verify the page. Directory selection and trajectory separation belong to this batch; changing scoring/cost formulas remains separate work.

1. Record the base commit, initial existing-suite results and evaluation settings. Freeze new seed/setup records and their IDs together with the development/reporting scenario definitions before module implementation, then validate faithful loading before evaluations.
2. Add meaningful unit tests covering every action and its domain invariants. Add the three modules to the explicit ten-actions-per-module gate. All 180 registered actions must pass the shared smoke suite after integration.
3. Add natural-language scenarios whose combined expected-action coverage includes all 30 actions. Include direct, indirect, multi-step, follow-up, ambiguous, unsupported and injected-failure cases across the batch, plus declined confirmation and partial failure cases.
4. Assert final SQL state and actual call arguments, not just plan shape or reply wording. Include negative assertions proving wrong records were untouched and declined sends/publications did not happen.
5. Run typecheck, the full deterministic suite, retrieval evaluations and browser verification of representative new workflows.
6. Run new real-planner scenarios three times, and rerun the original unchanged scenario set separately as a regression comparison. The original 23 are a regression suite, not a holdout: they already informed fixes. Use fingerprints so results from an expanded suite are never presented as a direct comparison with the old percentage. Investigate every newly failing scenario or loss of consistency, even if it passes once; a pass in one of three runs is not proof of no regression.
7. Before module changes or new evaluation runs, freeze separate development and reporting scenario files, their fingerprints and the matching seed/setup manifest with IDs. Keep reporting cases out of prompt/card/handler tuning. Record the seed manifest version separately; the scenario fingerprint still covers scenario definitions only. Once reporting outcomes are inspected, do not tune against those cases and continue calling them untouched; record exposure and use a fresh reporting set for subsequent claims.
8. Acceptance gates: all deterministic tests pass; all 30 actions have smoke, unit and expected-action scenario coverage; no unresolved new deterministic regression or systematic old-suite failure; every deterioration in the original suite is investigated and reported. Target 100% on direct happy-path development scenarios and at least 95% on the full new development scenario runs, with 100% deterministic approval/permission/rollback invariants. Failure to meet a target remains visible in the report. Use the runner's existing measurements for action selection, arguments, state, latency, calls, tokens and cost. Changes to cost formulas, provider accounting, cost-per-success calculation or benchmark methodology belong to a separate change, not this module batch.
9. Compare existing behavior before/after on the same scenarios; a new ReAct baseline or new provider adapter remains separate project work. New modules should be usable by the existing provider interface without provider-specific handler logic.

## Documentation and delivery

- Update README scope, implemented-module counts, setup/reset/use instructions, examples, card-review status and simulated-versus-real behavior.
- Document module-specific rules: review-request consent, listing sync semantics and the chosen ticket SLA policy.
- Write a short how-to-add-a-module guide from the completed batch: file layout, registration, schemas, permissions, IDs, fixture and append-only seed patterns, resolver pitfalls, smoke/domain/scenario test shape, card review, evaluation fingerprints and the completion checklist. Use it as the pattern for the next 32 modules.
- Add JOURNEY entries with the problem, changes, rationale, measured results, costs and side effects. Record labeled runs in the existing history and rebuild/verify the trajectory page.
- Explicitly disclose that the original regression scenario definitions/fingerprint are unchanged but the seeded starting database has expanded. Describe additions and compare the measured commits; do not describe equal scenario fingerprints as identical data.
- Keep result files, scenario definitions and reproduction commands consistent with the measured commit and dataset fingerprint.
- Deliver on codex/m45-m47-complete in the new managed worktree based on main at 3d4588d. The parent repository folder name in the managed path ends in highlevel-ask-ai-qwen, but its starting commit is main, not qwen-planner. Use reviewable commits by module and integration step; shared fixtures, seed, permissions and tests require careful integration with concurrent work. Do not push without the user's explicit instruction.

## Definition of done

All 30 catalog actions are implemented and reviewed; the registry reports 180 executable actions; fixtures/reset and persistent storage work; all 180 actions pass smoke tests; domain and execution tests pass; retrieval and UI integration are verified; repeated end-to-end results and remaining limitations are recorded; README, JOURNEY and trajectory reflect the delivered code. Any unmet gate is reported explicitly, not described as completed.

The contract was prepared against the existing registry/action contract, module tests, smoke suite, retrieval-card builder, conversation controller, shared clock, fixtures/test helpers, scenario runner and role-permission definitions in main. Its implementation status is recorded separately; the contract's acceptance gates have not been weakened to match incomplete evaluations.
