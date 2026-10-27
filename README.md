# Ask AI — 500-action agent framework

A natural-language assistant over a simulated CRM: 50 modules × 10 actions, with measured latency, cost and quality.

All 500 actions are implemented against a simulated backend (SQLite, frozen clock, deterministic seed). A planner model returns a whole plan as structured output; code validates it, shows it, and runs it, and decides what needs approval from the exact records a step touches. Messages, payments and directory syncs are simulated; the planner is the only real model call. Start with [Current implementation](#current-implementation) for what is real and what is mocked, [Verify and evaluate](#verify-and-evaluate) for the evals, and [BENCHMARK.md](BENCHMARK.md) for the numbers.

- `docs/ASSIGNMENT.md` (local only, not in the repo): what's being asked, with a requirements checklist
- [docs/PLAN.md](docs/PLAN.md): architecture, design and the 5-day schedule
- [docs/PLANNER-CHANGES.md](docs/PLANNER-CHANGES.md): what changed in shared lookup, retrieval and planner handling, why each change was needed, and what remains unsolved
- [BENCHMARK.md](BENCHMARK.md): quality, latency (direct vs complex), tokens and cost per successful task, and the planner against a one-call-per-step baseline agent; final run on DeepSeek (deepseek-v4.1-flash-1017 through the Qwen Token Plan), 273 scenarios × 3 runs across all 50 modules: planner 96.5% of runs passing at a 1.7 s median direct reply, against 90.8% at 2.6 s for the baseline, at $0.0044 per successful task against $0.0074 at list rates; regenerate with `npm run report -- --label final-deepseek-planner-3x --compare final-deepseek-baseline-3x` in `server/`
- [docs/PROMPT-EXAMPLE.md](docs/PROMPT-EXAMPLE.md): the planner prompt over two turns, with real payloads and token counts
- `docs/assignment/` (local only, not in this checkout): the original brief and catalog PDFs

## Architecture

Each turn is one planner call wrapped in code. The full design is in [docs/PLAN.md](docs/PLAN.md), §1–§3.

1. **Retrieve** (`server/src/retrieval/`, no LLM). BM25 and local embeddings rank about 22 action cards out of 500 (see below). Named records in the message are resolved to typed mentions.
2. **Plan** (`server/src/planner/`, one LLM call). The model returns a typed JSON plan through `submit_plan`. Steps reference earlier outputs with `$refs`. When the model needs to see data before it can plan, it can return a read-only look first. Each turn allows two looks.
3. **Validate** (`server/src/core/compile.ts`). Code checks action ids, arguments, refs and required inputs. A plan that fails gets one repair call that sees the error.
4. **Execute** (`server/src/core/execute.ts`). A deterministic runner walks the plan's step graph. It runs the registered handlers along with `filter`, `exclude` and `forEach`. If a step fails before anything changed, there is one retry, and that retry sees the failure.
5. **Summarize** (`server/src/core/summarize.ts`). The reply is built from the step results, not written by the model: a verdict for questions, then the records touched.

**Context across turns.** The planner never sees the raw transcript. It gets two things. The first is the last four turns as text, in `<context>`. The second is up to 12 typed record identities from the chat, in `<recent_records>`. Follow-ups such as "make those due tomorrow" resolve against those identities. The identities are only ids and labels, so the records' current contents are read again when a plan uses them.

**Approval gates.** The model doesn't decide what needs approval; code does. Destructive and external actions (sends, payments, publications, syncs) pause for approval, and so does any write repeated over 3 or more records. The approval is bound to a hash of the plan and to the exact records the plan targets. If either changes, the plan asks again. A batch where some targets are blocked shows those targets, and you approve only the eligible ones ([partial confirmation](docs/PARTIAL-CONFIRMATION.md)).

**Baseline.** `server/src/server/baseline.ts` makes one model call per step, with tools. It runs on the same handlers and gates and is the comparison in BENCHMARK.md.

## How the tool list is narrowed

The planner never sees all 500 actions. Retrieval starts with 15 ranked slots, then adds selected lookup/dependency/look-alike helpers; the latest combined evaluation averages 21.8 final cards ([evidence](docs/PLANNER-OUTCOMES-VALIDATION.md)). See [docs/PLAN.md](docs/PLAN.md), section "Retrieval". It combines two rankings over a search card per action, with no LLM call:

- **BM25**, which matches words.
- **A small local embedding model** (bge-base, ~110 MB, downloaded once on first start), which matches meaning, so "hold off on the webinar emails" finds Pause campaign. Set `RETRIEVAL=bm25` to use BM25 alone.

- **Generated cards are supplemented by implemented contracts.** `server/src/retrieval/cards.json` holds LLM-generated descriptions, synonyms, record types and look-alike siblings. At runtime, implemented module descriptions/entity metadata and module-owned synonyms refine that surface; the new metadata changes did not regenerate cards through a model. The generator never sees `eval/`, and `retrieve.test.ts` fails if a synonym copies an eval paraphrase. See [what changed and why](docs/PLANNER-CHANGES.md#3-retrieve-the-final-action-and-the-right-lookup-dependencies).
- **Review status:** the initial five modules (M01, M03, M06, M48, M49) were reviewed during the original build. M45–M47's generated metadata has now been compared with the new handlers; registry descriptions and entities supply their implemented contracts. Aliases incorrectly promising SMS review requests, holiday hours, a pending ticket state or resolution SLA were corrected. Proposed extra sibling links were measured on development cases and not adopted because they increased shortlist size without improving recall. This is not a claim that all 500 cards have been reviewed; regenerating cards overwrites hand edits.
- Retrieval quality is measured with `npm run eval:retrieval` (recall@k per question group, with a held-out split; `--bm25` for BM25 alone). Original hybrid recall@15 was 94.9% vs 86.8% BM25 alone; across all 500 actions and 357 questions (112 added for the Wave 1 modules, held out from the card synonyms) hybrid recall@15 is 97.5%, 97.4% on the held-out test split. This is retrieval recall, not task success. The two off-topic examples are not rejected by retrieval; the planner still has to reject them.

## Module catalog, action schemas and registration

- **Catalog.** `server/src/registry/catalog.json` holds HighLevel's 50 modules × 10 actions, with ids `M01.A01` to `M50.A10` and their names. `npm run catalog` generated it from the assignment PDF, and it's committed, so nothing reads the PDF at runtime. Display names always come from this file, so an id and its name can't drift apart.
- **Modules.** Each module is a folder, such as `server/src/modules/m01-contacts/`. It has an `index.ts` that default-exports its actions (and any name resolvers), a `schema.ts`, and tests. `loadRegistry()` registers every folder that has an index file. Adding a capability means adding a folder; the core agent doesn't change.
- **Action definition.** An action is an `ActionDef` (`server/src/registry/define.ts`). Its main fields:
  - `id`
  - a user-language `description`, including how it differs from look-alike actions
  - `synonyms`
  - `risk` (`read`, `write`, `destructive` or `external`)
  - Zod `input` and `output` schemas. Inputs are strict, so a made-up param is rejected.
  - `entities` it produces and consumes, for retrieval dependencies
  - `siblings`, the look-alike actions in other modules
  - an optional `preflight`, bound to approval
  - the `handler`, which runs inside a transaction and throws an `ActionError` for expected failures
  - an `example` call for the smoke test
- **Checks at registration.** An id that isn't in the catalog fails, so does registering an id twice, and so does marking a destructive or external action as a side-effect-free query. The smoke test (`server/src/registry/smoke.test.ts`) runs every action's example call, a made-up param and an unknown id, and fails a module that registers only some of its catalog actions.
- **Search cards.** `npm run cards` has a model write the retrieval cards for modules missing from `server/src/retrieval/cards.json`, or rewrite the modules named. Rewriting overwrites any hand edits.

How to add a module, step by step: [docs/ADDING-A-MODULE.md](docs/ADDING-A-MODULE.md). The module contract: [docs/MODULE-CONTRACT.md](docs/MODULE-CONTRACT.md).

## Current implementation

`main` now holds all the planner work. The Luna line (#5) and the DeepSeek/Qwen line (#6) were merged into it.

The lookup and retrieval work came first. It covers consistent named lookup, child names bound to their parents, and clarifying questions tied to the action arguments that are actually missing. [Rationale](docs/PLANNER-CHANGES.md) · [scoped lookups and clarifications](docs/SCOPED-LOOKUPS-AND-CLARIFICATIONS.md).

The two merged lines add:
- Id arguments named for a role look up their record type.
- Invoices, quotes, orders and subscriptions can be named by state or owner, as in "Marco Patel's open invoice".
- Clarification repair, plus repair for invented ids.
- Up to two looks per turn, and a retry when a search finds nothing.
- Answers to questions start with a verdict, with record cards under it.
- The Qwen Token Plan adapter.

On main, the 2,580 deterministic tests, the typecheck and the web build all pass.

The live numbers are in BENCHMARK.md: DeepSeek on the Qwen Token Plan, both agents run at commit `b3a94d4`; see [Benchmark scope](#benchmark-scope). The earlier validation reports ([outcomes](docs/PLANNER-OUTCOMES-VALIDATION.md), [scoped lookups](docs/SCOPED-LOOKUPS-VALIDATION.md)) describe branches as they stood before the merge. Keep them as history; they don't score main.

All 500 actions in all 50 modules are executable. The first 18 modules (Contacts, Leads, Opportunities, Tasks, Notes, Tags, Conversations, SMS, Email, Campaigns, Appointments, Invoices, Payments, Reviews, Business Listings, Support Tickets, Users and Teams) were built in depth first and carry the scenario and module evals below; the other 32 were added in Wave 1 ([WAVE1-REPORT.md](WAVE1-REPORT.md)) and then hardened ([WAVE1-HARDENING-REPORT.md](WAVE1-HARDENING-REPORT.md), assumptions in [WAVE1-ASSUMPTIONS.md](WAVE1-ASSUMPTIONS.md)). The backend suite has 2,580 deterministic tests. The regression scenarios cover the first 18 modules; the other 32 have their own set of 27 planner scenarios (`eval/module-scenarios/wave1`), which scored 95.1% in the final DeepSeek benchmark and historically 96% of clean runs on Haiku (3 repeats), up from 66.7% before the failure classes it exposed were fixed. In that run, one scenario failed every repeat: the planner read "Move X from Starter to Pro" as an opportunity stage change instead of a subscription plan change. It is recorded, not patched.

The new thirty actions use the existing registry, compiler, executor, approval gates, replay ledger, SQLite persistence, audit, traces and UI. [Implementation contract](docs/M45-M47-SCOPE.md) · [Module-building guide](docs/ADDING-A-MODULE.md). Ticket-reply batches now disclose known blocked targets and require approval of the eligible subset before sending; see [subset confirmation](docs/PARTIAL-CONFIRMATION.md). Earlier Sol scores below precede this policy change.

- Reviews: draft/send/cancel requests, record/search reviews, draft/publish responses and compute rating summaries. Requests are marketing emails and respect opt-outs/DND.
- Listings: one profile per business/location/directory; the same business on Google and Yelp is valid and ambiguous by name alone. Changes increment a version; publication syncs that version. Hours use America/New_York, all seven days, one interval per day; no overnight/split shifts.
- Tickets: requester/contact links, eligible support owners, priority/status/history, private notes, replies and **elapsed first-response SLA**, not resolution SLA. Targets: urgent 1h, high 4h, normal 24h, low 72h. Exactly at deadline meets it. Reopening does not reset it. Only delivered requester replies count; automatic acknowledgements do not exist. Closed/resolved tickets must reopen before a reply.
- New customer sends need their domain permission plus `messaging.send`; ordinary reads/internal writes retain the existing selective permission policy. This is not a global authorization retrofit. Publication needs reputation permission, not messaging permission.
- Generic email preview/send/schedule routes module-owned kinds back to the review/ticket action so request state and ticket SLA cannot be skipped. Ticket emails bypass marketing preferences under simulator policy but **never** the address requirement.

All messages, payments, review publications and directory syncs are **simulated**; no email provider, HighLevel account or real directory is contacted. The planner calls a real model when configured; retrieval embeddings run locally. Failed module-owned sends roll back their database effects and surface in traces. Injected directory failure likewise preserves the previous published version; it does not manufacture a stored failed sync after rollback.

## Run locally

Use a Node release supporting `node:sqlite` (this branch was tested on Node 26). Install dependencies in both `server/` and `web/` with `npm ci`. Copy `.env.example` to `.env` in the repository root. The planner is chosen for you when `PLANNER` is unset:

- **With a Qwen Token Plan key** (`QWEN_API_KEY`, see below), it runs `qwen` with `deepseek-v4.1-flash-1017`, the setup BENCHMARK.md measured.
- **Without one**, it runs `claude-cli` on `claude-haiku-5-5` for both tiers. That needs only an authenticated Claude CLI (`claude auth login`) with available quota.

To force one, set `PLANNER=claude-cli` or `PLANNER=qwen`. With `PLANNER` unset, every command (`serve`, `ask`, `probe:planner`, `eval:scenarios`) prints the provider it picked on stderr, so an eval can't run on the Claude subscription unnoticed. Set `CLAUDE_MODEL` (and optionally `CLAUDE_FAST_MODEL`) for another Claude model. Give the full id, not the `haiku` alias: Claude CLI 2.1.284 maps the alias to `claude-haiku-4-5-20251001`, which scored 91.3% on the 23-scenario regression suite at a 23.9 s median turn, against 100% over 8 repeats at 7.2 s for `claude-haiku-5-5`. The CLI logs `claude-haiku-5-5` as `unrecognized_model` but serves it.

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

### Benchmark scope

[BENCHMARK.md](BENCHMARK.md) covers every active scenario suite: 273 scenarios, each run 3 times (819 runs per agent), touching all 50 modules, with at least one checked action in every module. Both agents ran on deepseek-v4.1-flash-1017 through the Qwen Token Plan at commit `b3a94d4` on 2026-10-27, over the same scenario files (set `958de2e6710f`). The report's "uncommitted edits" note is the two M25 scenarios in `wave1/commerce.json`, which were committed right after the run. PR #15 (d9d59c6, which drops filters with no condition, and 89300d1, the `<new_step_ids>` line after a look) merges after `b3a94d4`, so these numbers don't include those two fixes; #15 has only a lean rerun, where 0 of 9 plans after a look reused the looked steps' ids, against 7 of 16 before. Earlier BENCHMARK.md versions (DeepSeek over 86 scenarios × 1; Haiku 5.5 through `claude -p` over 23 × 3) are in git history.

Task success per suite, 3 runs each (from `eval/results/scenarios-final-deepseek-{planner,baseline}-3x.json`):

| Suite | Scenarios | Planner | Baseline |
| --- | ---: | ---: | ---: |
| `eval/scenarios` (regression, first 18 modules) | 23 | 97.1% | 79.7% |
| `eval/brief-scenarios` (the brief's examples and held-out variants) | 12 | 75.0% | 61.1% |
| `eval/param-scenarios` (every argument checked) | 51 | 99.3% | 96.7% |
| `eval/module-scenarios/coverage` | 75 | 98.7% | 96.0% |
| `eval/module-scenarios/wave1` (the 32 Wave 1 modules) | 27 | 95.1% | 86.4% |
| `eval/module-scenarios/m45-m47/development` | 45 | 98.5% | 97.8% |
| `eval/module-scenarios/m45-m47/reporting` (held out) | 12 | 91.7% | 97.2% |
| `eval/module-scenarios/m45-m47/trails` | 3 | 100% | 66.7% |
| `eval/module-scenarios/questions` | 22 | 93.9% | 86.4% |
| `eval/module-scenarios/role-ids` | 1 | 66.7% | 100% |
| `eval/policy-scenarios/partial-confirmation` | 2 | 100% | 0% |

The baseline wins two rows. On the held-out M45–M47 reporting set it scores 97.2% to the planner's 91.7% (35/36 against 33/36), and on the single role-id scenario it scores 3/3 to 2/3. The partial-confirmation scenarios need the subset approval only the planner's gate produces, so the baseline fails all of them. Small suites move a lot on one run; read their gaps with care.

Reproduce it from `server/` with the Token Plan key in `.env` (see [Use a Qwen Token Plan locally](#use-a-qwen-token-plan-locally)); BENCHMARK.md's Reproduce section has the same commands:

```sh
export PLANNER=qwen QWEN_MODEL=deepseek-v4.1-flash-1017
DIRS=eval/scenarios,eval/brief-scenarios,eval/param-scenarios,eval/module-scenarios/coverage,eval/module-scenarios/wave1,eval/module-scenarios/m45-m47/development,eval/module-scenarios/m45-m47/reporting,eval/module-scenarios/m45-m47/trails,eval/module-scenarios/questions,eval/module-scenarios/role-ids,eval/policy-scenarios/partial-confirmation
npm run eval:scenarios -- --scenario-dir $DIRS --repeat 3 --label final-deepseek-planner-3x
npm run eval:scenarios -- --scenario-dir $DIRS --repeat 3 --label final-deepseek-baseline-3x --agent baseline
npm run report -- --label final-deepseek-planner-3x --compare final-deepseek-baseline-3x
```

The planner run took about 8.5 minutes and the baseline about 14 on the Token Plan.

Codex integration is available in this branch: explicitly select `PLANNER=codex-cli` (otherwise the default is qwen with a Token Plan key, else Claude). Full GPT-6.1 Sol low-reasoning evaluations score 91.9% development, 91.3% original regression and 83.3% reporting, versus Luna's 85.2%, 56.5% and 72.2%. Sol improves overall quality but still misses acceptance. See the [delivery and evaluation report](docs/M45-M47-FINAL-REPORT.md) for counts, test conditions, test-set revisions and remaining planner gaps. Do not substitute adapter tests or retrieval recall for AI task success.


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
between. Get an `sk-sp-` key from the Token Plan console (Singapore only) and set it as
`QWEN_API_KEY` in your local `.env`. With `PLANNER` unset, the key alone selects this provider;
the literal `sk-sp-...` placeholder counts as no key. Then run any command from `server/`:

```sh
npm run probe:planner
npm run serve
npm run ask -- "create a task to call Jo"
```

`QWEN_MODEL` and `QWEN_FAST_MODEL` select the strong/fast models (`QWEN_MODEL` defaults to
`deepseek-v4.1-flash-1017`, `QWEN_FAST_MODEL` to `QWEN_MODEL`). Thinking is off (`enable_thinking: false`);
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
QWEN_MODEL=qwen3.8-flash npm run serve   # the Qwen flagship on the same key; no format flag needed
```

Measured 2026-10-25 on the module scenarios with real list rates (regression: 23 scenarios x 3
repeats; development: 45 scenarios):

| model | regression | development | median turn | $/turn |
| --- | --- | --- | --- | --- |
| qwen3.8-flash | 90.9% | 97.8% | 5.0 s / 3.2 s | 0.00044 / 0.00063 |
| deepseek-v4.1-flash-1017 (adapter default) | 95.7% | 97.8% | 1.9 s / 1.1 s | 0.00048 / 0.00065 |

DeepSeek's regression figure is the lower of two batches (the other was 98.6%) and Qwen's is a
four-batch mean; a single batch moves by 1-3 points, so read gaps under ~5 points as noise. Batches:
`eval/results/scenarios-ds-default-check-*.json`, `scenarios-base-ds-reg-3x-jo.json`,
`scenarios-reg-fix{4,5,6,7}-qf-3x.json`, `scenarios-dev-smoke-compilerfix.json`.

## Known limitations

- **The direct-reply latency targets are missed.** In BENCHMARK.md the direct first reply is 1.7 s at p50 and 3.5 s at p95, against 1.5 s and 3.0 s. The complex targets are met (end-to-end 2.1 s p50, 7.7 s p95, against 6.0 s and 12.0 s). Most of a direct reply is one DeepSeek call, whose speed varies by day: an earlier 86-scenario run met the direct targets at 1.5 s / 2.5 s. Every `claude -p` call starts a new process, and the earlier Haiku benchmark had a direct p50 of 8.1 s. There is no Anthropic API adapter, so Claude can't be measured without the process overhead.
- **Cost is unknown on subscription planners.** The Claude and Codex CLIs and the prepaid Token Plan report no USD cost. The cost figures here come from list rates.
- **The final benchmark is one model.** It ran on DeepSeek only; the planned Haiku secondary run was not done. Earlier Haiku, Sol and Luna numbers are on different scenario sets and commits, so they don't compare with it.
- **Multi-step follow-ups are the weak spot.** The brief's suite scores 75% for the planner (61.1% for the baseline). Its follow-ups ("only include Facebook leads") and the held-out lead-filtering variants fail most; these are model misreads (an inverted filter, a filter read as a field update) that the validator can't catch because the plan is well-formed. Four question scenarios also fail on the reply's wording (a missing leading "yes" or "no", or a count), not on the data.
- **Known planner misses are recorded, not patched.** For example, "Move X from Starter to Pro" is read as an opportunity stage change rather than a plan change. [PLANNER-CHANGES.md](docs/PLANNER-CHANGES.md) lists what is still unsolved.
- **Retrieval can miss.** Hybrid recall@15 is 97.5%, so about 1 question in 40 doesn't get the right card into the shortlist. The planner can ask for another retrieval round (`search_tools`, up to twice), but it can't use an action it never sees.
- **Each turn is bounded.** A turn gets two looks, two `search_tools` rounds, one compile repair and one retry after a failed run. Requests that need longer chains of read-then-decide steps hit those limits and stop with an honest partial reply.
- **Everything is simulated.** The CRM is a single SQLite database with a frozen clock and a seeded demo tenant. Messages, payments, publications and directory syncs never leave the process. There is no real auth, and there is no multi-tenant isolation. Permissions are checked selectively, not globally.
- **The cards are LLM-generated.** Only the first five modules and M45–M47 were reviewed by hand. Regenerating the cards overwrites hand edits.
- **Context is short.** The planner gets the last four turns and 12 record identities. Anything older has to be named again.

## Scaling beyond 500 actions

The prompt doesn't grow with the catalog. The planner sees a fixed shortlist of about 22 cards, whether there are 500 actions or 5,000. Here is what grows, and what would change at 5,000 and beyond:

- **Retrieval index.** BM25 and the in-memory cosine scan are linear in the number of cards, and both take milliseconds at 500. The card vectors are cached on disk (`server/data/vectors-*.bin`), keyed by a hash of all card texts. Changing any card re-embeds the whole set, which takes about 30 s at 500 because cards are embedded one at a time. At 5,000 or more cards, three changes would be needed: cache each card by its own hash, embed in batches, and replace the scan with an approximate-nearest-neighbour index.
- **Precision drops before recall.** More actions means more near-duplicates ("send email" in five modules). Two things already help here: the look-alike sibling links on cards, and the lookup helpers pulled in for the record types the message names. The next step would be a two-stage retrieval: pick modules first, then actions within them. Recall@k should be re-measured per module group as the catalog grows.
- **Cards and registration.** Each new module follows [docs/ADDING-A-MODULE.md](docs/ADDING-A-MODULE.md): a handler file, its schemas, a generated card and smoke coverage. The smoke test checks every action automatically for a valid call, an unknown param and an unknown id. That keeps the per-action cost low, but card review is manual, and at thousands of actions it would need sampling.
- **Evals.** The suites are per module group, so new modules add their own sets without touching the regression fingerprint. A full run at this size costs real planner quota, so CI should run the regression set and sample the rest.
- **Execution and gates.** These scale per request, not per catalog. Risk comes from each action's registered `risk` (`read`, `write`, `destructive` or `external`), so a new action gets approval gates without any new gate code.

## The Claude CLI planner, and what it can't measure

The default planner (`server/src/planner/claude-cli.ts`) runs `claude -p` on a Claude subscription, with a clean environment, no tools and a JSON-schema output. This project has no Anthropic API key, and a subscription login must not be used for raw API calls, so that's how every Claude number was measured; the final benchmark uses DeepSeek through the `qwen` provider instead. It has four limits, also listed in [BENCHMARK.md](BENCHMARK.md):

- **Cost is an estimate.** Dollars are Claude Code's own figure at API list prices (`total_cost_usd`); nothing was billed. Input, cache-read, cache-write, output and thinking tokens are reported separately, and the benchmark leads with tokens and model calls.
- **No temperature control,** so every scenario runs three times.
- **No control over cache breakpoints.** Claude Code places them. The app keeps the system prompt byte-identical between calls so the prefix can be read from cache.
- **Latency includes the CLI.** Each call starts a `claude` process (about 0.7 s). The planner answers as soon as the result JSON is printed, without waiting about 0.8 s for the process to exit, and records the CLI's reported model time (`apiMs`) beside the wall clock.

**Every turn has a budget** (`server/src/planner/turn.ts`): at most 8 planner calls, repairs and look-ups included, and 180 seconds. Each call's timeout is cut to whatever time the turn has left. A web client that closes the stream (a closed tab, a reload) aborts the call in flight and kills the `claude` process. A turn that runs out of budget, or is cancelled, changes nothing. Approved runs are not cancelled by a disconnect.

**Every planner call is traced.** The `planner.reply` event, and `plannerCalls` on each turn in `eval/results/*.json`, record the call number, model, a hash of the system prompt and of the user prompt, wall-clock and model latency, provider attempts, model requests, whether it was a repair, and token usage.

**A new provider is one file.** `server/src/planner/qwen.ts` is a direct HTTP provider (OpenAI-compatible chat completions, JSON-schema output, retries with backoff, timeouts) behind the same `Planner` interface in `server/src/planner/types.ts`. Adding it took that file and one branch in `makePlanner` (`server/src/planner/index.ts`); nothing in retrieval, compiling, execution or approval changed. An Anthropic API provider would be the same shape.

## Layout

```
server/   Node + TypeScript backend (registry, modules, store, agent core)
eval/     scenarios, runner, smoke tests, benchmark report
web/      Vue 3 chat UI
docs/     assignment, plan, module contract, verification reports
```

Reports from the two later waves are at the repository root: [WAVE1-REPORT.md](WAVE1-REPORT.md), [WAVE1-HARDENING-REPORT.md](WAVE1-HARDENING-REPORT.md) and [WAVE1-ASSUMPTIONS.md](WAVE1-ASSUMPTIONS.md). Raw eval runs are in `eval/results/`; `docs/trajectory.html` charts them.
