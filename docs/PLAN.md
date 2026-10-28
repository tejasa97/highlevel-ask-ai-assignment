# Ask AI — Build Plan

Working plan for the HighLevel "Ask AI framework" assignment. The requirements and a checklist are in `ASSIGNMENT.md`, and the original PDFs in `assignment/`; both are kept locally, not in the repo.

**Deadline:** 5 days from 2026-10-19, so submit by **Sat 2026-10-24**.
**Questions:** reply on the email thread; Nikhil (panel) is cc'd.

**Scope (decided 2026-10-21): v1 = 15 modules in depth.** All 500 actions stay in the catalog and in retrieval, but only these 15 modules have handlers; a request that lands on one of the other 35 gets an honest "not available in v1" answer, never a fake success. The other 35 come after v1 works end to end and covers its edge cases.

**Status (2026-10-28):** the other modules have since been built, so all 50 modules and 500 actions execute and the "not available in v1" answer no longer applies. §0–§6 below now describe what was built, checked against the code; where the design changed, a line says what was built instead and why ([JOURNEY.md](JOURNEY.md) has the history). §7 (schedule and risks) and §8 (prior art) are the original plan, kept as written. Measured results are in [BENCHMARK.md](../BENCHMARK.md).

| Group | Modules |
|---|---|
| CRM core | M01 Contacts, M03 Leads, M04 Opportunities, M06 Tasks, M07 Notes, M08 Tags |
| People | M48 Users, M49 Teams |
| Messaging | M11 Conversations, M12 SMS, M13 Email, M15 Campaigns |
| Scheduling and money | M21 Appointments, M28 Invoices, M29 Payments |

Depth means: all 10 actions per module, real validation and state changes, permissions, and a test file per module for its edge cases (duplicates, closed or archived records, inactive users, last-admin guards, merges, conversions) on top of the per-action smoke test. The table is the original v1 set; every module now meets the same bar.

---

## 0. Core idea

> **The LLM plans; code executes.**

- One LLM call per request in the common case, not a ReAct loop per record. A turn can spend more (a look at data, a repair), up to a hard cap of 8. In the benchmark the median complex task took 1 model call, against 5 for the one-call-per-step baseline.
- Tool retrieval narrows 500 actions to about 15 ranked picks, plus the helpers they need, before the model sees anything.
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
                │ POST /api/ask, /api/confirm  →  SSE stream of events
┌───────────────▼─────────────────────────────────────────┐
│ Node (TypeScript, plain node:http)                      │
│                                                         │
│  Conversation ── per turn: retrieve → plan → compile    │
│      │                     → execute → summarize        │
│      ├─ Carry          (last 4 exchanges as text, up to │
│      │                  12 recent records, last plan)   │
│      ├─ Retriever      (BM25 + local embeddings over    │
│      │                  the 500 action cards, no LLM)   │
│      ├─ Planner        (usually 1 LLM call → JSON plan) │
│      ├─ Compiler       (Zod args, $refs, lookups)       │
│      └─ Executor       (deterministic step runner,      │
│                         filter/exclude/forEach ops,     │
│                         approvals, writes ledger)       │
│                                                         │
│  Action Registry (50 modules × 10, Zod schemas)         │
│      └─ Mock store (node:sqlite) · seed · frozen clock ·│
│         fault injection · audit log                     │
└─────────────────────────────────────────────────────────┘
        Eval runner (CLI) drives the same Conversation headless
