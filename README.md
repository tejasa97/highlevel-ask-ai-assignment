# Ask AI — 500-action agent framework

A natural-language assistant over a simulated CRM: 50 modules × 10 actions, with measured latency, cost and quality.

All 500 actions are implemented against a simulated backend (SQLite, frozen clock, deterministic seed). A planner model returns a whole plan as structured output; code validates it, shows it, runs it, and decides what needs approval from the exact records a step touches. The planner is the only real model call; messages, payments and directory syncs are simulated ([Real vs mocked](#real-vs-mocked)).

**Results** ([BENCHMARK.md](BENCHMARK.md)): 273 scenarios × 3 runs across all 50 modules, on DeepSeek (`deepseek-v4.1-flash-1017` through the Qwen Token Plan). The planner passes 96.9% of runs against 91.6% for a one-call-per-step baseline, with a 1.3 s median direct reply (2.3 s for the baseline), a median of 1 model call per complex task (5 for the baseline), and $0.0043 per successful task ($0.0073) at list rates. One latency target is missed: the direct-reply p95. See [Trade-offs](#latency-cost-and-quality-trade-offs) and [Known limitations](#known-limitations).

## Quick start

Needs a Node release with `node:sqlite` (tested on Node 26). Copy `.env.example` to `.env` in the repository root and put a Token Plan key in `QWEN_API_KEY`. Then, in `server/`:

```sh
npm ci && npm run db:reset && npm run serve
```

and in `web/`:

```sh
npm ci && npm run dev
```

The API listens on 8787 and the chat UI on http://localhost:5173. The planner is chosen for you when `PLANNER` is unset, and the startup line says which:

- **With a Qwen Token Plan key** (`QWEN_API_KEY`), it runs `qwen` on `deepseek-v4.1-flash-1017`, the setup BENCHMARK.md measured.
- **Without one**, it runs `claude-cli` on `claude-haiku-5-5`. That needs only an authenticated Claude CLI (`claude auth login`).

`.env.example` documents every variable. Provider details, the optional Codex provider and model overrides are in [docs/PROVIDERS.md](docs/PROVIDERS.md). For concurrent copies, set `PORT` for the API and a matching `API_PORT` for Vite. `npm run db:reset` (or **↺ Reset data** in the UI) restores the seed; it erases the local demo database.

Try:
- `Create a task to send the proposal to Marco Patel, due Friday`, then `Actually give it to Aisha and make it high priority`
- `I keep forgetting to follow up with new leads. Help me stay on top of them.`
- `Find leads created last week who have not replied, exclude anyone with a booked appointment, assign the remaining leads to available sales reps, and create follow-up tasks.`
- `Make Aisha the owner of Zoe Costa` (there are two, so it asks which)

## Architecture

Each turn is one planner call wrapped in code. The full design is in [docs/PLAN.md](docs/PLAN.md), §1–§3; [docs/PROMPT-EXAMPLE.md](docs/PROMPT-EXAMPLE.md) walks through the planner prompt over two turns: the prompt as today's code builds it, with the replies, token counts and timings recorded in the release benchmark.

1. **Retrieve** (`server/src/retrieval/`, no LLM). BM25 and local embeddings rank about 22 action cards out of 500 (see below). Named records in the message are resolved to typed mentions.
2. **Plan** (`server/src/planner/`, one LLM call). The model returns a typed JSON plan through `submit_plan`. Steps reference earlier outputs with `$refs`. When the model needs to see data before it can plan, it can return a read-only look first. Each turn allows two looks.
3. **Validate** (`server/src/core/compile.ts`). Code checks action ids, arguments, refs and required inputs. A plan that fails gets a repair call that sees the errors, and a second one if the first got closer (fewer errors).
4. **Execute** (`server/src/core/execute.ts`). A deterministic runner walks the plan's step graph. It runs the registered handlers along with `filter`, `exclude` and `forEach`. If a step fails before anything changed, there is one retry, and that retry sees the failure.
5. **Summarize** (`server/src/core/summarize.ts`). The reply is built from the step results, not written by the model: the records touched, and which steps completed, failed or are waiting. The one exception is a question about records: after its look, the model writes the verdict (Yes, No, or the number) from what the reads returned, and the looked records are shown under it.

**Context across turns.** The planner never sees the raw transcript. It gets two things. The first is the last four turns as text, in `<context>`. The second is up to 12 typed record identities from the chat, in `<recent_records>`. Follow-ups such as "make those due tomorrow" resolve against those identities. The identities are only ids and labels, so the records' current contents are read again when a plan uses them.

**Clarification.** When a required argument can't be resolved (two Zoe Costas, a listing on two directories), the reply is one focused question tied to that argument, with the candidates as options. The answer is merged into the original request, so the user doesn't repeat it.

**Approval gates.** The model doesn't decide what needs approval; code does. Destructive and external actions (sends, payments, publications, syncs) pause for approval, and so does any write repeated over 3 or more records. The approval is bound to a hash of the plan and to the exact records the plan targets. If either changes, the plan asks again. A batch where some targets are blocked shows those targets, and you approve only the eligible ones ([partial confirmation](docs/PARTIAL-CONFIRMATION.md)).

**Turn budget.** At most 8 planner calls (repairs and looks included) and 180 seconds per turn. A turn that runs out, or is cancelled, changes nothing.

**Baseline.** `server/src/server/baseline.ts` is the usual tool-calling loop: one model call per step, each seeing the last result. It runs on the same shortlist, handlers and gates, and is the comparison in BENCHMARK.md.

## The chat UI

`web/` is a Vue 3 app. The top bar picks the acting user (permissions and deactivated users are enforced) and the model tier, and shows the seed's fixed clock.

- **Progress while it runs.** Each turn streams its events: the retrieval shortlist, the planner call, then every step as it starts and finishes (✓ done, ◐ partial, ✕ failed, – skipped). No spinner stands in for progress.
- **Approval before bulk, destructive or external writes.** The approval card lists the exact records each write will touch and any that are blocked; **Approve** (or **Approve eligible only**) runs it, and **Cancel** changes nothing.
- **Clarifying questions** offer the candidates as buttons, or take a typed answer.
- **Outcomes** are record cards built from the results. A failed step says what failed; **↻ Retry** reruns a turn.
- **The side panel** has three tabs. **Trace** shows retrieval scores, the system prompt, the plan and every handler call. **Changes** shows every row the turn changed, marked "after approval" where it was. **Data** browses the tables. Clicking a chat message selects its turn.

## How the tool list is narrowed

The planner never sees all 500 actions. Retrieval starts with 15 ranked slots, then adds the lookup, dependency and look-alike helpers the request needs; the latest combined evaluation averages 21.8 final cards ([evidence](docs/SCOPED-LOOKUPS-AND-CLARIFICATIONS.md#verification-and-measurement-boundaries)). It combines two rankings over a search card per action, with no LLM call:

- **BM25**, which matches words.
- **A small local embedding model** (bge-base, ~110 MB, downloaded once on first start), which matches meaning, so "hold off on the webinar emails" finds Pause campaign. Set `RETRIEVAL=bm25` to use BM25 alone.

Look-alike actions in different modules ("send email" exists in several) are told apart three ways: each card's description says how it differs from its siblings, the siblings are linked so the planner sees them side by side, and the record types named in the message pull in the matching lookups.

- **Cards.** `server/src/retrieval/cards.json` holds LLM-generated descriptions, synonyms, record types and look-alike siblings; at runtime, each module's registered descriptions, entities and synonyms refine them. The generator never sees `eval/`, and `retrieve.test.ts` fails if a synonym copies an eval paraphrase. Only some modules' cards were reviewed by hand ([status](docs/IMPLEMENTATION-NOTES.md#search-card-review-status)).
- **Measured.** `npm run eval:retrieval` reports recall@k per question group, with a held-out split. Across all 500 actions and 357 scored questions, hybrid recall@15 is 97.6% (97.4% on the 150-question held-out split). On the original question set it was 94.9%, against 86.8% for BM25 alone. This is retrieval recall, not task success. Off-topic requests aren't rejected by retrieval; the planner rejects them.

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
- **Checks at registration.** An id that isn't in the catalog fails, so does registering an id twice, and so does marking a destructive or external action as a side-effect-free query.
- **Search cards.** `npm run cards` has a model write the retrieval cards for modules missing from `server/src/retrieval/cards.json`, or rewrite the modules named. Rewriting overwrites any hand edits.

How to add a module, step by step, and the contract each module follows: [docs/ADDING-A-MODULE.md](docs/ADDING-A-MODULE.md). Product decisions made without an owner to ask (which actions need which permission, what was left out) are in [WAVE1-ASSUMPTIONS.md](WAVE1-ASSUMPTIONS.md).

## Real vs mocked

| Real | Simulated or mocked |
|---|---|
| The planner model call (DeepSeek through the Qwen Token Plan, or Claude or Codex through their CLIs) | No HighLevel account or API is contacted |
| Retrieval: BM25 and a local embedding model | The CRM: one SQLite database with a seeded demo tenant and a frozen clock |
| All 500 handlers: stateful, validated, transactional, failing on bad input, missing records, permissions and business rules | Emails, SMS, payments, review publications and directory syncs never leave the process; they are recorded as if sent |
| Approval gates, the audit log, traces and token accounting | Provider outages (an email provider down, a directory sync failing) are injected by the eval runner |
| Permissions per acting user, including deactivated users | No real auth and no multi-tenant isolation; permissions are checked per action, not globally |

Cost is real tokens priced at list rates: the Token Plan is prepaid, so no money was billed per request.

## Verify and evaluate

In `server/`, `npm run typecheck` and `npm test` run the 2,603 deterministic tests. They include the **smoke test of all 500 handlers** (`server/src/registry/smoke.test.ts`): every action's example call, a made-up param and, for actions with a required id, an unknown id, and a check that each module registers all ten of its catalog actions. In `web/`, run `npm run build`.

**The eval dataset** is 273 scenarios across all 50 modules, with at least one checked action in every module: 150 direct, 25 indirect, 44 multi-step, 13 follow-up, 11 ambiguous, 3 unsupported and 27 failure cases. Each scenario is a JSON conversation with expected outcomes and automated assertions on the status, the actions planned, their arguments, the reply, and the **final database state** (SQL queries). Every run starts from a fresh seeded database and goes through the same conversation code as the web app.

| Suite | Scenarios | Planner | Baseline |
| --- | ---: | ---: | ---: |
| `eval/scenarios` (regression, first 18 modules) | 23 | 94.2% | 82.6% |
| `eval/brief-scenarios` (the brief's examples and held-out variants) | 12 | 82.9% | 58.8% |
| `eval/param-scenarios` (every argument checked) | 51 | 98.0% | 96.7% |
| `eval/module-scenarios/coverage` | 75 | 97.3% | 96.9% |
| `eval/module-scenarios/wave1` (the 32 modules added in Wave 1) | 27 | 98.8% | 90.0% |
| `eval/module-scenarios/m45-m47/development` | 45 | 99.3% | 97.7% |
| `eval/module-scenarios/m45-m47/reporting` (held out) | 12 | 100% | 94.3% |
| `eval/module-scenarios/m45-m47/trails` | 3 | 100% | 88.9% |
| `eval/module-scenarios/questions` | 22 | 97.0% | 84.8% |
| `eval/module-scenarios/role-ids` | 1 | 33.3% | 100% |
| `eval/policy-scenarios/partial-confirmation` | 2 | 100% | 0% |

Task success per suite over 3 runs each, from `eval/results/scenarios-release-deepseek-{planner,baseline}-3x.json`. Runs that failed outside the app (timeouts: 5 planner, 7 baseline) are left out of the rates, as in BENCHMARK.md. The baseline wins one row: the single role-id scenario, 3/3 against the planner's 1/3. The partial-confirmation scenarios need the subset approval only the planner's gate produces, so the baseline fails all of them. Small suites move a lot on one run.

**Reproduce** from `server/` with the Token Plan key in `.env`. The planner run took about 10.5 minutes and the baseline about 15.7:

```sh
export PLANNER=qwen QWEN_MODEL=deepseek-v4.1-flash-1017
DIRS=eval/scenarios,eval/brief-scenarios,eval/param-scenarios,eval/module-scenarios/coverage,eval/module-scenarios/wave1,eval/module-scenarios/m45-m47/development,eval/module-scenarios/m45-m47/reporting,eval/module-scenarios/m45-m47/trails,eval/module-scenarios/questions,eval/module-scenarios/role-ids,eval/policy-scenarios/partial-confirmation
npm run eval:scenarios -- --scenario-dir $DIRS --repeat 3 --label release-deepseek-planner-3x
npm run eval:scenarios -- --scenario-dir $DIRS --repeat 3 --label release-deepseek-baseline-3x --agent baseline
npm run report -- --label release-deepseek-planner-3x --compare release-deepseek-baseline-3x   # writes BENCHMARK.md
npm run eval:retrieval     # retrieval recall@k
npm run trajectory         # docs/trajectory.html, every recorded planner run charted
```

Both agents ran at commit `d74874f` on 2026-10-27, over the same scenario files (set `958de2e6710f`). Every run is kept in `eval/results/`, and `eval/results/history.jsonl` lists them; earlier benchmarks (DeepSeek over 86 scenarios, Haiku 5.5 over 23 × 3) are in git history. Each turn's trace (retrieval, planner calls with tokens and latency, every handler call) is in the result files and in the UI's Trace tab.

## Latency, cost and quality trade-offs

The targets were committed in [docs/PLAN.md](docs/PLAN.md) on 2026-10-23, before the final runs, and were not relaxed afterwards:

| Target | Limit | Planner | Baseline | Verdict (planner) |
|---|---:|---:|---:|---|
| Direct: first reply p50 | ≤ 1.5 s | 1.3 s | 2.3 s | met |
| Direct: first reply p95 | ≤ 3.0 s | 4.3 s | 5.3 s | **missed** |
| Complex: end-to-end p50 | ≤ 6.0 s | 1.6 s | 4.2 s | met |
| Complex: end-to-end p95 | ≤ 12.0 s | 7.8 s | 9.5 s | met |
| Action selection (direct / complex) | ≥ 95% / ≥ 85% | 99.2% / 98.3% | | met |
| Task success, all | ≥ 85% | 96.9% | 91.6% | met |
| Model calls per complex task, median | ≤ 2 | 1 | 5 | met |

"First reply" is the first useful reply (the answer, a clarifying question, or the approval prompt with the plan); a loading indicator doesn't count.

**Why one plan per turn beats one call per step:**
- **Speed.** A complex request is one model round trip, not one per step, so end-to-end time barely grows with the number of steps (1.6 s p50 against 4.2 s).
- **Cost.** The baseline resends the growing conversation on every step: 21,063 input tokens per run against 12,852, and $0.0073 against $0.0043 per successful task, retries and failed runs included. 74% of the planner's input tokens are read from the provider's prompt cache, because the system prompt is kept byte-identical between calls.
- **Quality.** The whole plan is validated before anything runs, so a bad argument or an invented id is repaired before any write, and the approval gate sees every record the plan will touch. The baseline can only find a problem when it reaches that step (91.6% against 96.9% overall; 58.8% against 82.9% on the brief's own examples).

**What it costs:**
- **The planner can't react to data it hasn't seen.** When the plan depends on what a search returns, it spends a look (a read-only call, then a second planner call), so those turns cost two calls. A turn allows two looks.
- **A well-formed plan can still be the wrong plan.** Validation catches broken plans, not misread intent: an inverted filter passes every check. Those misses are the follow-up failures below.
- **Speed depends on one provider call.** The direct p95 miss is DeepSeek's latency tail, not app time; an earlier 86-scenario run met it at 2.5 s.

## Known limitations

- **The direct-reply p95 target is missed:** 4.3 s against 3.0 s. Most of a direct reply is one DeepSeek call, whose speed varies by day.
- **Multi-step follow-ups are the weak spot.** The brief's suite passes 82.9% of runs for the planner (58.8% for the baseline). Its follow-up "Only include leads from the Facebook campaign, and make those tasks due tomorrow" and the held-out lead-filtering variants fail most. Most of those are model misreads (an inverted filter, a filter read as a field update) that the validator can't catch because the plan is well-formed; one run ended with a plan still invalid after repair. Two question scenarios fail on the reply's wording (a missing leading "no"), not on the data.
- **Known misses are recorded, not patched.** BENCHMARK.md lists [every failing run](BENCHMARK.md#every-failing-run); no scenario was edited to pass.
- **The final benchmark is one model.** It ran on DeepSeek only. Earlier Haiku, GPT-6.1 Sol and GPT-6 Luna numbers are on different scenario sets and commits, so they don't compare with it.
- **Cost is unknown on subscription planners.** The Claude and Codex CLIs and the prepaid Token Plan report no USD cost; the figures here come from list rates.
- **Retrieval can miss.** Hybrid recall@15 is 97.6%, so about 1 question in 40 doesn't get the right card into the shortlist. The planner can ask for another retrieval round (`search_tools`, up to twice), but it can't use an action it never sees.
- **Each turn is bounded.** A turn gets two looks, two `search_tools` rounds, one compile repair (two if the first got closer) and one retry after a failed run, within eight planner calls and 180 seconds. Requests that need longer chains of read-then-decide steps stop with an honest partial reply.
- **Everything is simulated.** See [Real vs mocked](#real-vs-mocked).
- **The cards are LLM-generated.** Only the first five modules built (M01, M03, M06, M48, M49) and M45–M47 were reviewed by hand. Regenerating the cards overwrites hand edits.
- **Context is short.** The planner gets the last four turns and 12 record identities. Anything older has to be named again.

## Scaling beyond 500 actions

The prompt doesn't grow with the catalog. The planner sees a fixed shortlist of about 22 cards, whether there are 500 actions or 5,000. Here is what grows, and what would change at 5,000 and beyond:

- **Retrieval index.** BM25 and the in-memory cosine scan are linear in the number of cards, and both take milliseconds at 500. The card vectors are cached on disk (`server/data/vectors-*.bin`), keyed by a hash of all card texts. Changing any card re-embeds the whole set, which takes about 30 s at 500 because cards are embedded one at a time. At 5,000 or more cards, three changes would be needed: cache each card by its own hash, embed in batches, and replace the scan with an approximate-nearest-neighbour index.
- **Precision drops before recall.** More actions means more near-duplicates ("send email" in five modules). Two things already help here: the look-alike sibling links on cards, and the lookup helpers pulled in for the record types the message names. The next step would be a two-stage retrieval: pick modules first, then actions within them. Recall@k should be re-measured per module group as the catalog grows.
- **Cards and registration.** Each new module follows [docs/ADDING-A-MODULE.md](docs/ADDING-A-MODULE.md): a handler file, its schemas, a generated card and smoke coverage. The smoke test checks every action automatically for a valid call, an unknown param and (where an id is required) an unknown id. That keeps the per-action cost low, but card review is manual, and at thousands of actions it would need sampling.
- **Evals.** The suites are per module group, so new modules add their own sets without touching the regression fingerprint. A full run at this size costs real planner quota, so CI should run the regression set and sample the rest.
- **Execution and gates.** These scale per request, not per catalog. Risk comes from each action's registered `risk` (`read`, `write`, `destructive` or `external`), so a new action gets approval gates without any new gate code.
- **Filtering and joins run in application memory.** Each handler loads its rows with `store.find(table, predicate)` over JSON-document rows. A cross-module question ("leads from last week with no reply") is joined in memory by the generic filter and exclude steps. Three things make that the right choice here. First, the catalog fixes the actions: `M11.A10` takes no list of lead ids, and `M03.A03` has no "not replied" filter. Second, the seed data is tiny, so a scan takes well under a millisecond and the planner call dominates. Third, the generic join steps let the planner combine any of the 500 actions. With real data volumes, three changes would be needed:
  1. Push each handler's filters into SQL, with typed or generated columns and indexes.
  2. Let reads accept id lists from earlier steps (for example `leadIds: $s1.items[*].id`), so a later step only reads the earlier step's records.
  3. Paginate, and stream pages through `forEach`, instead of the 500-row cap.
- **Providers.** A new model provider is one file behind the `Planner` interface; nothing in retrieval, compiling, execution or approval changes ([docs/PROVIDERS.md](docs/PROVIDERS.md)).

## Layout and further reading

```
server/   Node + TypeScript backend (registry, modules, store, agent core)
eval/     scenarios, results, targets
web/      Vue 3 chat UI
docs/     design, module contract, planner notes, providers
```

- [docs/PLAN.md](docs/PLAN.md): architecture, design and the 5-day schedule
- [docs/PLANNER-CHANGES.md](docs/PLANNER-CHANGES.md): what changed in shared lookup, retrieval and planner handling, and why each change was needed
- [docs/PROVIDERS.md](docs/PROVIDERS.md): the Qwen, Claude CLI and Codex providers, turn budgets and planner tracing
- [docs/IMPLEMENTATION-NOTES.md](docs/IMPLEMENTATION-NOTES.md): build history, and the rules for reviews, listings and tickets
- [docs/JOURNEY.md](docs/JOURNEY.md): what was tried, what failed and what changed, in order, with the numbers at each step
- [docs/ai-for-backend-engineers.html](docs/ai-for-backend-engineers.html): a guide to how the app works, for backend engineers new to LLM systems
- `docs/trajectory.html` charts every recorded planner run
