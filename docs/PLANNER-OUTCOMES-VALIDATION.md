# Grounded outcomes: implementation and validation

2026-10-24 · branch `codex/planner-record-lookups` · final source `abe136b`

This records the original measurement branch and checkpoints. The same commits and evidence are now retained on `codex/planner-outcomes-and-retrieval`; the documentation/branch change did not rerun these evaluations. See [what changed and why](PLANNER-CHANGES.md) for the rationale and current reading guide.

## Scope and checkpoints

All seven agreed improvements are implemented through shared code and metadata, not a Luna-specific adapter. See [implementation notes](PLANNER-OUTCOMES.md). Starting point: `f0870a6` and its documented 14/23 older-suite result. Seed records, scenario files/assertions, retrieval questions and frozen reporting data are unchanged. These are inspected regression/development sets, not an untouched holdout.

Source checkpoints: `d73b973` adds the seven features; `f97aae9` bounds/revalidates identity checks and snapshots the clock once; `10ee277` permits bookkeeping-only report queries and clarifies discovery versus report computation; `abe136b` extends that same query metadata to trigger condition tests. Trigger testing only records a test firing, never starts a workflow. Execution risks, domain permissions and approval rules are unchanged.

## Final deterministic verification

- `npm run typecheck`: passes.
- `npm test`: **2,323/2,323 pass**, with the real cached embedding model; no skips. Includes strict schemas, domain state, permission/consent, confirmation/subset approval, rollback/replay, HTTP/session behavior and frozen-data integrity.
- Web `npm run build`: passes.
- `git diff --check`: passes.

New tests cover declared final-action coverage, read prerequisites that cannot finish changes, bounded continuation, stable outcomes across rounds, grounded unique/duplicate/inactive/missing identities, invalid qualifier retries, capability-based unsupported destinations, bookkeeping-query risk preservation, weekday/local-midnight/DST behavior and reminder filtering before pagination.

## Complete live checkpoints

All live runs used subscription `codex-cli`, **gpt-6-luna / low reasoning**, both tier model settings pinned explicitly. No Claude or API-key fallback. The suite tier label is `strong`; the actual model was still Luna. Each case resets to its unchanged seed and frozen `2026-10-21T14:00:00Z` clock, account timezone America/New_York. USD billing is unavailable, not zero.

| Source | Suite | Passes / clean attempts | Provider failures | Evidence |
| --- | --- | --- | --- | --- |
| Development WIP (`f0870a6`, dirty) | Older 23, once | 21/23 | 0 | [raw](../eval/results/scenarios-shared-outcomes-dev-luna-20261024-1x.json) |
| `d73b973` | Older 23, three repeats | 46/52 | 17 | [raw](../eval/results/scenarios-shared-outcomes-final-luna-regression-20261024-3x.json) |
| `d73b973` | Broader 100, once (75 coverage + 25 Wave 1) | 73/85 | 15 | [raw](../eval/results/scenarios-shared-outcomes-final-luna-coverage-20261024-1x.json) |
| `f97aae9` | Older 23, once | 21/23 | 0 | [raw](../eval/results/scenarios-shared-outcomes-hardened-luna-regression-20261024-1x.json) |
| `10ee277` | Older 23, once | **21/23 (91.3%)** | **0** | [raw](../eval/results/scenarios-shared-outcomes-release-luna-regression-20261024-1x.json) |
| `10ee277` | Coverage 75, once | **70/75 (93.3%)** | **0** | [raw](../eval/results/scenarios-shared-outcomes-release-luna-coverage-20261024-1x.json) |

Older-23 fingerprint: `90b43d538455`. Coverage-75: `78173cca5a2c`. Combined-100: `611207a1bff4`. The combined run is a different set, not directly comparable to 75-case scores. Its coverage subset was 60/66 clean with nine provider failures; Wave 1 was 13/19 clean with six provider failures. This is not a clean 100-case benchmark.

The interrupted-quality runs encountered intermittent upstream **403 Forbidden** WebSocket responses. They remain in raw results/history, separated from application failures. The three-repeat run measured only 19 of 23 scenarios cleanly and had four flaky scenarios; it is **not** a passed consistency gate. No reset credits, auth changes or paid-credit purchases were used. No retry successes were spliced into an earlier run.

The two earlier large runs overlapped at three workers each. The latest clean suites overlapped at one worker for older-23 and two for coverage-75. Earlier WIP used three; `f97aae9` used two. Different concurrency and checkpoint conditions prevent controlled latency comparisons. Latest older-23 p50/p95 end-to-end was 6.2/11.6 seconds; coverage was 5.0/14.0 seconds.

After the complete 75-case run exposed a read-outcome rejection of trigger testing, `abe136b` corrected the bookkeeping metadata. A **selected three-case diagnostic** (trigger test, report run, top-rep report) passed 3/3 with no provider failures. [Raw diagnostic](../eval/results/scenarios-shared-outcomes-query-diagnostic-luna-20261024.json). It is not recorded as a complete-suite trajectory point and **does not turn 70/75 into 71/75**. The complete suites were not rerun after that final one-action metadata change.

## Remaining failures and limits

Latest complete older-23 failures:

- Appointment rescheduling: the resolver found one match, but the planner still asked an identity question after its bounded retry. The app failed safely without moving it.
- Adding Noah to Sales: the right action was offered, but the planner still asked which team. It did not use the typed identity-check path. The category/selector contract improves grounding but does not guarantee that a model classifies every question correctly.

Latest complete coverage-75 failures:

- Trigger test: initial read-outcome classification rejected its bookkeeping write; subsequently corrected and verified only in the diagnostic above.
- Form simulation: used an `email` label where the form requires a field ID.
- Community post/pin follow-up: tried to create an existing channel and omitted the membership operation from the shortlist.
- Pipeline stage removal: supplied the stage name as an ID, so it never reached the intended “stage has deals” blocker.
- Pipeline description: listed definitions but did not retrieve/read stage details.

Earlier repeats also exposed invented IDs and an empty opportunity search. Two task-amend failures had the correct linked contact, due date, assignee and priority but omitted the contact's name from the title, which the existing assertions require. They remain counted failures; no assertions were weakened. Not every measured failure is the same architectural gap.

Declared-outcome coverage is not an independent semantic or final-state verifier. It can catch missing declared operations, but cannot prove that the initial interpretation, targets, nested child IDs, filters or every requested item are correct. Ordinary wording composition is a prompt policy, not a deterministic fact checker. No claim of 100% reliability across models or a passed merge gate is made. Unchanged legacy and broad suites still need clean repeated runs before making a consistency claim. No new untouched holdout was used, and the remaining module reporting/policy suites were not newly run here.

## Retrieval at final source

Final `abe136b`: combined 365 questions, 357 in scope; **97.6% R@15**, **96.9% all-needed@15**, mean final shortlist **21.8**, zero in-scope false rejections. Fifteen ranked slots plus dependency/mention/sibling additions remain within the existing 22-card combined average gate. Out-of-scope retrieval rejected only 2/8; unsupported handling still depends on capabilities/planning. BGE-base, vector dimensions and ranking settings are unchanged. [Final evidence](../eval/results/retrieval-shared-outcomes-release-all-20261024.json). Intermediate development and combined results are also preserved, not overwritten.

The design follows the [function-calling guidance](https://developers.openai.com/api/docs/guides/function-calling#best-practices-for-defining-functions) to make contracts explicit and move known lookups, date arithmetic and eligibility filtering into code. It does not depend on a provider-specific prompting trick.

Implementation and evidence are committed locally. Nothing was pushed or merged.