```

- **Built differently:** no Fastify (plain `node:http` covers four POST and three GET routes, see `server/src/server/app.ts`), and no separate tracer. Each turn streams its events (`retrieval`, `planner.request`, `planner.reply`, `plan`, `call`, `confirm`, `reply`…) over SSE, and the eval runner records the same events.

---

## 2. One request, end to end

Example: *"Find leads created last week who haven't replied, exclude anyone with a booked appointment, assign to available reps, create follow-up tasks."*

### ① Retrieve (~10 ms, no LLM)
- BM25 (MiniSearch) over **action cards**, one per catalog action (500). Each card holds the id, module, name, a one-line description, synonyms, siblings and entity types.
- A small local embedding model (bge-base) ranks the same cards by meaning; the two rankings are fused (see [Retrieval](#retrieval)).
- Returns 15 ranked picks spread across modules. Siblings, producers, name lookups and carried actions are added on top. The planner is shown 22.3 actions on average on the test split ([BENCHMARK.md](../BENCHMARK.md#tool-retrieval)).
- Result here: M03.A03 Search leads, M49.A09 Get team workload and M06.A01 Create task rank in the top 6, with M03.A05 Assign lead owner and its sibling M01.A07 Assign contact owner alongside.
- For how the shortlist is built and measured, see [Retrieval](#retrieval) below.

#### Retrieval

**BM25 first, then embeddings once they beat it**
- BM25 went first: the card synonyms carry much of what embeddings add. It is deterministic and explainable (the trace shows which words matched which field).
- The bar for embeddings was beating BM25 on the held-out split. Paraphrase-heavy questions showed where BM25 falls short: wordings that share no words with the card ("hold off on the fall webinar emails" → Pause campaign). Hybrid beat it there, so it became the default; the numbers from that comparison are in [JOURNEY.md](JOURNEY.md) ("Hybrid retrieval"). `RETRIEVAL=bm25` turns embeddings off.
- **How they're combined** (`retrieve.ts`, `embed.ts`): the embedding model ranks all cards for the whole message and for each clause. The top 20 of each ranking joins reciprocal-rank fusion with the BM25 lists at equal weight. Cards in the top 10 of a meaning ranking skip the BM25 score floor, since they may share no words with the question. "No match" is still decided by BM25 alone, because an embedding ranking always has a nearest card. Picks only the embedding found are labelled `dense` in the trace.
- Settings were chosen on the dev split (floor exemption 0/5/10/20, top 10/20/30, weight 0.5/1/2), then the test split was run once. A sweep across models (MiniLM, bge-small, bge-base) was done earlier with all splits visible; bge-base won on every split.
- **Cost:** `Xenova/bge-base-en-v1.5`, quantized, runs locally through transformers.js (no API call). 113 MB on disk, downloaded once into `server/data/models/`. Card vectors take ~30 s on first start and are cached in `server/data/`, keyed by the card text and model. Measured on an M1 Pro: ~300 ms to load, ~10 ms per question, ~250–310 MB more memory. If the model can't load, retrieval falls back to BM25 and logs one line.

**Cards** (`server/src/retrieval/cards.json`, merged in `retrieval/cards.ts`)
- Name and module come from the catalog. Description, synonyms, siblings and entity types were generated once by an LLM per action (~$2 for all 500) and are committed.
- **Built differently:** at runtime the registry is the source of truth for each card's description and entity types; synonyms and siblings are the union of `cards.json` and the registry, and siblings are made mutual. Hand fixes then live next to the handler, and the two can't drift.
- The generator never sees `eval/`. A test fails if any synonym equals an eval paraphrase after normalising.
- Unbuilt actions kept their cards, so retrieval could name them. All 500 are built now, so `<not_available>` stays empty in practice.

**Text** (`retrieval/text.ts`)
- Porter stemming, stopwords, numbers dropped, hyphen forms ("follow-up" → follow, up, followup).
- A small shorthand table (txt, appt, to-do, opp…) expands both ways.
- Fuzzy matching (edit distance 1 from 5 letters, 2 from 9) absorbs typos like "apointment".

**Shaping the shortlist** (`retrieval/retrieve.ts`)
1. **Field boosts:** name 3, synonyms 2, module 1.5, description 1.
2. **Clause splitting:** "…, give them to …, and make …" becomes one search per clause. The lists are merged with Reciprocal Rank Fusion, `Σ 1/(60 + rank)`, over the clause lists and the whole message.
3. **Per-clause guarantee:** the top 2 of each clause go first. RRF on its own favoured cards that were middling in every list, and ranked Search leads 20th for the Facebook request.
4. **Module cap** 6, **score floor** 10% of the top score, then cut to **k = 15** (where the dev recall@k curve levels off). The cap makes room for other modules; when nothing else clears the floor, the capped cards get the empty slots back ("answer the 2-star review" is all about reviews). It only adds picks, so no question can lose one.
5. **Siblings** of the top 3 picks only. Adding them for every pick cost ~12 cards a question for under a point of recall.
6. **Producers:** if a pick consumes a record type no pick produces, add the best producer. Types the planner can name directly (the 45 resolvable types) are skipped, unless the wording is bulk ("every", "all", "each") or a top-3 pick consumes a second record type the message doesn't name.
7. **Carried actions:** the previous plan's actions, so "make those high priority" keeps its tools. Actions that act on a record type the last turn made are added too (up to 8), so "make those tasks due tomorrow" finds the task actions.
8. **Names** (`retrieval/mentions.ts`): capitalized runs in the message are looked up with the resolvers (not tasks, whose titles are too noisy, and not child records, which are named through their parent). A name links only if all its words are whole words of a record's name, so "Tom" doesn't link to "Tomas". A run that opens a sentence is retried without its first word ("Call Ana Ruiz"); mid-sentence it isn't, so an unknown "Jo Park" doesn't link to a user named Park. Each linked type adds its get and search actions. Before this, "What is Sarah Johnson's status?" never says "contact", and the shortlist had no contact actions at all. A linked name also overrides no-match ("tell me about Victor Larsen").
- Every added card records `via` (which pick brought it in). The trace shows it.

**Query construction**
- When the last reply was a question, the retrieval query is that question plus the answer. ("Ana Ruiz" on its own finds nothing useful.)
- `search_tools`: the planner names what's missing. One more retrieval runs on that text, excluding cards already shown, and the new cards join `<actions>`. A turn allows two rounds; the second also reminds the planner that filter, exclude and forEach are ops, not actions. A third ends the turn as unsupported.
- An `unsupported` reply in a turn that hasn't searched yet gets one retrieval on its own stated reason first, so a near miss isn't reported as out of scope.
- **No-match detection is left to the planner.** "Book a flight" scores higher than a typical in-scope question, because "book" and "order" are real action words. The threshold only catches nonsense.

**What the planner sees**
- `<actions>` holds only the shortlisted actions, as cards with their input fields. All 500 cards would be 332,087 characters; the turn-1 user block in [PROMPT-EXAMPLE.md](PROMPT-EXAMPLE.md) is 27,833 characters with 29 cards.
- `<mentions>` names the record type each linked name belongs to ("Hiro Reyes: lead", "Sarah Johnson: 2 contacts"). The planner had resolved Hiro Reyes as a contact, and the step failed.
- Compile rejects any action the planner wasn't offered, with an error the repair round can act on.

**Measured** (`npm run eval:retrieval`; no LLM)
- 40% of the 365 questions (`eval/retrieval/queries.jsonl`) are held out by id hash. All tuning used the dev split only.
- Test split, hybrid, 150 questions ([BENCHMARK.md](../BENCHMARK.md#tool-retrieval)): the right actions are in the first 15 offered 97.4% of the time (all of a question's actions: 96.7%), mean reciprocal rank 0.7, 22.3 actions shown on average.
- The earlier BM25-only and names-only tables, and the lookup group added for name linking, are in [JOURNEY.md](JOURNEY.md). `--no-mentions` turns linking off for comparison.
- `retrieve.test.ts` gates regressions on the full set: R@15 ≥ 89% for BM25 and ≥ 95% hybrid, direct 100%, paraphrase ≥ 80% (BM25) and ≥ 90% (hybrid), zero false rejects, at most 22 picks on average.

**What retrieval can't do**
- **It matches words, not direction or negation.** "Haven't replied" and "replied" share terms, and so do "exclude booked" and "booked". Those cases are handled by card wording, params (`waitingOn`) and the planner's ops.
- **It doesn't know your data.** "The Facebook campaign" can't tell retrieval whether a Campaign record exists. Entity resolution (③) checks that.

### ② Plan (usually 1 LLM call)
- Output: one JSON object matching the `submit_plan` schema (`server/src/planner/submit-plan.ts`). Its `type` is one of `plan | look | clarify | unsupported | answer | search_tools`.
- A plan also states its `outcome` (`effect: read | change`, the final actions, and a delivery `destination` when the user named one). Code checks the steps against it, so a plan that reads when the user asked for a change is sent back.
- **How the schema is enforced:** each provider gets it through the mechanism it accepts (see [Model providers and routing](#model-providers-and-routing)), and the reply is always parsed with Zod afterwards. The model gets no tools; the plan is its whole answer.

#### Prompt structure
For a two-turn example, with the prompt as the code builds it and the replies and token counts recorded in the benchmark, see [PROMPT-EXAMPLE.md](PROMPT-EXAMPLE.md).

```
format:  submit_plan JSON schema                          static
system:  role + rules + plan grammar + examples           static (prefix ≈ 4,000 tokens with the schema)
user:    <now> <context> <resolvable> … <actions> … <message>   rebuilt every turn
```
- **Retrieved actions are prompt text, not tool definitions.** That keeps the request prefix static and cacheable, and the model plans instead of calling tools.
- **Nothing that changes per request goes in the prefix**: no timestamp, user name or retrieved cards. The benchmark planner (DeepSeek on the Token Plan) caches the prefix automatically, and 74% of its input tokens were read from cache ([BENCHMARK.md](../BENCHMARK.md)).
- **`<now>`** holds the date, the timezone and precomputed ranges (today, tomorrow, this week, last week, weekdays). The model picks a range and never does calendar math.
- **The user block** (`server/src/planner/prompt.ts`) carries, in order: `<now>`, `<context>`, `<resolvable>` (record types a resolve step can name), `<delivery_surfaces>`, `<requested_outcome>`, `<identity_check>`, `<lookup_qualifiers>`, `<recent_records>`, `<mentions>`, `<actions>`, `<not_available>`, `<failed_attempt>`, `<message>`, and after a look `<looked>` and `<new_step_ids>`. Empty blocks are left out. PROMPT-EXAMPLE.md shows each one filled in.
- **Across user turns the request is rebuilt from scratch.** History arrives only as `<context>` (the last 4 exchanges as text) and `<recent_records>` (up to 12 records the conversation touched, as typed ids). So the size of turn 10 stays close to turn 2.
- **Within one turn** the next round adds to the end of the user block instead of threading messages: `<looked>` after a look, cards from `search_tools` inside `<actions>`, `<rejected_plan>` and `<errors>` for a repair. The system prompt and schema stay byte-identical, so the cache still hits, and no provider-specific tool-result format is needed.
- **Built differently:** the plan's `<recent_turns>` and `<observations>` blocks became `<context>` and `<looked>`; the working set they were meant to carry is in §3.

The example request, as a plan (args and conditions shown as objects for reading; on the wire each is a JSON string, `argsJson` and `whereJson`):

```json
{ "type": "plan", "steps": [
  { "id": "s1", "kind": "action", "action": "M03.A03", "args": { "createdAfter": "2026-10-12", "createdBefore": "2026-10-18" } },
  { "id": "s2", "kind": "action", "action": "M11.A10", "args": { "waitingOn": "contact" } },
  { "id": "s3", "kind": "action", "action": "M21.A03", "args": { "status": "booked", "from": "2026-10-20" } },
  { "id": "s4", "kind": "resolve", "entity": "team", "name": "Sales" },
  { "id": "s5", "kind": "action", "action": "M49.A09", "args": { "teamId": "$s4.id" } },
  { "id": "s6", "kind": "op", "op": "filter",  "in": "$s1.items", "where": { "contactId": { "in": "$s2.items[*].contactId" } } },
  { "id": "s7", "kind": "op", "op": "exclude", "in": "$s6", "by": "contactId", "set": "$s3.items[*].contactId" },
  { "id": "s8", "kind": "op", "op": "filter",  "in": "$s5.members", "where": { "available": true } },
  { "id": "s9", "kind": "op", "op": "forEach", "in": "$s7", "roundRobin": "$s8", "do": [
      { "action": "M03.A05", "args": { "leadId": "$item.id", "ownerId": "$rr.userId" } },
      { "action": "M06.A01", "args": { "title": "Follow up with {{$item.name}}", "assigneeId": "$rr.userId",
                                       "relatedTo": { "type": "lead", "id": "$item.id" } } } ] }
] }
```
- The dates come from `<now>`. There's no `dueDate` because the user didn't give one, and there's no `confirm` field: see ③.
- **`waitingOn: "contact"` is the trap in this prompt.** "Haven't replied" means *we* wrote last. "Unanswered" normally means the *customer* wrote last. The M11.A10 card states both cases plainly.
- A name can also go straight into an ID argument as `{"$lookup": {"entity": "team", "name": "Sales"}}`; code lowers it to a resolve step (`core/lookups.ts`).

### ③ Validate (no LLM)
- Compile (`core/compile.ts`) checks every action's args against its Zod schema, checks that every reference points at an earlier step and a field it returns, and rejects actions that weren't offered.
- **Entity resolution:** names become IDs through the resolvers before anything runs. More than one match means a clarification question, decided in code and not by the LLM. A name that matches nothing stops every write in the plan.
- A missing required param that can't be inferred also means clarify. The planner says which action and argument are missing (`missing`), so the next message can be bound to it.
- The risk policy marks which steps need confirmation: `destructive` and `external` actions, and writes repeated over 3 or more items. **This is decided only in code**: the model never emits a `confirm` field, so it can't skip a gate or invent one. Here s9 writes 12 records, so it asks.
- If compile fails, the planner gets **one** repair call with the rejected plan and the errors attached, and a second only if the first repair cut the error count. **Built differently:** a few narrower checks each get one retry of their own (a bad JSON reply, a plan that would remake the last turn's records, a change whose filtered targets haven't been said back, an empty target list); see `server/src/planner/turn.ts`.

### ④ Execute
- Step runner (`core/execute.ts`): steps run in order, one at a time. **Built differently:** no parallel reads; every action is an in-process SQLite call, so running them concurrently would buy nothing here.
- Each step streams over SSE (`call`, `run`, `diff`) with counts, e.g. "14 leads → 9 unreplied → 6 after excluding booked".
- A confirmation gate pauses the run and the UI shows "Assign 6 leads + create 6 tasks? [Confirm]". The approval is bound to the plan's hash and to its targets, so a different plan can't reuse it.
- On resume the reads run again, and writes are deduplicated through a ledger keyed by execution, step, item and call, so nothing is written twice. Each forEach item is its own transaction.

### ⑤ Summarize
- A deterministic template (`core/summarize.ts`) lists completed, failed and pending steps with counts and IDs.
- **Built differently:** no LLM polish pass. The one place model text reaches the reply is a read question answered after a look: the planner's short verdict sits above the code-built summary.

### ⑥ Bounded replan
- If nothing changed and the run stopped on a name that matched nothing, a missing or invalid record, or a prerequisite conflict, the turn is planned **once** more with a `<failed_attempt>` block (`server/src/server/conversation.ts`).
- After a write has run, or after that one retry, the turn reports honestly.

### Escape hatch
- If the planner believes the right tool wasn't retrieved, it returns `{"type":"search_tools","query":"..."}`. That triggers one more retrieval round (two at most per turn), never the full 500-tool dump.

### Multi-turn tool calling (the agent loop)
Plan-then-execute is the fast path, but it is not the whole agent. Some requests can't be planned in one shot, because the next step depends on *what a result says*, not just on structured fields:
- **Values worked out from a record:** "Move my 3 pm with Ana to the same time Monday" needs the meeting's current time first.
- **Questions:** "Is Hiro Reyes qualified yet?" needs the record before it can be answered.
- **Retrieval shift:** a result reveals the work belongs in a module that wasn't retrieved.

**Built differently:** the plan's `observe` step and `if` op became a separate reply type, `look`, and the loop is bounded by a call budget instead of an iteration count. A look is read-only, so it can run at once without approval; `if` was never needed because filter and exclude cover the structured conditions.

```
per turn (at most 8 planner calls, 180 s):
  retrieve
  LLM → plan | look | answer | clarify | unsupported | search_tools
  look         → run its reads now, put the results in <looked>, plan again (2 looks a turn)
  search_tools → retrieve on its query, add the cards, plan again (2 rounds a turn)
  plan         → compile (repair if rejected) → execute → summarize
