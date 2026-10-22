# M45–M47 delivery and Codex evaluation

22 October 2026. Branch `codex/m45-m47-complete`, based on main `3d4588d`. No push or merge to main. This report supersedes the earlier verification checkpoint's pending/quota status.

## Outcome

All thirty catalog actions are implemented, integrated and deterministically verified. **795 backend tests pass**, no skips/failures; TypeScript and the production web build pass. The registry has 180 executable actions. However, **AI acceptance is not met**: GPT-6.1 Sol improves repeated module-development success from Luna's 85.2% to 91.9%, still below the 95% target, and direct happy paths are not 100%. Do not describe the entire acceptance contract as complete.

## Implementation delivered

- Reviews: strict request/review schemas, draft/send/cancel/fulfil transitions, marketing consent, independent/repeated reviews, private/public response state and rating summaries.
- Listings: normalized business/location/directory identity, directory ambiguity, seven-day validated hours, category/phone/address/name changes and versioned simulated publication/sync.
- Tickets: requester/contact identity, eligible owners, priority/status/history, private notes, transactional replies and elapsed first-response SLA with exact deadline, priority/reopen and DST tests.
- Shared integration: module-owned emails cannot bypass their domain action through generic preview/send/schedule; permissions and email effects commit atomically. Missing address and failed delivery do not advance ticket SLA or request status.
- Existing execution path: approval/decline, multiple sequential approvals, changed bulk targets, item rollback, replay deduplication, audit, summaries, HTTP/SSE, data tables and UI diffs. No second executor or transport was introduced.
- Fixtures and append-only frozen seed; actual file-backed SQLite close/reopen. Every legacy seeded row hash remains unchanged.
- Separate scenario folders, fingerprints, provider/model/reasoning cohorts and trajectory lines; regression-only headline; unknown subscription dollars remain unknown.

Two inherited plumbing bugs were found and fixed: whole email/SMS objects leaking their ID/payload into new conversation records, and the conversation controller forgetting prior approvals when progressing through multiple external steps. Both have regression tests.

## Codex integration

Ported the merged provider's relevant commits into this worktree (`644b57c`, `7779a8b`), preserving its authentication, timeout, cleanup, token-accounting and unknown-cost behavior. Benchmark-only files absent from this branch were not imported. Grouped trajectory tests were adapted rather than discarding our scenario-folder separation.

All new live runs explicitly set `PLANNER=codex-cli`; no Claude calls were made after the provider switch. Main's default remains unchanged, so reproduction must keep that environment setting. Codex CLI 0.159.0 uses ChatGPT subscription access; there is no API-billing fallback. Captured runtime framing still advertises additional instructions/tools despite disabling flags: this is trusted local development, not a raw tool-free API boundary. See CODEX-PROVIDER-CAPTURE.md.

## Measurements

| Check | Result | Interpretation |
| --- | --- | --- |
| Deterministic backend | 795/795 | Handler/execution/adapter invariants, not AI quality |
| Luna pilot | 3/3 | One repeat, insufficient as a broad quality estimate |
| Luna development | 115/135; 85.2% | 34/45 cases pass every repeat; 8 flaky; no infrastructure failures |
| Sol diagnostic | 4/5 | One repeat on selected failures; not a full-suite comparison |
| Luna original regression | 39/69; 56.5% | 10/23 cases pass every repeat; 7 flaky; no infrastructure failures |
| Luna reporting | 26/36; 72.2% | 7/12 cases pass every repeat; 4 flaky; no infrastructure failures |
| Sol original regression | 63/69; 91.3% | 21/23 cases pass every repeat; 0 flaky; no infrastructure failures |
| Sol development | 124/135; 91.9% | 40/45 cases pass every repeat; 3 flaky; no infrastructure failures |
| Sol reporting | 30/36; 83.3% | 9/12 cases pass every repeat; 2 flaky; no infrastructure failures |

