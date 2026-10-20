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
- Result here: `leads.search`, `conversations.list_unanswered`, `appointments.search`, `teams.get_workload`, `leads.assign_owner`, `tasks.create`, …

### ② Plan (1 LLM call)
- Inputs: system prompt and plan grammar (static, so prompt-cacheable), context summary, retrieved tool cards with input schemas, user message.
- Output, constrained to one of: `answer | clarify | unsupported | plan | search_tools`.

```json
{ "type": "plan", "steps": [
  { "id": "s1", "action": "M03.A03", "args": { "createdAfter": "{{lastWeek.start}}", "createdBefore": "{{lastWeek.end}}" } },
  { "id": "s2", "action": "M11.A10", "args": {} },
  { "id": "s3", "action": "M21.A03", "args": { "status": "booked" } },
  { "id": "s4", "op": "filter",  "in": "$s1.items", "where": { "contactId": { "in": "$s2.items[*].contactId" } } },
  { "id": "s5", "op": "exclude", "in": "$s4", "by": "contactId", "set": "$s3.items[*].contactId" },
  { "id": "s6", "action": "M49.A09", "args": { "teamName": "Sales" } },
  { "id": "s7", "op": "forEach", "in": "$s5", "roundRobin": "$s6.availableUsers", "do": [
      { "action": "M03.A05", "args": { "leadId": "$item.id", "ownerId": "$rr.id" } },
      { "action": "M06.A01", "args": { "title": "Follow up with {{$item.name}}", "assigneeId": "$rr.id", "relatedId": "$item.id" } } ] }
], "confirm": ["s7"] }
```

### ③ Validate (no LLM)
- Check every action's args against its Zod schema, and check that every reference resolves.
- **Entity resolution:** names become IDs through the module's own search actions. More than one match means a clarification question, decided deterministically and not by the LLM.
- A missing required param that can't be inferred also means clarify.
- The risk policy (`destructive | bulk | external`) marks which steps need confirmation.
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
{ lastPlan, lastQuery: { module: "leads", filters: {...} },
  entities: { "Sarah": "ct_812" },
  created:  { tasks: ["tk_1", ...], leadsAssigned: [...] },
  pendingConfirmation: null }
```

- The planner receives a compact summary of this, never the raw history.
- Example: "Only include leads from the Facebook campaign, and make those tasks due tomorrow" becomes a plan over `$ctx`:
  1. Filter the previous lead set by `source = facebook`.
  2. Cancel the tasks created for leads that fall outside the filter. This is destructive, so it needs confirmation.
  3. Set `due = tomorrow` on the remaining tasks.
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
  synonyms: ["add person", "new customer", "save lead details"],
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
- **Synonyms:** generated once by an LLM, reviewed, and committed. They describe the action in general terms, not the brief's example prompts. Disclose this in the README.
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

---

## 8. Prior art

`../ask-ai-slice/` is an earlier dependency-free JS prototype: 1 module and 5 actions, with a rule-based planner standing in for the LLM. It already shows the descriptor shape (user-language descriptions, aliases, `sideEffect`, `requiresConfirmation`), slot-filling clarification, the confirmation gate, and evals that assert state. Reuse those ideas. This repo is the real TypeScript build.