```

- **A look returns what was read, capped:** at most 16,000 characters across a turn's looks. The looked steps stay part of the turn, so the next plan reaches their full rows by reference (`$s1.items`) instead of copying ids out of `<looked>`. `<new_step_ids>` tells it where its own step ids start.
- **A yes/no or count question can be answered** from the looked records with an `answer`; the reads then run as the plan so the reply shows the records under the verdict.
- **Structured conditions don't loop:** "skip customers reminded this week" or "if score > 80" are `filter` and `exclude` ops.
- **Failures:** a failed run gets the one bounded replan in ⑥, not another loop.
- **Across user turns:** a pending confirmation is kept with its execution id and approvals, and `/api/confirm` resumes it. A clarification ends the turn; the answer arrives as the next message with the question attached.

**Measuring it:** model calls per turn are logged on every run. In the benchmark the planner made 1.39 calls per run, the median complex task took 1, and the one-call-per-step baseline took 5. The routed, plan-only and observe-loop variants planned here were not run.

### Time to first useful response (TTFUR)
- Complex requests: the plan rendered as a checklist, which arrives after about one LLM call.
- Direct requests: the result itself.
- A spinner does not count.
- The benchmark calls this "first reply". Measured: direct p50 1.3 s / p95 4.3 s, complex p50 1.6 s / p95 7.7 s ([BENCHMARK.md](../BENCHMARK.md#latency)).

### Model providers and routing

> **Decision, 2026-10-21: development runs on `claude -p`.** Superseded twice. **2026-10-25:** the claude-cli planner defaults to `claude-haiku-5-5` for both tiers, by its full id: the `haiku` alias resolves to `claude-haiku-4-5-20251001` on CLI 2.1.284, which scored 91.3% on regression against 100% (8x, 7.2 s p50) for Haiku 5.5. **Then:** the benchmark planner became DeepSeek (`deepseek-v4.1-flash-1017`) through the Qwen Token Plan, a direct HTTPS call with no process start. With `PLANNER` unset, a Token Plan key selects it, and without one the app runs on claude-cli.
>
> - **Args travel as a JSON string (`argsJson`).** Strict modes require `additionalProperties: false` on every object, so a loose `args` object isn't allowed. Zod checks the parsed args against each action's schema.

**Built differently:** the direct Anthropic API adapter, the OpenAI-compatible family adapter, per-model prompt overrides, `pricing.json` and the fast/strong router below were never built. The Token Plan gave a direct, prepaid API with automatic caching, so one adapter covered the benchmark, and the benchmark ran on one model with no routing.

#### One planner interface, thin adapters
Retrieval, `<context>` rebuilding, the plan grammar, validation, execution, the risk policy and the look loop are all app code. The model has one job: return one valid `submit_plan` object. So the provider boundary is small (`server/src/planner/types.ts`):

```ts
interface Planner {
  readonly name: string                     // "qwen" | "claude-cli" | "codex-cli"
  plan(req: { tier: "fast" | "strong"; system: string; user: string; schema: object; signal?: AbortSignal })
    : Promise<{ model: string; json: unknown; text: string; usage: Usage; latencyMs: number }>
}
type Usage = { input: number; cachedRead: number; cacheWrite: number; output: number; thinking: number;
               billing: "api" | "subscription" | "api_estimate" | "none"; costUsd: number | null }
