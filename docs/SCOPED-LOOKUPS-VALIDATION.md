# Scoped inputs: validation and unresolved regression gate

2026-10-24 · `codex/planner-outcomes-and-retrieval`

**Implemented, but not merge-ready on the live regression evidence.** The scoped child interfaces work in deterministic tests and the previously failing form/community/stage examples pass this time. The older suite nevertheless lost passes. No retry successes were substituted, assertions relaxed or failed cases removed.

## Source and conditions

Implementation and rationale: [scoped lookup and clarification](SCOPED-LOOKUPS-AND-CLARIFICATIONS.md). Source commit `167f4a4`; live runs at clean `48cbf80`, which adds only the already recorded development retrieval evidence. Both live history entries record `dirty: false`. No source edits occurred during either run.

Both runs use subscription `codex-cli`, **gpt-6-luna / low reasoning**, with `CODEX_MODEL` and `CODEX_FAST_MODEL` pinned to Luna. The runner's tier label remains `strong`; it does not mean Sol. No Claude/API-key fallback or auth changes. USD billing is unavailable, not zero. Every scenario starts with its unchanged seed and frozen `2026-10-21T14:00:00Z` clock, account timezone America/New_York.

The suites overlap at one worker for the older 23 and two workers for coverage 75, the same worker allocation as the preceding complete clean checkpoints. Each is run once. These are already inspected regression/development sets, not a fresh holdout. Seed data, scenario files/assertions, retrieval questions and reporting freezes are unchanged.

## Deterministic and retrieval checks

- `npm run typecheck`: passes.
- `npm test`: **2,353/2,353 pass**, zero skips, including the real cached embedding model.
- Web `npm run build`: passes.
- `git diff --check`: passes.
- Combined development retrieval: **97.6% R@15**, **96.9% all-needed**, **21.8 mean final cards**, zero in-scope false rejections; 357 in-scope questions, 365 total. Out-of-scope rejection remains 2/8. BGE-base and ranking/expansion settings are unchanged. [Raw retrieval](../eval/results/retrieval-scoped-inputs-dev-all-20261024.json) records `57a6d59`, dirty development source; it is not a clean final-source rerun.

New tests exercise parent-bound nested/array lookups, duplicates and scope contradictions, lookup/reference ID collision avoidance, unchanged legacy form input, membership/rollback, changed-target approval, required versus optional clarification, route alternatives, real identity ambiguity, lowercase selector-free grounding, finite repair/replan budgets and HTTP behavior. Scripted fixture updates name actual missing inputs; they are not rewritten natural-language scenario expectations.

## Complete live runs at 48cbf80

| Suite | Passed / clean attempts | Application failures | Provider timeouts | Fingerprint | Evidence |
| --- | --- | --- | --- | --- | --- |
| Older 23 | **16/22 (72.7%)** | 6 | 1 | `90b43d538455` | [raw](../eval/results/scenarios-scoped-inputs-final-luna-regression-20261024-1x.json) |
| Coverage 75 | **69/73 (94.5%)** | 4 | 2 | `78173cca5a2c` | [raw](../eval/results/scenarios-scoped-inputs-final-luna-coverage-20261024-1x.json) |

Every case was attempted; none was omitted after a quota stop. Timeouts are `multi-email-and-task`, `cov-report-top-rep` and `cov-unsupported-ab-test-funnel`. They stay visible in raw evidence/history and outside the application's clean-pass denominator. Neither suite is a completely clean benchmark. No claim of zero provider failures or passed repeat consistency is made. Older-suite p50/p95 end-to-end is 6.9/14.3 seconds over clean attempts; coverage is 5.1/13.9 seconds. These are observations, not controlled latency improvements.

### Examples now passing

