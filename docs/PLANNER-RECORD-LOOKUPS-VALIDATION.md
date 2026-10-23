# Shared planner support — validation, 23 October 2026

## Status

Implemented on `codex/planner-record-lookups`, not pushed or merged. The architecture changes are provider-independent. **Do not treat this as a passed natural-language regression gate:** the newer module suite improved substantially in the first checkpoint, but the final-source legacy run scored below its historical baseline. Further consistency/prompt validation is needed before merge.

The implementation contract is in [PLANNER-RECORD-LOOKUPS.md](PLANNER-RECORD-LOOKUPS.md). Base `64c9e45` includes main `d62d534` and the other agent's committed 75-case coverage work; that agent's active checkout was not modified. No scenarios, expected actions, seed records, provider configuration or model defaults were changed. Completion verification and broader approval policy remain outside this batch.

## What is implemented

- Named lookup now supports 39 entity types (27 additions, including pipeline stages). Modules own their resolvers; no new catalog actions or executor were introduced.
- Exact qualifiers are applied before name ranking. Company/email distinguish contacts, directory distinguishes listings, and parent identifiers distinguish stages, prices or lessons. Unknown qualifiers fail rather than being ignored.
- A model can put a typed `$lookup` in an ID argument. Code expands it to an ordinary resolve plus scalar reference, so simple name lookup requires no extra planner round. Zero matches fail, multiple matches pause for clarification, and dependent actions retain the existing execution rules.
- Retrieval distinguishes read-only discovery from creation and ID-only get. One generic discovery helper is preferred over all cross-module lists of the same entity, and the fewest required inputs win before semantic rank. Bulk lookup still receives a list/search.
- Sessions retain at most 12 observed typed identities, not raw records, for follow-up grounding. Identity hints are not current record contents or a complete selection set.
- Generated resolve references survive a read/replan round. Qualifier references, including interpolation, receive normal dependency/type validation.

## Deterministic verification

At final source `26e7a36`: TypeScript typecheck and **2,298 tests pass**, including the real local embedding model, existing shortlist-size gate, all 500-action smoke checks, HTTP, persistence, permissions, confirmation/cancellation, replay and cross-module tests. Web production build passes (web sources were unchanged). New tests cover real fixtures for every added table resolver, qualified/ambiguous/missing names, wrong entity/argument types, generated-ID collisions, changed-target approvals, typed follow-up/reset and read/replan integration.

The first test run had no local embedding model and passed 2,293 tests; after the model was cached, the hybrid gate exposed an average shortlist of 22.27 against its existing limit of 22. This was fixed by reducing redundant/conditional discovery helpers, not by relaxing assertions. A baseline-only check on the unchanged previous checkout also passed that gate. All original failed test/run evidence was retained in this chat; no final assertion was removed.

## Live measurements: keep checkpoints separate

All calls used Codex subscription access, `gpt-6-luna`, reasoning `low`, fresh planner calls, one repetition, no replay cache or Claude/Sol calls. Dollar cost is unavailable, not zero. These are single observations, not stability estimates or evidence of improvement across every model.

| Checkpoint | Suite | Passed | Evidence |
|---|---|---:|---|
| Historical `64c9e45` | New coverage 75 | 37/75 (49.3%) | Preserved on `codex/luna-new-coverage-20261023` |
| Initial `ffdfadd` | Same coverage/fingerprint `78173cca5a2c` | 69/75 (92.0%) | [raw](../eval/results/scenarios-shared-lookups-luna-coverage-20261023-1x.json) |
| Historical `d62d534` | Legacy 23 | 18/23 (78.3%) | Preserved on `codex/luna-main-once-20261023` |
| Initial `ffdfadd` | Legacy 23 / `90b43d538455` | 16/23 (69.6%) | [raw](../eval/results/scenarios-shared-lookups-luna-regression-20261023-1x.json) |
| Initial `ffdfadd` | Subset confirmation 2 / `d6f559cccec2` | 2/2 | [raw](../eval/results/scenarios-shared-lookups-luna-policy-20261023-1x.json) |
| Final `26e7a36` | Legacy 23 / `90b43d538455` | 14/23 (60.9%) | [raw](../eval/results/scenarios-shared-lookups-final-luna-regression-20261023-1x.json) |
| Final `26e7a36` | Four selected development failures | 1/4 | [diagnostic only](../eval/results/scenarios-shared-lookups-final-luna-diagnostic-20261023-1x.json) |