```

- **Three adapters** (`server/src/planner/`):

  | `PLANNER` | Model | How it returns `submit_plan` |
  |---|---|---|
  | `qwen` (default with a Token Plan key) | `deepseek-v4.1-flash-1017` on the Token Plan's OpenAI-compatible endpoint | `json_schema` strict where the model accepts it. DeepSeek rejects it (HTTP 400, checked 2026-10-25), so it gets `json_object` with the schema appended to the system prompt. Thinking off, `max_tokens` 8192, one retry |
  | `claude-cli` (default without a key) | `claude-haiku-5-5` | `claude -p --json-schema`, with no tools, MCP, settings or hooks, an empty cwd and our system prompt. ~0.7 s of process start per call |
  | `codex-cli` (opt-in) | `gpt-6.1-sol`, reasoning low | `codex exec --output-schema` |

- **Why not a unified SDK:** it would hide the things the benchmark needs, which are exact cache-token fields and raw requests for traces.
- **Caching is mostly the layout, not adapter code.** The Token Plan caches a matching prefix automatically, in 1,024-token blocks, with no `cache_control`; the CLIs place their own breakpoints. The static-first layout suits all three.
- **Usage is normalised** into `Usage` per adapter. The CLIs and the prepaid Token Plan report no USD cost, so the report prices tokens at list rates (`LIST_RATES` in `server/src/eval/report.ts`).

#### The schema works in every provider's dialect
- **One wire schema**, hand-written as JSON in `submit-plan.ts` (strict-mode shaped), with a Zod `SubmitPlan` type that parses every reply.
- **What the strict modes share:**
  - every property must be in `required`, so optional fields become nullable (`"type": ["string", "null"]`);
  - `additionalProperties: false` on every object;
  - `anyOf` is supported. `oneOf` isn't, so we don't use it.
- **So the wire schema is shaped as follows:**
  - The root is an object: `type` enum plus nullable fields for each variant.
  - Steps are an `anyOf` of three flat shapes: action, resolve and op.
  - **No recursion and no `$defs`.** `forEach.do` holds a list of action calls (its own non-recursive shape).
- **Always validate with Zod afterwards**, whatever the provider guarantees. `json_object` mode doesn't enforce the schema, and the repair call covers it.

#### The look loop doesn't use native tool-result messages
- The loop doesn't thread native `tool_use`/`tool_result` messages, whose format differs by provider.
- Instead, the next round **appends a block after `<message>`** in the same user block (`<looked>`, or `<rejected_plan>` and `<errors>`).
- Everything before it stays byte-identical, so caching still hits. There's nothing to translate between formats.

#### Prompt overrides per model
- Not built. One prompt serves every model; compare models on **cost per successful task**, not raw token counts, because tokenizers differ.

#### Routing by difficulty
There's essentially one LLM call per turn, the planner. The summary is templated and retrieval uses no LLM (only a small local embedding model).

**Built differently: no router.** Every adapter has a `fast` and a `strong` tier, picked per request (`tier` in the request body, `--fast` in the eval), but both default to the same model. The feature rules, validation cascade and misroute measurement planned here were not built. One model on both tiers met the model-call target, at $0.0041 a run at list rates.

#### Variants in the benchmark
- Run: the planner against `baseline` (one call per step) on the same scenarios and model. See [BENCHMARK.md](../BENCHMARK.md).
- Not run: `routed`, `strong-only`, `ceiling` and `routed-deepseek`.

---

## 3. Follow-ups and context

**Built differently:** no addressable working set and no `$ctx.<name>` handles (compile rejects `$ctx` with "$ctx is not available yet"). Follow-ups name earlier records by their ids instead, which the prompt already carries. That kept one reference syntax (`$s1…`) and no rows in the prompt.

What each turn carries forward (`server/src/server/conversation.ts`, `records.ts`):

```ts
{ context: "…the last 4 exchanges, as text…",                 // → <context>
  records: [ { entity: "lead", id: "ld_41", name: "Ana Ruiz", for: "M03.A05" }, … ],  // up to 12 → <recent_records>
  carry:   { prev: [/* last plan's actions */], entities: [...], made: [/* record types it created */] },
  pending: /* an execution awaiting approval: its id, plan and approvals so far */ }