Luna uses `gpt-6-luna`, low reasoning, three repeats, concurrency four for development/regression. Reporting uses concurrency two and overlaps the latter part of regression; latency is descriptive, not a controlled speed comparison. Sol diagnostic uses `gpt-6.1-sol`, low reasoning, concurrency one; it overlapped the end of development. Subscription USD cost is unavailable, **not zero**. Full JSON files are in eval/results; labels identify each provider/model run. Future history entries explicitly record model and reasoning so Sol/Luna cannot silently share a curve.

The development failures include incomplete create→send plans, unnecessary clarification for explicit listing IDs, confusing ticket resolution with internal notes, failure to resolve ticket titles, and missing tool-search recovery. Sol corrected the three direct diagnostic cases but still failed appointment→review planning by inventing `$prev` and invalid list references, even after repair. The deterministic executor can run this workflow correctly; this is an unresolved planner-contract/model-interpretation issue, not proof of an unavailable handler.

## Full Sol comparison, requested after the Luna checkpoint

Tested `gpt-6.1-sol`, low reasoning, on all 80 scenarios three times (240 runs). Code, prompts, cards, seed, expectations and scoring remained unchanged from checkpoint `28268dc`. Suites ran sequentially: original regression, development, reporting. Concurrency matched Luna: four for regression/development, two for reporting. Unlike Luna's partially overlapping runs, these suites did not overlap, so timing is descriptive, not a controlled model-speed claim. End-to-end p50/p95: regression 10.604s/31.069s; development 9.923s/38.645s; reporting 10.160s/36.863s. Subscription USD remains unavailable. Shared account usage was 72% before and 83% after; that is an account-wide observation, not isolated run billing.

Sol gains 34.8 percentage points on original regression, 6.7 on development and 11.1 on reporting, but is not uniformly better per case. Reporting was already exposed by Luna; this is a fixed-set model comparison, not a fresh holdout. No tuning or implementation edits followed either reporting run.

- **Original regression:** both failures repeat 0/3. For Zoe, the planner passes a decorated name/email/company string to the contact resolver after clarification. For Sarah, it passes “Sarah Johnson at Brightside”. The resolver matches contact names, with company details displayed but not parsed as disambiguating query constraints. Correct actions are selected but no writes execute.
- **Development direct actions:** 88/90 pass (97.8%); reviews 30/30, listings 30/30, tickets 28/30. Ticket requester relinking passes 1/3: one failure only lists tickets; the other creates invalid references. The unchanged requirement is 100%, so this gate fails.
- **Development workflows:** invoice∩conversation→tickets and ticket reply+task pass 3/3. Appointment→reviews remains 1/3 due to invalid list/loop and post-look references. Missing-address 0/3 failures stop at invalid references and report compiler errors, not the required address error; these do not demonstrate a consent/address bypass. Partial bulk replies 0/3 clarify instead of processing the valid item. An unavailable-owner case clarifies once rather than returning the expected failure/partial status. These remain scored failures.
- **Reporting:** SLA, reopen and reply+task now pass 3/3 each. However, listing publication falls from Luna's 3/3 to 1/3 and categories from 3/3 to 0/3: Sol includes possessive/descriptive text such as “Harbor Optics' Google listing” in the resolver query, which does not match. Missing address passes 2/3, with one unnecessary clarification.

The strongest next diagnostic target is the **planner/resolver contract**, followed by post-look references, list/loop shapes and partial-failure policy. These findings identify shared behavior to improve; they do not authorize silently normalizing arbitrary names or tuning against exposed reporting outcomes. No default provider/model change was made by these evaluation commands.

## Preserve evidence and test-set independence

Seed version 1 and original development/reporting definitions were committed at `080618f`, before handlers. Development revision 2 corrects an SQL assertion that counted old seeded review requests as new and checks appointment reads through actual calls, which may run during a look. Original development bytes are archived; the seed and reporting bytes remain frozen. The original failed 129/135 Claude development result and targeted correction evidence remain saved, not overwritten.

The unchanged old-23 fingerprint is `fcc7ddef4615`; development v2 is `51f56e2dbc48`. The starting database expanded by four contacts, two completed appointments, three review requests, two reviews, three listings and four tickets. Same scenario fingerprint does not mean identical seed data. Legacy-row hashes verify preservation.