There were no infrastructure failures or unstarted cases in these live runs. Initial coverage concurrency was 4; initial legacy 2; final legacy 3; policy 1; final diagnostic 2. Timings are not controlled latency comparisons. The coverage median/p95 was 20.7/47.0 seconds at the initial checkpoint versus 8.0/25.6 historically, despite mean planner rounds decreasing from 1.52 to 1.20. Final legacy median/p95 was 8.9/18.3 seconds. Do not claim a latency win from these runs.

The complete 75 was **not rerun after final hardening**, so 92% is not a final-source score. No score is composed by replacing failed runs with successful retries. The four-case check was selected after inspecting failures and is not a representative benchmark or holdout.

Initial coverage breakdown: commerce/site 15/17, communications/automation 20/21, community/reports 10/11, CRM configuration 12/13, scheduling 12/13. Compared case by case with the previous 75, 34 previously failing cases passed, two previously passing cases failed, four failed both. Examples that improved include report execution/scheduling, template preview, qualified company linking, pipeline probability, availability and the community join follow-up. This remains development evidence: these cases and their names had already been inspected, and some examples in the shared prompt illustrate those known failure classes.

## Regression investigation

The final legacy sample newly failed tag rename, inactive-assignee reporting, email-provider failure reporting, task amendment and unsupported LinkedIn posting; it newly passed the email-plus-task case. Existing failures remained for refunds, Lucia task ownership, late-payer reminders and adding Noah to Sales. Most new failures were premature questions rather than unsafe writes: “Which partner tag?”, “Which Friday?”, or “What should the email say?”. Another failure read payments but never requested the refund. These are real workflow/response regressions, not dismissed as grading noise.

A diagnostic held final code/retrieval constant and restored the previous system instructions on five selected newly failing legacy cases. It passed 2/5 (provider failure and task amendment), while tag rename, inactive-assignee reporting and unsupported LinkedIn still failed. [Ablation evidence](../eval/results/scenarios-shared-lookups-final-luna-old-system-ablation-20261023.json). This suggests prompt/context sensitivity may contribute, but one selected run does not establish causality or a safe rollback. It is not in the trajectory history because it is not a complete suite using the normal prompt.

Remaining new-suite gaps also have distinct causes: form submission needs field IDs rather than an `email` label; community posting needs the channel ID and membership action; funnel reorder still invents self/forward references even after generated lookup carry-over is fixed; calendar configuration initially stopped after reads but passed the final diagnostic. The scripted generated-reference regression test passes; that does not mean every natural-language funnel plan is valid.

## Retrieval

Final-source hybrid test split: **97.4% R@15**, **96.7% all-needed@15**, 150 in-scope questions, zero false rejections, **22.3 final cards on average** (15 ranked slots plus additions). [Final evidence](../eval/results/retrieval-shared-lookups-final-hybrid-test-20261023.json). Both out-of-scope questions still matched retrieval; unsupported handling remains a planner responsibility. The combined hybrid regression gate stays within its unchanged 22-card average budget. Initial dev/test results are also retained under their original labels, not overwritten.

## Handoff

The shared mechanics are implemented and deterministically verified. Natural-language reliability is **not accepted for merge**. Next work should validate a shorter, capability-focused shared prompt and systematically prevent identity/ID questions before lookup, with repeated unchanged legacy and development runs. Nested child selection and completion tracking remain separate gaps; no per-model prompt branch or benchmark-specific action rule was added here. The remaining 82 active scenarios were not newly evaluated in this batch, and no new untouched holdout was claimed.