```

- The planner receives `<context>` and `<recent_records>`, never the raw history or rows. Records are typed ids with a name, so a follow-up can act on them or re-read them.
- Retrieval carries the last plan's actions, plus actions on a record type the last turn made (§2 ①, step 7).
- A follow-up that would remake records the last turn already made is sent back once with that said plainly, so "only the Facebook ones" amends the work instead of redoing it.
- **The brief's follow-up**, "Only include leads from the Facebook campaign, and make those tasks due tomorrow", as built: re-read the leads by id, `filter` by `source = facebook_ads` and `exclude` for the complement, cancel the dropped leads' tasks (M06.A10, destructive, so code asks), and set the kept tasks' due date. [PROMPT-EXAMPLE.md](PROMPT-EXAMPLE.md) walks through it.
- **It's the weakest case.** Follow-ups pass 89.2% of runs in [BENCHMARK.md](../BENCHMARK.md), and the brief's exact wording failed all 3 runs (a reworded version passed 1 of 3).
- **Ambiguity to test:** "Facebook campaign" could mean the lead source or an M15 Campaign record. The demo assumes the source field. An eval scenario covers both readings: with a campaign named "Facebook" seeded, the planner should clarify.
- Good demo moment: the assistant amends work it already did instead of redoing everything.

---

## 4. Registry and handlers

### Layout

```
server/src/
  core/        compile, execute, refs, lookups, summarize, no-match, datetimes
  planner/     turn, prompt, submit-plan, qwen, claude-cli, codex-cli, index, types, usage
  retrieval/   cards.json, cards, embed, mentions, retrieve, text, eval
  server/      app (node:http + SSE), conversation, baseline, records, diff
  registry/    define, registry, invoke, helpers, lookup, arguments, catalog.json, smoke.test.ts
  modules/
    m01-contacts/   index.ts  (10 actions + resolvers)  schema.ts  contacts.test.ts
    ...
    m50-reports/
  store/       db.ts (node:sqlite, faults), seed.ts, fixtures.ts, dev.ts (file DB), clock.ts, world.ts
  eval/        scenario, report, selection, failure-class, replay, history
  scripts/     ask, eval-scenarios, eval-retrieval, report, build-cards, db-reset …
