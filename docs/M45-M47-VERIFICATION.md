# M45–M47 implementation verification

22 October 2026. Branch `codex/m45-m47-complete`, separate managed worktree based on main `3d4588d`. Nothing pushed. All external effects below are simulated.

## Delivered

Thirty catalog actions: reviews/request lifecycle, per-directory versioned listings, and support tickets with state transitions and first-response SLA. Shared integrations include email-kind routing/refusal, permissions, append-only seed/fixtures, smoke coverage, confirmation/replay/rollback tests, actual SQLite persistence and HTTP/SSE/UI traces.

Module code is in commits `725c075`, `ee432f7`, `e0e693a`; shared integration in `2499672`. Scenario-folder/trajectory separation is in `aa147a7`; retrieval tracing/development ablation is in `c5df916`. The branch contains no alternate executor, provider adapter or cost/scoring rewrite.

## Verified checks

- **769/769 deterministic tests pass**, no skips or failures, including real local embedding tests. TypeScript check and production web build pass on Node 26.7.0.
- All 180 registered actions pass the generic smoke suite. The new 30 have domain tests and expected-action coverage in 45 frozen development cases.
- Shared email preview reports `canSend: false` for review/ticket-owned emails; generic send and schedule refuse them without side effects. Owning actions update email, conversation and domain state atomically.
- Role matrices cover allowed/denied roles, the two-permission send rule and deactivated actors. Transactional ticket sends accept marketing opt-outs/DND but still reject missing/invalid email and roll back on bounce.
- Ticket state matrix, exact SLA deadlines, priority changes, reopen preservation, internal-note isolation and the 1 November New York DST boundary are tested. This is elapsed **first-response**, not business-hours or resolution SLA.
- Executor tests cover deduplicated appointment→review sends, overdue invoice∩recent inbound→one ticket/customer, ticket reply+task, changed bulk targets, per-item failure rollback and replay safety. Real HTTP tests cover approve/decline, duplicate confirmation refusal, ambiguity, publication gates, trace/diff/audit, metadata and table visibility. These use scripted plans and are **not AI pass rates**.
- All new state and audit survive a file-backed SQLite close/reopen. Every legacy seeded row has the same baseline hash. New IDs exactly match the frozen manifest, whose bytes and both scenario files are checked against `freeze.json`.
- Browser verification of a scripted ticket reply+task showed zero writes before approval, then a delivered email, a clean `cv_…` conversation, updated ticket/SLA and one task. The trace explicitly identifies `SCRIPTED — NOT AI` and `BM25 + local embeddings`. A screenshot is saved in the task's outputs directory.

Browser inspection caught an inherited bug: passing a whole email/SMS as a structurally typed reference caused `touch` to spread its ID/payload into a newly created conversation. It now copies only contact/lead IDs. New email and SMS tests assert a distinct `cv_…` ID and a strict clean conversation schema. The existing seed is unaffected because its references already contain only those fields.

## Retrieval evidence

The unchanged held-out retrieval split has 105 in-scope and two off-topic queries. Before: **94.9% recall@15**, 19.5 mean final cards. After: **95.6%**, 19.4 cards; zero in-scope false rejects. Both off-topic queries still retrieve actions: rejection remains a planner responsibility. Files: `eval/results/retrieval-m45-m47-before.json`, `retrieval-m45-m47-after.json`. The after run records a dirty implementation tree; the implementation is subsequently captured by the commits above. This is a measured before/after comparison, not a clean untouched-holdout claim after repeated historical development.

The separate development ablation uses only the 45 module development cases, never reporting outcomes. Across 46 independently retrieved turns, expected-action availability is **97.56%**, and 44/45 cases have every explicitly required action available across their turns. This is neither planner choice accuracy nor task success. Mean/max final shortlist: **17.83/25**; mean implemented action-card text: **9,573 characters**.

Six candidate symmetric sibling links were evaluated individually and together. All together retained exactly the same recall while increasing mean/max shortlist to **18.11/26** and prompt text to **9,806 characters**. No extra links were adopted. Existing generated links already cover ticket/email, ticket-note/contact-note and ticket/task ownership overlaps; new descriptions explicitly distinguish their domain effects. The remaining review-publication/listing-publication and ticket/contact ownership links had no retrieval gain in this development measurement. Their AI selection accuracy remains to be evaluated, not assumed.

The one missing required action is M47.A01 in the long overdue-invoice/recent-inbound workflow's initial shortlist. The existing `search_tools` mechanism can retrieve additional ticket tools without dropping prior cards; its plumbing is tested. Whether the real planner requests that recovery correctly is **unverified**. Report: `eval/results/retrieval-m45-m47-development-ablation.json`.

## Frozen data and separate scenario sets

Commit `080618f` froze seed manifest version 1 and explicit IDs together with 45 development and 12 reporting scenarios **before handlers**. `freeze.json` now records their full SHA-256 byte hashes. The original 23 scenario files are unchanged; their parsed set fingerprint is `fcc7ddef4615`.

**The database did change:** four contacts (`ct_35`–`ct_38`), two completed appointments, three review requests, two reviews, three listings and four tickets were appended. Equal old-scenario fingerprints therefore do not imply identical starting data. Legacy-row hashes prove preservation, not an unchanged database. Ordinary new names avoid the old Sarah/Zoe regressions; deliberate directory/name ambiguity is tested independently.

`--scenario-dir` loads exactly one folder. History and result summaries record its canonical repo-relative path. Trajectory creates independent scenario, latency and cost series per folder, preserves fingerprint breaks, and keeps `eval/scenarios` as the headline under the existing repeat/provider/tier rules. Legacy histories without folder metadata remain the old suite. Infrastructure-only runs are not added as app measurements. Structural/grouping/rendered-script tests pass.

## Unmet acceptance gates — do not call this complete

Baseline on main: original 23 ×3 = **69/69**, no flaky cases or infrastructure failures, p50 5.438s, p95 13.100s, recorded mean cost $0.0213/run ($1.47 total). This is **before** the new modules and expanded seed, not an after-regression result.

The first development evaluation hit Claude CLI session quota: four infrastructure failures, 41 unstarted cases, **zero clean application runs**. The provider reported reset at 15:10 Asia/Calcutta. Saved as `eval/results/scenarios-m45-m47-dev-first.json`; correctly excluded from trajectory history. It establishes no development task pass rate.

Pending: new development 45×3, unchanged regression 23×3, then reporting 12×3; investigate all new failures/consistency losses. Reporting outcomes have not been run or used for tuning. Targets remain 100% direct happy paths and at least 95% full development runs. Browser visual verification of the separated trajectory is also still pending; grouped-data and generated-JavaScript tests are not a substitute for it.

Reproduction commands are in README. Do not tune on reporting outcomes and continue calling that set untouched. If outcomes inform subsequent fixes, disclose exposure and author a fresh reporting set. No new claims about authoritative provider billing or cost per successful task are made.