- `indirect-noah-helps-sales`: joined Noah to Sales. The unnecessary supplied-user question was rejected and the bounded continuation reached the membership action.
- `cov-form-simulated-submit`: used the new `answers` array with the real `fld_email` ID, then the existing submission handler.
- `cov-community-post-and-pin`: created the community/channel, then read it, joined the contact, posted to `ch_1` and pinned the post. No duplicate channel creation on the follow-up.
- `cov-pipeline-remove-stage-with-deals`: resolved `st_14_3`, retained destructive confirmation, and reached the correct “two deals still sit in Proposal” conflict. The scenario expects refusal, not deletion.
- `cov-trigger-test-event`: passes with the bookkeeping-query correction already present before this batch. Do not credit that older fix to scoped lookup.

These are single passes within complete runs, not independent guarantees that the same model will repeat them reliably. Community completion also needed a tool-search round; no new retrieval bundle was added.

### Every older-suite application failure

- **Campaign pause**: looked for “fall webinar campaign”; the resolver found no such full name. The pause action was offered/planned, but no handler ran. This is name selection, not a missing card or a permission refusal.
- **Payment request**: an intermediate invoice read ran; the final plan reused a read-step ID and produced self/forward references. Normal compilation rejected it after the repair allowance. The new generated-ID reservation does not repair model-authored step-ID reuse.
- **Appointment reschedule**: first returned an unbound clarification; later supplied conflicting inline/root selectors. One identity continuation and one repair did not yield a valid reschedule. The action was offered and no appointment changed.
- **Deactivated assignee**: repeated an identity question after a unique match. It failed safely, but the final reply omitted the required inactive-user explanation. It remains a scenario failure, not an accepted eligibility refusal.
- **Task creation/amendment**: first asked for an unspecified optional assignee; repair then put a lookup object in polymorphic `relatedTo.id`, which has no typed binding. The first task never existed, so the follow-up also failed. Arbitrary polymorphic IDs remain outside this batch.
- **Lost deal plus note**: searched “Soylent Pro”, found an empty list, and completed an empty loop without the requested state changes. Declared-action presence is not a final-state/target verifier; that separate improvement is still unimplemented.

Compared with the preceding complete `10ee277` run (21/23), Noah changes fail→pass; campaign, payment, inactive assignee, task amendment and lost deal change pass→fail; appointment stays failed; email/task changes pass→timeout. Those new failures were inspected, not dismissed as random noise. A single uncontrolled run cannot establish which prompt change caused each difference, but it also cannot support an overall quality-improvement claim or a merge gate.

### Every coverage application failure

- **Funnel reorder/remove**: read the funnel, then reused step IDs and generated invalid self/forward references; no requested edit ran.
- **Pipeline description**: offered the list action but not `M05.A02`; returned only the definition list and omitted stages/probabilities. This remains a retrieval/detail-completion gap.
- **Report period comparison**: comparison was offered, but the planner declared/executed only report discovery. Initial outcome interpretation was wrong; the existing declared-action checker cannot prove intent independently.
- **Booking-page create/publish**: asked for the required URL slug instead of deriving one; the scripted follow-up then referred to a page that was never created. The new contract permits a real required-input question. Whether safe title-derived slugs should be a product convention needs its own decision, not a weakened assertion here.

Compared with the preceding complete 70/75 run, form submission, community posting, stage refusal and trigger test change fail→pass; funnel edits, report comparison and booking-page creation change pass→fail; pipeline detail stays failed; two previously passing cases time out. **69/73 is not 71/75**, and the higher clean percentage with two missing measurements is not evidence of an overall coverage improvement.

## Remaining work and handoff

The implementation is provider-neutral and locally verified; the live regression gate is unresolved. Next measured work should address read-result/step-ID references, typed polymorphic record links, clarification ergonomics and independent completion/empty-target checks, without bypassing approvals or silently choosing records. Those are not implemented or claimed complete here. Full clean repeated suites and a genuinely independent evaluation set are still needed for a reliability claim. No push, merge, provider switch or evaluation scoring change in this batch.