eval/          scenarios as JSON (scenarios/, brief-, param-, module-, policy-scenarios/), retrieval/, results/, targets.json
web/           Vue 3 + Vite
```

### Action definition

`M01.A01` as built (`server/src/modules/m01-contacts/index.ts`, handler body shortened):

```ts
const createContact = defineAction({
  id: "M01.A01",
  description: "Add a person to contacts (an existing customer or person you deal with). For a new prospect, use M03.A01 Create lead.",
  risk: "write",                       // read | write | destructive | external
  input: z.strictObject({ firstName: Name, lastName: Name.optional(), email: z.email().optional(),
                          phone: z.string().min(5).optional(), company: z.string().optional(),
                          ownerId: z.string().optional().describe("user id"), tags: z.array(z.string().min(1)).optional() }),
  output: Contact,
  siblings: ["M03.A01"],
  entities: { produces: "contact" },
  example: () => ({ firstName: "Grace", lastName: "Hopper", email: "grace@navy.example" }),
  handler: (a, { store, clock }) => {
    if (a.email) { const dup = emailOwner(store, a.email);
      if (dup) throw new ActionError("DUPLICATE", `A contact with ${a.email} already exists: …`, { existingId: dup.id }); }
    if (a.ownerId) activeUser(store, a.ownerId, "own contacts");
    return store.insert("contacts", "ct", { /* … */ createdAt: clock.now().toISOString() });
  },
});
```

- **Built differently:** `bulk` is not a risk level; bulk is decided per plan (a write repeated over 3 or more items). Handlers are synchronous, since the store is in-process SQLite. Module and name come from the folder and the catalog, not the definition. Optional fields cover lookups (`argumentLookups`, `typedIds`), delivery (`destination`), checks before sending (`preflight`) and a `caveat` for the card.
- A module exports its `actions` and its name `resolvers` (contact, lead, user…), which entity resolution and name linking use.

### Rules
- **Hand-written handlers for every module.** A CRUD factory was the plan for 500 actions; each handler was written by hand instead so its guards are specific (e.g. a merged contact names the contact it went into). Shared pieces live in `registry/helpers.ts`: `activeUser`, `requireState`, `requirePermission`, `atLeastOne`, `notPast`, `page`, with `mustGet` in `registry/define.ts`.
- **Every action has an `example(f)`** built from the seed or from fixtures, so the smoke test can run it.
- **One path to run a handler:** `registry/invoke.ts` checks injected faults, runs the handler, parses the output schema and writes the audit entry. The executor and tests both go through it.
- **Data:** `node:sqlite`. Tests get a fresh in-memory seeded store each (`testWorld()`), and add what a case needs through fixtures (`f.lead({...})`, `f.task({...})`). The CLI and UI use a file DB, `server/data/dev.sqlite` (gitignored), rebuilt with `npm run db:reset`.
- **Auto-registration:** `loadRegistry` scans `modules/`. A new module is one folder with no core change (the extensibility requirement).
- **Descriptions in user language**, not REST language. They're the retrieval surface and the main quality lever.
  - Spell out direction and meaning wherever everyday words are ambiguous. For example, M11.A10 takes `waitingOn: "contact" | "team"`, and its description says which side wrote last in each case.
  - Look-alike siblings in other modules cross-reference each other, e.g. "For a new prospect, use M03.A01 Create lead."
- **Search cards** (synonyms, a user-language description, siblings, entity types) were generated once by an LLM (`npm run cards`), checked by tests and committed in `retrieval/cards.json`; the registry's own fields refine them at runtime (§2 ①). They describe the action in general terms, not the brief's example prompts or the eval questions. The README discloses this.
- **Frozen clock:** `clock.now()` is pinned (2026-10-21 14:00 UTC, a Wednesday 10:00 in New York) in the seed and the evals, so "last week" and "tomorrow" give the same result every run.
- **Fault injection:** a `faults` table in the store (`store/db.ts`), checked in `registry/invoke.ts`. A scenario can make an action fail with any error code, optionally only for matching args or for a set number of calls.
- **Handlers never always-succeed.** Validate, return typed `ActionError`s (`NOT_FOUND`, `DUPLICATE`, `INVALID`, `CONFLICT`, `PERMISSION`, `TIMEOUT`, `UNAVAILABLE`), and mutate state for every write.

---

## 5. Evaluation harness

### Scenario format

**Built differently:** JSON, not YAML (`server/src/eval/scenario.ts` checks it with Zod). A real one, from `eval/scenarios/failure.json`:

```json
{ "id": "failure-email-provider-down",
  "category": "failure",                          // direct|indirect|multi|followup|ambiguous|unsupported|failure
  "modules": ["M13"],
  "setup": [ { "fault": "M13.A03", "code": "UNAVAILABLE", "message": "The email provider is not responding" } ],
  "turns": [ { "user": "Email Rosa Ito to thank her for renewing" } ],
  "expect": {
    "status": ["failed", "partial"],
    "state": [ { "sql": "SELECT count(*) FROM emails WHERE json_extract(data,'$.contactId')='ct_1' AND json_extract(data,'$.createdAt')>='2026-10-21' AND json_extract(data,'$.status')<>'draft'", "equals": 0 } ],
    "reply": { "includes": ["fail|couldn.t|could not|unable|not sent|didn.t|unavailable|not responding"] } } }
