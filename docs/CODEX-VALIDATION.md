# Codex-only integration validation

Validated on 2026-10-22 against local `main` at `ce7f1fb`. This port excludes
the `qwen-planner` branch's provider, prompt/schema changes, retrieval changes,
typed record IDs and planner-specific eval runner. Main's existing scenario
runner and benchmark reporter handle unknown subscription costs instead.

The [request capture note](CODEX-PROVIDER-CAPTURE.md) is included unchanged.
The Codex runtime still adds framing and advertises tools despite the requested
disabling flags; this is a trusted local development integration.

## Automated checks

- TypeScript typecheck: passed.
- Full backend test suite: passed.
- Frontend production build: passed.
- Regression tests cover output/reasoning token accounting, authentication
  checks, subprocess failures/cancellation/cleanup, unknown subscription costs
  across scenario turns, and benchmark cost aggregation.

## GPT-6 Luna live checks

Codex CLI 0.159.0, `gpt-6-luna`, low reasoning. Both model tiers were set to Luna.

The four-message planner probe returned valid structured output in 4/4 cases.
This checks parsing and argument JSON, not workflow correctness.

The end-to-end scenario sample used fresh seeded stores and BM25 retrieval:

| Scenario | Result | Observation |
| --- | --- | --- |
| `direct-task-create` | Passed | Created the requested task. |
| `multi-facebook-leads` | Failed | An invalid reference triggered repair; the repaired reply asked which team instead of completing the assignment. |
| `ambiguous-two-sarahs` | Failed | Invalid filters and references persisted after repair; no SMS was sent. |
| `unsupported-linkedin-post` | Passed | Returned unsupported without running an action. |

This is **2/4**, one run per scenario. It is not a broad quality estimate or
evidence that Luna meets the application's acceptance targets. The earlier
5/5 result was on the Qwen branch's different prompt/schema and scenario set;
it does not apply to this main-based port.

Reproduce from `server/`:

```sh
PLANNER=codex-cli CODEX_MODEL=gpt-6-luna CODEX_FAST_MODEL=gpt-6-luna npm run probe:planner
PLANNER=codex-cli CODEX_MODEL=gpt-6-luna CODEX_FAST_MODEL=gpt-6-luna RETRIEVAL=bm25 npm run eval:scenarios -- --fast --concurrency 1 --only direct-task-create,multi-facebook-leads,ambiguous-two-sarahs,unsupported-linkedin-post --label codex-luna-main-smoke
```

The full local result is `eval/results/scenarios-codex-luna-main-smoke.json`.
Generated eval results are not included in this commit.
