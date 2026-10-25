# Ask AI — 500-action agent framework

A natural-language assistant over a simulated CRM: 50 modules × 10 actions, with measured latency, cost and quality.

All 500 actions are implemented against a simulated backend (SQLite, frozen clock, deterministic seed). A planner model returns a whole plan as structured output; code validates it, shows it, and runs it, and decides what needs approval from the exact records a step touches. Messages, payments and directory syncs are simulated; the planner is the only real model call. Start with [Current implementation](#current-implementation) for what is real and what is mocked, [Verify and evaluate](#verify-and-evaluate) for the evals, and [BENCHMARK.md](BENCHMARK.md) for the numbers.

- `docs/ASSIGNMENT.md` (local only, not in the repo): what's being asked, with a requirements checklist
- [docs/PLAN.md](docs/PLAN.md): architecture, design and the 5-day schedule
- [docs/PLANNER-CHANGES.md](docs/PLANNER-CHANGES.md): what changed in shared lookup, retrieval and planner handling, why each change was needed, and what remains unsolved
- [BENCHMARK.md](BENCHMARK.md): quality, latency (direct vs complex), tokens and cost per successful task, and the planner against a one-call-per-step baseline agent; final run on Haiku 5.5: planner 98.6% of runs passing against 91.3% for the baseline; regenerate with `npm run report -- --label haiku-final-planner-3x --compare haiku-final-baseline-3x` in `server/`
- [docs/PROMPT-EXAMPLE.md](docs/PROMPT-EXAMPLE.md): the planner prompt over two turns, with real payloads and token counts
- `docs/assignment/` (local only, not in this checkout): the original brief and catalog PDFs

## How the tool list is narrowed

The planner never sees all 500 actions. Retrieval starts with 15 ranked slots, then adds selected lookup/dependency/look-alike helpers; the latest combined evaluation averages 21.8 final cards ([evidence](docs/PLANNER-OUTCOMES-VALIDATION.md)). See [docs/PLAN.md](docs/PLAN.md), section "Retrieval". It combines two rankings over a search card per action, with no LLM call:

- **BM25**, which matches words.
- **A small local embedding model** (bge-base, ~110 MB, downloaded once on first start), which matches meaning, so "hold off on the webinar emails" finds Pause campaign. Set `RETRIEVAL=bm25` to use BM25 alone.

- **Generated cards are supplemented by implemented contracts.** `server/src/retrieval/cards.json` holds LLM-generated descriptions, synonyms, record types and look-alike siblings. At runtime, implemented module descriptions/entity metadata and module-owned synonyms refine that surface; the new metadata changes did not regenerate cards through a model. The generator never sees `eval/`, and `retrieve.test.ts` fails if a synonym copies an eval paraphrase. See [what changed and why](docs/PLANNER-CHANGES.md#3-retrieve-the-final-action-and-the-right-lookup-dependencies).
- **Review status:** the initial five modules (M01, M03, M06, M48, M49) were reviewed during the original build. M45–M47's generated metadata has now been compared with the new handlers; registry descriptions and entities supply their implemented contracts. Aliases incorrectly promising SMS review requests, holiday hours, a pending ticket state or resolution SLA were corrected. Proposed extra sibling links were measured on development cases and not adopted because they increased shortlist size without improving recall. This is not a claim that all 500 cards have been reviewed; regenerating cards overwrites hand edits.
- Retrieval quality is measured with `npm run eval:retrieval` (recall@k per question group, with a held-out split; `--bm25` for BM25 alone). Original hybrid recall@15 was 94.9% vs 86.8% BM25 alone; across all 500 actions and 357 questions (112 added for the Wave 1 modules, held out from the card synonyms) hybrid recall@15 is 97.5%, 97.4% on the held-out test split. This is retrieval recall, not task success. The two off-topic examples are not rejected by retrieval; the planner still has to reject them.

## Current implementation

The latest shared-planner work is collected on `codex/planner-outcomes-and-retrieval`. It adds consistent named lookup and the seven changes described in [the rationale](docs/PLANNER-CHANGES.md). The follow-on [scoped lookup/clarification batch](docs/SCOPED-LOOKUPS-AND-CLARIFICATIONS.md) binds child names to their parents and questions to actual missing action arguments; 2,353 deterministic tests, typecheck and web build pass. The preceding complete Luna checkpoints passed 21/23 older cases and 70/75 coverage cases; they are historical, not the new batch's score. [Preceding validation](docs/PLANNER-OUTCOMES-VALIDATION.md). These results do not clear the consistency gate and are not directly comparable to historical Haiku/Sol benchmarks below.

Latest follow-on live runs at `48cbf80`: **16/22 clean older-suite attempts plus one timeout**, and **69/73 clean coverage attempts plus two timeouts**. The form/community/stage examples and Noah's team membership pass, but the older suite regressed. **Not merge-ready on these results.** [Current validation and failure analysis](docs/SCOPED-LOOKUPS-VALIDATION.md).

All 500 actions in all 50 modules are executable. The first 18 modules (Contacts, Leads, Opportunities, Tasks, Notes, Tags, Conversations, SMS, Email, Campaigns, Appointments, Invoices, Payments, Reviews, Business Listings, Support Tickets, Users and Teams) were built in depth first and carry the scenario and module evals below; the other 32 were added in Wave 1 ([WAVE1-REPORT.md](WAVE1-REPORT.md)) and then hardened ([WAVE1-HARDENING-REPORT.md](WAVE1-HARDENING-REPORT.md), assumptions in [WAVE1-ASSUMPTIONS.md](WAVE1-ASSUMPTIONS.md)). The latest verified backend suite has 2,353 deterministic tests. The baseline scenarios cover the first 18 modules; the other 32 have a separate set of 25 planner scenarios (`eval/module-scenarios/wave1`) that historically scored 96% of clean runs on Haiku (3 repeats), up from 66.7% before the failure classes it exposed were fixed. In that run, one scenario failed every repeat: the planner read "Move X from Starter to Pro" as an opportunity stage change instead of a subscription plan change. It is recorded, not patched.

The new thirty actions use the existing registry, compiler, executor, approval gates, replay ledger, SQLite persistence, audit, traces and UI. [Implementation contract](docs/M45-M47-SCOPE.md) · [Module-building guide](docs/ADDING-A-MODULE.md). Ticket-reply batches now disclose known blocked targets and require approval of the eligible subset before sending; see [subset confirmation](docs/PARTIAL-CONFIRMATION.md). Earlier Sol scores below precede this policy change.

- Reviews: draft/send/cancel requests, record/search reviews, draft/publish responses and compute rating summaries. Requests are marketing emails and respect opt-outs/DND.
- Listings: one profile per business/location/directory; the same business on Google and Yelp is valid and ambiguous by name alone. Changes increment a version; publication syncs that version. Hours use America/New_York, all seven days, one interval per day; no overnight/split shifts.
- Tickets: requester/contact links, eligible support owners, priority/status/history, private notes, replies and **elapsed first-response SLA**, not resolution SLA. Targets: urgent 1h, high 4h, normal 24h, low 72h. Exactly at deadline meets it. Reopening does not reset it. Only delivered requester replies count; automatic acknowledgements do not exist. Closed/resolved tickets must reopen before a reply.
- New customer sends need their domain permission plus `messaging.send`; ordinary reads/internal writes retain the existing selective permission policy. This is not a global authorization retrofit. Publication needs reputation permission, not messaging permission.
- Generic email preview/send/schedule routes module-owned kinds back to the review/ticket action so request state and ticket SLA cannot be skipped. Ticket emails bypass marketing preferences under simulator policy but **never** the address requirement.

All messages, payments, review publications and directory syncs are **simulated**; no email provider, HighLevel account or real directory is contacted. The planner calls a real model when configured; retrieval embeddings run locally. Failed module-owned sends roll back their database effects and surface in traces. Injected directory failure likewise preserves the previous published version; it does not manufacture a stored failed sync after rollback.

## Run locally

Use a Node release supporting `node:sqlite` (this branch was tested on Node 26). Install dependencies in both `server/` and `web/` with `npm ci`. Configure the planner using the existing environment settings; `claude-cli` requires an authenticated Claude CLI with available quota, and `qwen` needs a Qwen Token Plan key (see below). `claude-cli` is the default provider and runs `claude-haiku-5-5` for both tiers; set `CLAUDE_MODEL` (and optionally `CLAUDE_FAST_MODEL`) for another model. Give the full id, not the `haiku` alias: Claude CLI 2.1.284 maps the alias to `claude-haiku-4-5-20251001`, which scored 91.3% on the 23-scenario regression suite at a 23.9 s median turn, against 100% over 8 repeats at 7.2 s for `claude-haiku-5-5`. The CLI logs `claude-haiku-5-5` as `unrecognized_model` but serves it.

In `server/`, run `npm run db:reset` to recreate **this checkout's** demo database, then `npm run serve`. In `web/`, run `npm run dev`. Defaults: API 8787, web 5173. For isolated concurrent work, set `PORT` for the API and matching `API_PORT` for Vite. Reset erases the local demo database; it is not a migration of saved user data.

Try “Show Elodie Mercer's reviews”, “Show Maple Dental's listing” (asks which directory), or “Reply to the Portal export fails ticket saying we are investigating, then create a follow-up task”. Sends/publications pause for approval. The trace labels actual hybrid/BM25 mode, including inference fallback, rather than saying there is no model.

## Verify and evaluate

Run `npm run typecheck` and `npm test` in `server/`; run `npm run build` in `web/`. The baseline regression has 23 scenarios; new module sets are kept separate:

```sh
# From server/; scenario directories are relative to the repository root.
npm run eval:scenarios -- --repeat 3 --label m45-m47-regression-after
npm run eval:scenarios -- --scenario-dir eval/module-scenarios/m45-m47/development --repeat 3 --label m45-m47-development
npm run eval:scenarios -- --scenario-dir eval/module-scenarios/m45-m47/reporting --repeat 3 --label m45-m47-reporting
npx tsx src/scripts/eval-module-retrieval.ts
npm run trajectory
```

The 45 development cases cover all thirty new action IDs. The 12 reporting cases and matching seed IDs were frozen before handlers in commit `080618f`; do not use reporting outcomes for tuning. Development revision 2 corrects one test that counted existing seeded requests and asserts appointment reads through actual calls (which may run in a look); its original bytes/results are archived and its fingerprint changes. Seed and reporting definitions remain unchanged. The old 23-scenario fingerprint is unchanged **but its seeded database has expanded**. Legacy-row hashes check that existing records were not rewritten.

Codex integration is available in this branch: explicitly select `PLANNER=codex-cli` (Claude is otherwise still the inherited default). Full GPT-6.1 Sol low-reasoning evaluations score 91.9% development, 91.3% original regression and 83.3% reporting, versus Luna's 85.2%, 56.5% and 72.2%. Sol improves overall quality but still misses acceptance. See the [delivery and evaluation report](docs/M45-M47-FINAL-REPORT.md) for counts, test conditions, test-set revisions and remaining planner gaps. Do not substitute adapter tests or retrieval recall for AI task success.


## Use a Codex subscription locally

Install Codex CLI and run `codex login` with ChatGPT sign-in. The adapter is verified with
CLI 0.159.0. Set `PLANNER=codex-cli` in your local `.env`, or select it for one command
from `server/`:

```sh
PLANNER=codex-cli npm run probe:planner
PLANNER=codex-cli npm run serve
PLANNER=codex-cli npm run ask -- "create a task to call Jo"
```

`CODEX_MODEL` and `CODEX_FAST_MODEL` select the strong/fast models (default `gpt-6.1-sol`).
Set both to `gpt-6-luna` to use GPT-6 Luna. `CODEX_REASONING` and `CODEX_FAST_REASONING`
accept `low`, `medium`, `high` or `xhigh` (default `low`; fast inherits strong if omitted).
Model access depends on your account. `CODEX_BIN` optionally selects an executable;
`CODEX_HOME` may select your existing CLI authentication directory. Claude remains the default.
Card generation stays on Claude so its provenance stamp remains accurate.

The adapter uses the Codex runtime, rather than raw model API calls. It supplies our planner
instructions, request and output schema, while Codex adds runtime framing. **The captured request
still advertised skills and tools despite the disabling flags.** See the measured
[provider capture note](docs/CODEX-PROVIDER-CAPTURE.md) for the actual request, limitations and
local evidence. Do not treat the adapter as a tool-free or prompt-only inference boundary.
The [main-based validation results](docs/CODEX-VALIDATION.md) record the live Luna sample,
including its planning failures.

This is a trusted local development provider. It strips inherited API credentials, checks the
current login before enforcing ChatGPT authentication, uses a private working directory and
read-only sandbox, and requests restricted runtime capabilities. Unexpected tool events and
configuration errors fail the request; this cannot undo any tool action already started by
the runtime. Keep it out of public or untrusted services. For raw API-key calls, use the Qwen
provider below.

Calls have a 120-second deadline, bounded output, cancellation and temporary-file cleanup.
Subscription usage consumes your shared allowance; USD cost remains unknown in the UI, scenario
results and benchmark reports, with no automatic API fallback. The app still validates plans
and owns CRM execution and confirmation. See the
[official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

## Use a Qwen Token Plan locally

The Qwen provider calls the Token Plan's OpenAI-compatible endpoint directly, with no CLI in
between. Get an `sk-sp-...` key from the Token Plan console (Singapore only) and set it in
your local `.env`:

```sh
PLANNER=qwen
QWEN_API_KEY=sk-sp-...
```

Then run any command from `server/`:

```sh
PLANNER=qwen npm run probe:planner
PLANNER=qwen npm run serve
PLANNER=qwen npm run ask -- "create a task to call Jo"
```

`QWEN_MODEL` and `QWEN_FAST_MODEL` select the strong/fast models (`QWEN_MODEL` defaults to
`qwen3.8-flash`, `QWEN_FAST_MODEL` to `QWEN_MODEL`). Thinking is off (`enable_thinking: false`);
set `QWEN_THINKING=1` to turn it on. `QWEN_BASE_URL` defaults to
`https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`; use
`QWEN_BASE_URL=https://token-plan.maas.qwencloudapi.com/compatible-mode/v1` for QwenCloud.
Token Plan keys must not be pointed at a pay-as-you-go endpoint. The adapter sends the planner
system/user messages plus the `submit_plan` JSON Schema and leaves tools out. Calls have a
120-second deadline (`QWEN_TIMEOUT_MS`), cancellation and a 4 MiB reply cap. A dropped connection,
a 5xx or a 429 with a short `Retry-After` is retried once; a quota error fails at once. A reply cut
off at the token limit or blocked by the content filter is reported as such.
Token Plan usage is prepaid, so USD cost stays unknown in the UI and reports.

The reply format follows the model. Where the endpoint takes it, the request carries
`response_format: json_schema`; where it doesn't, it asks for a JSON object and puts the schema in
the system message. DeepSeek has no `json_schema` on the Token Plan and answers HTTP 400 "This
response_format type is unavailable now", so the model picks the format before the first call, and a
400 that blames the format is retried once as `json_object` and that model is remembered for the
rest of the process. `QWEN_RESPONSE_FORMAT=json_schema|json_object` pins the choice; leave it unset.
Plans are validated and repaired either way.

```sh
QWEN_MODEL=deepseek-v4.1-flash-1017 npm run serve   # DeepSeek on the same key; no format flag needed
```

Measured 2026-10-25 on the module scenarios with real list rates (regression: 23 scenarios x 3
repeats; development: 45 scenarios):

| model | regression | development | median turn | $/turn |
| --- | --- | --- | --- | --- |
| qwen3.8-flash (adapter default) | 90.9% | 97.8% | 5.0 s / 3.2 s | 0.00044 / 0.00063 |
| deepseek-v4.1-flash-1017 | 95.7% | 97.8% | 1.9 s / 1.1 s | 0.00048 / 0.00065 |

DeepSeek's regression figure is the lower of two batches (the other was 98.6%) and Qwen's is a
four-batch mean; a single batch moves by 1-3 points, so read gaps under ~5 points as noise. Batches:
`eval/results/scenarios-ds-default-check-*.json`, `scenarios-base-ds-reg-3x-jo.json`,
`scenarios-reg-fix{4,5,6,7}-qf-3x.json`, `scenarios-dev-smoke-compilerfix.json`.

## Layout

```
server/   Node + TypeScript backend (registry, modules, store, agent core)
eval/     scenarios, runner, smoke tests, benchmark report
web/      Vue 3 chat UI
docs/     assignment, plan, module contract, verification reports
```

Reports from the two later waves are at the repository root: [WAVE1-REPORT.md](WAVE1-REPORT.md), [WAVE1-HARDENING-REPORT.md](WAVE1-HARDENING-REPORT.md) and [WAVE1-ASSUMPTIONS.md](WAVE1-ASSUMPTIONS.md). Raw eval runs are in `eval/results/`; `docs/trajectory.html` charts them.
