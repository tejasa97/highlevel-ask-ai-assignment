# Ask AI — Build Plan

Working plan for the HighLevel "Ask AI framework" assignment. The requirements and a checklist are in [ASSIGNMENT.md](ASSIGNMENT.md). The original PDFs are in [assignment/](assignment/).

**Deadline:** 5 days from 2026-10-19, so submit by **Sat 2026-10-24**.
**Questions:** reply on the email thread; Nikhil (panel) is cc'd.

---

## 0. Core idea

> **The LLM plans; code executes.**

- About one LLM call per request (two at most), not a ReAct loop per record.
- Tool retrieval narrows 500 actions to around 15 before the model sees anything.
- The planner emits a typed JSON plan that uses *references* (`$s1.items`) instead of data, so record lists never pass through the model. That means fewer tokens and no hallucinated rows.
- Filtering, exclusion and per-record loops are deterministic built-in ops in the executor.
- Final answers are built from execution results, never from what the model believes happened.

This one decision carries most of the latency, cost and quality story.

---

## 1. Architecture

```
┌──────────── Vue 3 chat ────────────┐
│ messages · step timeline · confirm │
└───────────────┬────────────────────┘
                │ POST /chat  +  SSE stream of events
┌───────────────▼─────────────────────────────────────────┐
│ Node (TypeScript, Fastify)                              │
│                                                         │
│  Orchestrator ── per turn: retrieve → plan → validate   │
│      │                     → execute → summarize        │
│      ├─ Context store   (session: working set, last     │
│      │                   plan, created ids, pending     │
│      │                   confirmations)                 │
│      ├─ Tool retriever  (BM25 + embeddings over the 500 │
│      │                   action cards, no LLM)          │
│      ├─ Planner         (1 LLM call → typed JSON plan)  │
│      ├─ Executor        (deterministic DAG runner,      │
│      │                   built-in filter/exclude/forEach│
│      │                   ops, confirmation gates)       │
│      └─ Tracer          (spans, tokens, cost → JSONL)   │
│                                                         │
│  Action Registry (50 modules × 10, Zod schemas)         │
│      └─ Mock store (SQLite) · seed · frozen clock ·     │
│         fault injection                                 │
└─────────────────────────────────────────────────────────┘
        Eval runner (CLI) drives the same Orchestrator headless
```

---

## 2. One request, end to end

Example: *"Find leads created last week who haven't replied, exclude anyone with a booked appointment, assign to available reps, create follow-up tasks."*