```

- `setup` also takes fixtures (`{ "fixture": "form", "with": { "name": "Contact Us" } }`). Each turn approves by default (`"approve": false` declines). `expect` can also check `actions` (`includes` / `excludes`, with `A|B` alternatives), `args` (a subset `match` per action), `noChanges` and `confirmation`.

### Runner
- `npm run eval:scenarios`: for each scenario, a fresh seeded database, the turns through the same conversation code as the web app, then the checks. `--agent baseline`, `--fast`, `--cache` (replay recorded planner replies) and `--only` select variants.
- Run each scenario **3 times** (`--repeat 3`) and report pass rate. **Built differently:** no temperature 0; none of the adapters set a temperature, which is why each scenario runs 3 times.
- **Coverage:** 273 scenarios across all 7 categories, touching all 50 modules. LLM-drafted, assertions reviewed by hand. Runs that fail outside the app (quota, timeout, provider down) are counted apart.

### Smoke test (`registry/smoke.test.ts`)
- All 500 actions: the action's example must succeed, a made-up param must return `INVALID`, and an unknown id `NOT_FOUND`. A module is complete or absent. No LLM.

### Metrics
| Metric | Definition |
|---|---|
| Retrieval recall@k | expected actions present in the retrieved set |
| Action selection | precision / recall vs expected actions |
| Parameter accuracy | matching subset of expected args |
| Task success | every check passes: status, actions, args, final data (SQL) and reply |
| First reply (TTFUR) | time to the first useful reply: the answer, a clarifying question, or the approval prompt |
| E2E | time to the last reply, approvals and every turn included |
| Cost | usage tokens × list rates (`LIST_RATES` in `server/src/eval/report.ts`); cached tokens counted separately; failed and repair calls included |
| Calls/task | number of LLM calls per request |

Report p50 and p95, split into **direct** vs **complex**. Report cost **per run** and **per successful task**. **Built differently:** no separate iterations metric; model calls per task covers it.

### Variants (same scenarios)
- Run: `planner` (retrieval + plan-execute + looks) against `baseline`, the usual tool-calling loop (one action per model call) over the same shortlist, name matches, context and approval rules. Same model, same scenarios.
- Retrieval: BM25 against hybrid (`RETRIEVAL=bm25`), names on and off (`--no-mentions`), and settings via `--set`. No LLM.
- **Not run:** the full-catalog ReAct baseline, the model and routing variants, and the loop-off and cache-off ablations.

### Report
- `npm run report` generates `BENCHMARK.md` from the results JSON: tables by category, latency, cost per task, the targets, and every failing run listed.

### Targets
Committed 2026-10-23 in `eval/targets.json`, **before** the final benchmark, and unchanged since. Measured in [BENCHMARK.md](../BENCHMARK.md#targets):

| | Target | Measured |
|---|---|---|
| Direct: first reply p50 / p95 | ≤ 1.5 s / ≤ 3 s | 1.3 s / 4.3 s (p95 missed) |
| Complex: E2E p50 / p95 | ≤ 6 s / ≤ 12 s | 1.6 s / 7.8 s |
| Action selection (direct / complex) | ≥ 95% / ≥ 85% | 99.2% / 98.3% |
| Task success overall | ≥ 85% | 96.9% |
| LLM calls per complex task | ≤ 2 median | 1 |

---

## 6. Stack

- **Backend:** Node 26 + TypeScript, plain `node:http` with SSE, Zod 4, the built-in `node:sqlite`, a small seeded generator instead of faker (fixed seed).
- **Retrieval:** MiniSearch (BM25) over LLM-generated action cards, fused with a local embedding model (bge-base via transformers.js). Offline, ~10 ms a question. Added after it beat BM25 alone on the held-out split (see [Retrieval](#retrieval)).
- **LLM:** no LangChain or unified SDK. DeepSeek (`deepseek-v4.1-flash-1017`) through the Qwen Token Plan's OpenAI-compatible endpoint is the benchmarked default; Claude Haiku 5.5 through `claude -p` runs without a key, and Codex is opt-in (see [Model providers and routing](#model-providers-and-routing)). No router: both tiers use the same model by default.
- **Testing and UI:** `node:test` (run through tsx) for unit, module and smoke tests. Vue 3 + Vite for the web app.

---

## 7. Schedule

The original plan, kept as written. JOURNEY.md records what happened.

| Day | Build | Done when |
|---|---|---|
| **1 · Tue 20** | Repo, registry, `defineAction`, SQLite store, seed, clock, faults, compile + execute with gates, approvals and the writes ledger. Catalog of all 500 actions | The Facebook-leads workflow runs end to end in tests |
| **2 · Wed 21** | v1 scope. Fixtures, `invoke`, dev DB. M01, M03, M06, M48, M49 at 10 actions each with edge-case tests | 196 tests green ✅ |
| **3 · Thu 22** | The other 10 v1 modules (M04, M07, M08, M11, M12, M13, M15, M21, M28, M29). BM25 retrieval over all 500 with "not in v1" answers. Anthropic adapter, follow-ups, observe loop | 15 modules smoke green; the brief's example prompts work from the CLI |
| **4 · Fri 23** | Fastify SSE + Vue UI. 100+ scenarios over the v1 modules, eval runner, baseline, benchmark → fix top failure classes | UI demo works; benchmark JSON + first report |
| **5 · Sat 24** | Final benchmark, README (scope and what's next), demo video (2–5 min), buffer | Submitted |

### Risks
1. **Writing and reviewing scenarios takes long.** Start drafting on day 3.
2. **Ten more modules on day 3.** The pattern, helpers and test style are set by the first five; if day 3 slips, retrieval and the adapter come first and the last modules move to the post-v1 batch.
3. **Retrieval misses on look-alike actions** (contacts vs leads, email vs conversations). Track recall@k as its own metric and tune descriptions and synonyms against it.
4. **Non-determinism.** Temperature 0, repeated runs, and report variance instead of hiding it.
5. **Semantic traps that retrieval can't catch.** The action is right but its meaning is inverted, e.g. "haven't replied" vs "unanswered", or "Facebook campaign" as a lead source vs a Campaign record. Keep a named eval category for these and fix them in card descriptions and params, not in the prompt.

---

## 8. Prior art

The original plan, kept as written.

`../ask-ai-slice/` is an earlier dependency-free JS prototype: 1 module and 5 actions, with a rule-based planner standing in for the LLM. It already shows the descriptor shape (user-language descriptions, aliases, `sideEffect`, `requiresConfirmation`), slot-filling clarification, the confirmation gate, and evals that assert state. Reuse those ideas. This repo is the real TypeScript build.