Before the provider switch, Claude's original regression was 69/69 before implementation and 68/69 after. The lost repeat was round-robin assignment: member-availability lookup missing initially, followed by failed recovery/clarification. This deterioration was investigated and preserved. Claude development v2 passed 135/135. Neither figure predicts Codex quality; changing providers prevents attributing the later score difference solely to module code.

Reporting outcomes were collected only after implementation and development diagnosis. No prompt, card or handler tuning used them in this batch. The ticket SLA case failed all three repeats by selecting ticket search but not the offered SLA action. Reopen and reply→task cases omitted the requested mutations in two repeats; missing-address cases unnecessarily clarified twice, and directory ambiguity was missed once. These are failures, not accepted alternate outcomes. Subsequent tuning must disclose reporting exposure and use fresh cases for a new generalization claim.

Development end-to-end latency was p50 8.477s / p95 16.976s; regression 8.456s / 24.138s; reporting 7.929s / 13.239s. The regression score is a provider compatibility warning, not a same-provider before/after estimate. The original Claude regression deterioration remains separately documented above.

## Reproduction

From `server/`, with Codex installed and authenticated:

```sh
PLANNER=codex-cli CODEX_MODEL=gpt-6-luna CODEX_FAST_MODEL=gpt-6-luna CODEX_REASONING=low npm run eval:scenarios -- --scenario-dir eval/module-scenarios/m45-m47/development --repeat 3 --concurrency 4 --label codex-luna-module-development-3x
PLANNER=codex-cli CODEX_MODEL=gpt-6-luna CODEX_FAST_MODEL=gpt-6-luna CODEX_REASONING=low npm run eval:scenarios -- --scenario-dir eval/scenarios --repeat 3 --concurrency 4 --label codex-luna-module-regression-3x
PLANNER=codex-cli CODEX_MODEL=gpt-6-luna CODEX_FAST_MODEL=gpt-6-luna CODEX_REASONING=low npm run eval:scenarios -- --scenario-dir eval/module-scenarios/m45-m47/reporting --repeat 3 --concurrency 2 --label codex-luna-module-reporting-3x
```

Use new labels for future runs to preserve these result files. Re-running reporting is measurement on an exposed set, not fresh holdout validation. Commands consume subscription allowance.

For the completed Sol comparison, the same commands used `CODEX_MODEL=gpt-6.1-sol CODEX_FAST_MODEL=gpt-6.1-sol`, with labels `codex-sol-module-development-3x`, `codex-sol-module-regression-3x`, and `codex-sol-module-reporting-3x`; reasoning, repeats, folders and concurrency stayed as above. Result filenames follow those labels in `eval/results/`.

## Retrieval and remaining gaps

Final unchanged retrieval split: 95.6% recall versus 94.9% before, ~19.4 final cards/query, zero in-scope false rejects. Both off-topic examples still retrieve actions and need planner rejection. One old query worsened: lead search in `m09` moved outside the initial budget (rank 16); `h25` improved. This tradeoff is disclosed, not tuned against the held-out split.

Six extra symmetric module sibling links added no recall on development queries and were not adopted. The old-suite strategy→workload candidate likewise added a card without changing its explicitly required-action recall; it remains unadopted. Generated aliases promising SMS review requests, holiday hours, a pending ticket state or resolution SLA were corrected against actual capabilities; ticket-note/reply cards now accurately declare ticket outputs.

Remaining work is **planner reliability**, including clarification discipline, multi-stage loop/reference construction, and recovery when initial retrieval omits an action. This crosses the originally assigned module implementation into shared planner-contract work. Preserve the failures; do not lower the acceptance targets or add uncatalogued one-off actions to conceal them. The current branch is suitable for review, not an assertion that all AI acceptance gates pass.

See ADDING-A-MODULE.md for the reusable implementation checklist, M45-M47-SCOPE.md for the unchanged acceptance contract, and JOURNEY.md/trajectory.html for history.