### ① Retrieve (~20 ms, no LLM)
- Hybrid search (BM25 + embeddings) over **action cards**. Each card holds id, module, name, description, synonyms and entity types.
- Return the top ~15, spread across modules, plus actions carried over from the session context.
- Result here: M03.A03 Search leads, M11.A10 List unanswered conversations, M21.A03 Search appointments, M49.A09 Get team workload, M03.A05 Assign lead owner, M06.A01 Create task. Look-alike siblings such as M01.A07 Assign contact owner come along too.
- For how the shortlist is built, see [Retrieval and embeddings](#retrieval-and-embeddings) below.

#### Retrieval and embeddings

**Model and setup**
- `all-MiniLM-L6-v2`, run locally through transformers.js. It outputs 384-dimensional, normalised vectors. It's free, offline and deterministic, which keeps evals reproducible.
- Vectors are computed at boot and cached on disk. The cache key is a hash of the text plus the model name, so only changed cards are re-embedded.
- About 500 actions × ~5 utterances gives ~2,500 vectors, roughly 4 MB as Float32. A brute-force dot-product scan over all of them takes well under a millisecond, so there's **no vector database and no ANN index**. Embedding the query costs a few ms on CPU. The latency budget is measured, not assumed.
- The embedder sits behind an interface, so a hosted model (OpenAI or Voyage) can be swapped in as a benchmark variant.

**What gets embedded**
- **Example utterances per action**, such as "who hasn't got back to us" or "leads gone quiet" for M11.A10. Utterances look like user messages, so they match queries better than API-style descriptions do.
  - They're generated once by an LLM, reviewed, and committed.
  - They must not reuse the brief's example prompts or the eval scenarios. A lint check enforces this with a near-duplicate check against the scenarios.
- **An action scores by its best-matching utterance** (max-sim), not by an average. An average would blur an action that people phrase in very different ways.
- Descriptions are written for the planner prompt and for BM25. BM25 indexes name, description, synonyms and module name. MiniSearch fuzzy matching (edit distance 1–2 on longer terms) absorbs typos like "apointment" or "invocie".

**Merging and shaping the shortlist**
1. Run BM25 and embeddings over the same query, and take the top ~40 from each.
2. Merge them with **Reciprocal Rank Fusion**: `score = Σ 1 / (60 + rank)`. It uses ranks only, so the two scores don't need to be on the same scale.
3. **Module cap:** at most ~4 cards per module. This keeps one strong module from crowding out the others in a multi-module request.
4. **Always include look-alike siblings.** If M03.A05 Assign lead owner makes the list, so does M01.A07 Assign contact owner. The sibling pairs are declared in the registry. This puts the choice in front of the planner instead of in front of retrieval.
5. **Dependency expansion:** an entity-type graph is built from the input and output schemas. If a shortlisted action needs a `teamId` and no shortlisted action produces one, add the best-scoring producer, e.g. M49.A03 List teams.
6. Cut to k (~15). **k is picked from the measured recall@k curve**, as the smallest k where recall levels off. It isn't guessed.

**Query construction**
- **Multi-intent messages:** split on clause boundaries ("…, exclude …, assign …, and create …"). Retrieve per clause with a small quota each, then merge. Without this, the longest clause dominates the single query vector.
- **Short follow-ups** ("make those due tomorrow") have almost nothing to search on. Add the entity types from the working set ("tasks, leads") and the last user message to the query.
- The `search_tools` escape hatch runs the same pipeline on the model's own query, excluding cards it has already seen.

**Measuring it without an LLM**
- `eval/retrieval.ts` runs every scenario's message through retrieval alone. It reports recall@k, MRR and which expected action was missed. The full suite takes seconds and costs nothing, so tuning utterances, k and caps happens here, not in end-to-end runs.
- **Ablations in the benchmark:** BM25 only, embeddings only, hybrid, and hybrid with two-stage module routing (pick 3–5 modules first, then actions within them).

**What embeddings can't do**
- **Embeddings encode topic, not direction or negation.** "Haven't replied" and "unanswered" land close together but mean opposite things. "Exclude booked" and "booked" look alike too. Those cases are handled in card wording and params (`waitingOn`), and by the planner's ops, never by retrieval.
- **The vectors don't know your data.** "The Facebook campaign" can't tell retrieval whether a Campaign record exists. Entity resolution (③) checks that.

### ② Plan (1 LLM call)
- Output, forced through a single `submit_plan` tool: `answer | clarify | unsupported | plan | search_tools`.

#### Prompt structure
For a full two-turn example with real payloads and token counts, see [PROMPT-EXAMPLE.md](PROMPT-EXAMPLE.md).

```
tools:   [ submit_plan ]                          static, forced via tool_choice
system:  role + rules + plan grammar + examples   static   ── cache breakpoint ──
user:    <now> <context> <recent_turns> <actions> <message>   rebuilt every turn
```
- **Retrieved actions are prompt text, not tool definitions.** The model's only tool is `submit_plan`. That keeps the tool list static and cacheable, and the model plans instead of calling tools.
- **Nothing that changes per request goes before the breakpoint**: no timestamp, user name or retrieved cards.
- **`<now>`** holds the date, the timezone and precomputed ranges (today, tomorrow, this week, last week). The model picks a range and never does calendar math.
- **Across user turns the request is rebuilt from scratch.** History arrives only as `<context>` (the working set) and `<recent_turns>` (the last 2–3 exchanges as text). So the size of turn 10 stays close to turn 2.
- **Within one turn** (the observe loop), rounds append `assistant: tool_use` and then `user: tool_result` with a digest, with a second cache breakpoint. Extra cards from `search_tools` go in the tool_result rather than replacing `<actions>`.

```json
{ "type": "plan", "steps": [
  { "id": "s1", "action": "M03.A03", "args": { "createdAfter": "2026-10-12", "createdBefore": "2026-10-18" } },
  { "id": "s2", "action": "M11.A10", "args": { "waitingOn": "contact" } },
  { "id": "s3", "action": "M21.A03", "args": { "status": "booked", "from": "2026-10-20" } },
  { "id": "s4", "resolve": { "entity": "team", "name": "Sales" } },
  { "id": "s5", "action": "M49.A09", "args": { "teamId": "$s4.id" } },
  { "id": "s6", "op": "filter",  "in": "$s1.items", "where": { "contactId": { "in": "$s2.items[*].contactId" } } },
  { "id": "s7", "op": "exclude", "in": "$s6", "by": "contactId", "set": "$s3.items[*].contactId" },
  { "id": "s8", "op": "filter",  "in": "$s5.members", "where": { "available": true } },
  { "id": "s9", "op": "forEach", "in": "$s7", "roundRobin": "$s8", "do": [
      { "action": "M03.A05", "args": { "leadId": "$item.id", "ownerId": "$rr.userId" } },
      { "action": "M06.A01", "args": { "title": "Follow up with {{$item.name}}", "assigneeId": "$rr.userId",
                                       "relatedTo": { "type": "lead", "id": "$item.id" } } } ] }
] }
```
- The dates come from `<now>`. There's no `dueDate` because the user didn't give one, and there's no `confirm` field: see ③.
- **`waitingOn: "contact"` is the trap in this prompt.** "Haven't replied" means *we* wrote last. "Unanswered" normally means the *customer* wrote last. The M11.A10 card states both cases plainly.

### ③ Validate (no LLM)
- Check every action's args against its Zod schema, and check that every reference resolves.
- **Entity resolution:** names become IDs through the module's own search actions. More than one match means a clarification question, decided deterministically and not by the LLM.
- A missing required param that can't be inferred also means clarify.
- The risk policy (`destructive | bulk | external`) marks which steps need confirmation. **This is decided only in code**: the model never emits a `confirm` field, so it can't skip a gate or invent one. Here s9 writes 12 records, so it's bulk.
- If validation fails, make **one** repair call with the validation error attached.

### ④ Execute
- DAG runner: independent reads (s1, s2, s3) run in parallel.
- Each step streams `step.started` / `step.done` over SSE with counts, e.g. "14 leads → 9 unreplied → 6 after excluding booked".
- A confirmation gate pauses the run and the UI shows "Assign 6 leads + create 6 tasks? [Confirm]". It resumes on approval.

### ⑤ Summarize
- A deterministic template lists completed, failed and pending steps with counts and IDs.
- An optional cheap LLM polish pass may rephrase but may not add facts.

### ⑥ Bounded replan
- If a step fails, or returns something unexpected (zero results, permission error), allow **at most one** replan call that sees the results so far.
- After that, report honestly.

### Escape hatch
- If the planner believes the right tool wasn't retrieved, it returns `{"type":"search_tools","query":"..."}`. That triggers one more retrieval round, never the full 500-tool dump.

### Multi-turn tool calling (the agent loop)
Plan-then-execute is the fast path, but it is not the whole agent. Some requests can't be planned in one shot, because the next step depends on *what a result says*, not just on structured fields:
- **Semantic judgment:** "Look at Sarah's conversation and decide whether it needs escalation."
- **Exploration:** "Help me stay on top of new leads." The agent first has to look at what exists (open tasks, existing workflows) before choosing what to do.
- **Retrieval shift:** a result reveals the work belongs in a module that wasn't retrieved.

Handle these with a **bounded loop**, where the plan is the unit of iteration:

```
loop (max 4 iterations, token budget per request):
  retrieve (re-run with message + observations so far)
  LLM → plan | answer | clarify | unsupported | search_tools
  validate → execute plan → observations
  if the plan ended with an `observe` step → feed a digest back and continue
  else → summarize and stop
```

- **`observe` step:** the plan can end with `{ "op": "observe", "of": "$s3", "why": "decide escalation" }`. That is how the model says it needs to see a result before deciding the next step.
- **Observations are digests, not dumps:** counts, field names, up to 5 sample rows, and the error codes. Full rows stay in the executor and remain addressable by reference. This keeps per-iteration tokens flat as data grows.
- **Structured conditions don't loop:** "skip customers reminded this week" or "if score > 80" are executor ops (`filter`, `exclude`, `if`). The loop is only for judgment the executor can't do.
- **Within a plan, independent tool calls run in parallel.** Each loop iteration is one LLM call, not one call per tool.
- **Failures:** a failed step becomes an observation, which uses the same loop as replanning. Two consecutive failures of the same kind stop the loop and report.
- **Across user turns:** a pending clarification or confirmation suspends the loop state (plan, cursor, observations) in the context store, and the user's reply resumes it rather than restarting.

**Measuring it:** log iterations per request. The benchmark compares three variants:
- pure ReAct (one tool per LLM call): the baseline
- plan-execute with no loop
- the hybrid loop

The expectation to verify: most scenarios finish in 1 iteration, and indirect or judgment scenarios take 2–3.

### Time to first useful response (TTFUR)
- Complex requests: the plan rendered as a checklist, which arrives after about one LLM call.
- Direct requests: the result itself.
- A spinner does not count.

---

## 3. Follow-ups and context

Per-session **working set**:

```ts
{ summary: "leads created 2026-10-12..18, waiting on contact, no booked appt → 6 leads …",
  sets: {                       // addressable as $ctx.<name> in plans
    leads: [{ id: "ld_88", name: "Ana Ruiz", source: "facebook_ads", ownerId: "us_3" }, ...],
    tasks: [{ id: "tk_201", leadId: "ld_88", assigneeId: "us_3", dueDate: null }, ...] },
  entities: { "Sarah": "ct_812" },
  lastPlan, pendingConfirmation: null }
```

- The planner receives a compact summary of this in `<context>`, never the raw history.
- **Size cap:** a set is listed item by item, with its filterable fields only, while it holds ≤ ~20 items. Past that, the prompt shows the count, the field names and the `$ctx` handle, and the rows stay in the executor.
- **No special syntax.** Follow-ups use `$ctx.<name>` with the same `filter` / `exclude` / `forEach` ops. For example, "Only include leads from the Facebook campaign, and make those tasks due tomorrow" becomes:
  1. `filter $ctx.leads` where `source = facebook_ads`, plus the complement with `exclude`.
  2. `filter $ctx.tasks` by `leadId` for each half.
  3. `forEach` complement task → M06.A10 Cancel task. This is destructive, so code asks for confirmation.
  4. `forEach` kept task → M06.A06 Set task due date `2026-10-21`.
  5. The reply notes that the 2 dropped leads still have owners, and offers to unassign them.
- **Ambiguity to test:** "Facebook campaign" could mean the lead source or an M15 Campaign record. The demo assumes the source field. An eval scenario covers both readings: with a campaign named "Facebook" seeded, the planner should clarify.
- Good demo moment: the assistant amends work it already did instead of redoing everything.

---

## 4. Registry and handlers

### Layout

```
server/src/
  core/        orchestrator, planner, executor, retriever, context, tracer
  registry/    defineAction.ts, registry.ts, crudFactory.ts, riskPolicy.ts
  modules/
    m01-contacts/   index.ts  (10 actions)  entity.ts  (schema + seed gen)
    ...
    m50-reports/
  store/       db.ts (better-sqlite3), seed.ts, clock.ts, faults.ts
eval/
  scenarios/*.yaml   runner.ts   assertions.ts   report.ts   smoke.test.ts
web/           Vue 3 + Vite
```

### Action definition

```ts
export const createContact = defineAction({
  id: "M01.A01", module: "contacts", name: "create_contact",
  description: "Create a new contact person with name, email, phone, tags.",
  synonyms: ["add person", "new customer", "save lead details"],   // BM25
  utterances: ["put this person in my contacts", "new client just signed up, save them"],   // embedded
  risk: "write",                       // read | write | destructive | external | bulk
  input:  z.object({ firstName: z.string(), lastName: z.string().optional(),
                     email: z.string().email().optional(), ownerId: z.string().optional() }),
  output: ContactSchema,
  entities: { produces: "contact" },
  handler: async (args, { db, clock }) => {
    if (args.email && db.contacts.findByEmail(args.email))
      throw new ActionError("DUPLICATE", `Contact with ${args.email} exists`, { hint: "M01.A06" });
    return db.contacts.insert({ ...args, createdAt: clock.now() });
  },
});
```

### Rules
- **`crudFactory(entity)`** generates create, get, search, update and archive from each module's entity schema, about 250 actions in total. Hand-write the domain actions: merge, convert quote to invoice, find slots, refundable balance, workload, and so on.
- **Auto-registration:** modules are discovered by directory scan. A new module is one folder with no core change (the extensibility requirement).
- **Descriptions in user language**, not REST language. They're the retrieval surface and the main quality lever.
  - Spell out direction and meaning wherever everyday words are ambiguous. For example, M11.A10 takes `waitingOn: "contact" | "team"`, and its description says which side wrote last in each case.
  - Look-alike siblings in other modules cross-reference each other, e.g. "(For contacts use M01.A07.)"
- **Synonyms and utterances:** generated once by an LLM, reviewed, and committed. They describe the action in general terms, not the brief's example prompts. Disclose this in the README.
- **Frozen clock:** `clock.now()` is pinned during evals, so "last week" and "tomorrow" give the same result every run.
- **Fault injection** (`faults.ts`): a scenario can force a handler to time out or return a permission or not-found error.
- **Handlers never always-succeed.** Validate, return typed `ActionError`s, and mutate state for every write.

---

## 5. Evaluation harness

### Scenario format

```yaml
id: inv-017
category: conditional            # direct|indirect|multi|followup|ambiguous|unsupported|failure
modules: [invoices, email]
setup: { seed: default, overrides: [ { reminders: { invoice: inv_44, sentAt: "-2d" } } ] }
turns:
  - user: "For unpaid invoices overdue by more than 15 days, draft reminders, but skip customers who already got one this week"
    autoConfirm: true
expect:
  actions:   { includes: [M28.A10, M13.A07, M13.A01], excludes: [M13.A03] }   # drafted, not sent
  params:    { M28.A10: { minDaysOverdue: 15 } }
  state:
    - query: "SELECT count(*) n FROM emails WHERE status='draft' AND kind='invoice_reminder'"
      equals: 4
    - query: "SELECT count(*) n FROM emails WHERE invoice_id='inv_44' AND status='draft'"
      equals: 0
  response:  { mustNotClaim: ["sent"] }
```

### Runner
- For each scenario: reset the DB, run the turns through the real orchestrator, assert, and record metrics from the trace.
- Run each scenario **3 times** at temperature 0 and report pass rate and variance.
- **Coverage:** at least 2 scenarios per module (100+ total) across all 7 categories. LLM-drafted, assertions reviewed by hand.

### Smoke test (`smoke.test.ts`)
- All 500 actions: one valid call with a state check, plus one invalid call that must return a typed error. No LLM.

### Metrics
| Metric | Definition |
|---|---|
| Retrieval recall@k | expected actions present in the retrieved set |
| Action selection | precision / recall vs expected actions |
| Parameter accuracy | matching subset of expected args |
| Task success | all state assertions pass |
| TTFUR | time to first SSE event carrying a plan, result or clarification |
| E2E | time to the final summary |
| Cost | usage tokens × pricing table in config; cached tokens counted separately; retries included |
| Calls/task | number of LLM calls per request |
| Iterations | agent-loop iterations per request (see §2, multi-turn tool calling) |

Report p50 and p95, split into **direct** vs **complex**. Report cost **per request** and **per successful task**.

### Variants (same scenarios)
- `baseline`: a big model in a ReAct loop with the full catalog.
- `optimized`: retrieval + plan-execute + bounded observe loop.
- Ablations: retrieval off, loop off (single plan only), small vs large planner model, prompt cache off.
- Retrieval ablations (no LLM, see [Retrieval and embeddings](#retrieval-and-embeddings)): BM25 only, embeddings only, hybrid, hybrid with module routing.

### Report
- `report.ts` generates `BENCHMARK.md` from the results JSON: tables by category, cost per task, and every failure and missed target listed.

### Targets
Commit to these after a small pilot run, **before** the full benchmark. The values below are placeholders.

| | Target |
|---|---|
| Direct: TTFUR p50 / p95 | ≤ 1.5 s / ≤ 3 s |
| Complex: E2E p50 / p95 | ≤ 6 s / ≤ 12 s |
| Action selection (direct / complex) | ≥ 95% / ≥ 85% |
| Task success overall | ≥ 85% |
| LLM calls per complex task | ≤ 2 median |

---

## 6. Stack

- **Backend:** Node 22 + TypeScript, Fastify (SSE), Zod + `zod-to-json-schema`, better-sqlite3, `@faker-js/faker` (fixed seed).
- **Retrieval:** MiniSearch (BM25) plus local embeddings via transformers.js (free, deterministic, offline). A provider's embeddings can be swapped in later.
- **LLM:** the provider SDK directly, no LangChain. That gives exact token accounting, prompt-cache control and less overhead. Use a fast, cheap model for direct requests and a stronger one when the request looks complex; measure the split.
- **Testing and UI:** Vitest for the smoke tests. Vue 3 + Vite for the web app.

---

## 7. Five-day schedule

| Day | Build | Done when |
|---|---|---|
| **1 · Tue 20** | Repo, registry, `defineAction`, CRUD factory, SQLite store, seed, clock, faults. Draft all 500 action definitions from the catalog (LLM-assisted, reviewed) | ~250 CRUD actions pass the smoke test |
| **2 · Wed 21** | Remaining domain handlers. Retriever, planner, executor for direct requests. CLI `ask "..."` | 500/500 smoke green; direct requests work end to end |
| **3 · Thu 22** | References + built-in ops, entity resolution, clarification, confirmations, follow-up context, replan. SSE + Vue UI. Start drafting scenarios | The brief's 5 example prompts work in the UI |
| **4 · Fri 23** | Finish 100+ scenarios, eval runner, baseline agent. Pilot → write targets → full benchmark → fix top failure classes | Benchmark JSON + first report |
| **5 · Sat 24** | Final benchmark, README, demo video (2–5 min), buffer | Submitted |

### Risks
1. **Writing and reviewing scenarios takes long.** Start drafting on day 3.
2. **500 handlers eat days 1–2.** Keep domain logic simple but real; the CRUD factory does the bulk.
3. **Retrieval misses on look-alike actions** (contacts vs leads, email vs conversations). Track recall@k as its own metric and tune descriptions and synonyms against it.
4. **Non-determinism.** Temperature 0, repeated runs, and report variance instead of hiding it.
5. **Semantic traps that retrieval can't catch.** The action is right but its meaning is inverted, e.g. "haven't replied" vs "unanswered", or "Facebook campaign" as a lead source vs a Campaign record. Keep a named eval category for these and fix them in card descriptions and params, not in the prompt.

---

## 8. Prior art

`../ask-ai-slice/` is an earlier dependency-free JS prototype: 1 module and 5 actions, with a rule-based planner standing in for the LLM. It already shows the descriptor shape (user-language descriptions, aliases, `sideEffect`, `requiresConfirmation`), slot-filling clarification, the confirmation gate, and evals that assert state. Reuse those ideas. This repo is the real TypeScript build.
