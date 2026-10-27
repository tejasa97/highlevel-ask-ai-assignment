# Ask AI — Build Plan

Working plan for the HighLevel "Ask AI framework" assignment. The requirements and a checklist are in `ASSIGNMENT.md`, and the original PDFs in `assignment/`; both are kept locally, not in the repo.

**Deadline:** 5 days from 2026-10-19, so submit by **Sat 2026-10-24**.
**Questions:** reply on the email thread; Nikhil (panel) is cc'd.

**Scope (decided 2026-10-21): v1 = 15 modules in depth.** All 500 actions stay in the catalog and in retrieval, but only these 15 modules have handlers; a request that lands on one of the other 35 gets an honest "not available in v1" answer, never a fake success. The other 35 come after v1 works end to end and covers its edge cases.

**Status (2026-10-23):** the other modules have since been built, so all 50 modules and 500 actions execute and the "not available in v1" answer no longer applies. See the README and [BENCHMARK.md](../BENCHMARK.md). The rest of this plan is the original design and schedule, kept as written.

| Group | Modules |
|---|---|
| CRM core | M01 Contacts, M03 Leads, M04 Opportunities, M06 Tasks, M07 Notes, M08 Tags |
| People | M48 Users, M49 Teams |
| Messaging | M11 Conversations, M12 SMS, M13 Email, M15 Campaigns |
| Scheduling and money | M21 Appointments, M28 Invoices, M29 Payments |

Depth means: all 10 actions per module, real validation and state changes, permissions, and a test file per module for its edge cases (duplicates, closed or archived records, inactive users, last-admin guards, merges, conversions) on top of the per-action smoke test.

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
│      ├─ Tool retriever  (BM25 + local embeddings over   │
│      │                   the 500 action cards, no LLM)  │
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

### ① Retrieve (~10 ms, no LLM)
- BM25 (MiniSearch) over **action cards**, one per catalog action (500). Each card holds the id, module, name, a one-line description, 6–10 synonyms, siblings and entity types.
- A small local embedding model (bge-base) ranks the same cards by meaning; the two rankings are fused (see [Retrieval](#retrieval)).
- Returns 15 ranked picks spread across modules. Siblings, producers and carried actions are added on top, ~19 cards in total on average.
- Result here: M03.A03 Search leads, M49.A09 Get team workload and M06.A01 Create task rank in the top 6, with M03.A05 Assign lead owner and its sibling M01.A07 Assign contact owner alongside.
- For how the shortlist is built and measured, see [Retrieval](#retrieval) below.

#### Retrieval

**BM25 first, then embeddings once they beat it**
- BM25 went first: the card synonyms carry much of what embeddings add. With names alone, held-out recall@15 is 71.7% (paraphrases 22.2%). With generated cards it's 93.1% (paraphrases 88.9%). It is deterministic and explainable (the trace shows which words matched which field).
- The bar for embeddings was beating that on the held-out split. 80 more paraphrase-heavy questions (h01–h80, across the 10 newer modules) showed where BM25 falls short: wordings that share no words with the card ("hold off on the fall webinar emails" → Pause campaign). Test split, recall@15: BM25 86.8% → hybrid 94.9%; paraphrases 76.6% → 89.4%. On all 239 questions: 90.0% → 97.1% (97.6% with the module-cap backfill below). Direct questions stay at 100%, out-of-scope rejection is unchanged.
- **How they're combined** (`retrieve.ts`, `embed.ts`): the embedding model ranks all cards for the whole message and for each clause. The top 20 of each ranking joins reciprocal-rank fusion with the BM25 lists at equal weight. Cards in the top 10 of a meaning ranking skip the BM25 score floor, since they may share no words with the question. "No match" is still decided by BM25 alone, because an embedding ranking always has a nearest card. Picks only the embedding found are labelled `dense` in the trace.
- Settings were chosen on the dev split (floor exemption 0/5/10/20, top 10/20/30, weight 0.5/1/2), then the test split was run once. A sweep across models (MiniLM, bge-small, bge-base) was done earlier with all splits visible; bge-base won on every split.
- **Cost:** `Xenova/bge-base-en-v1.5`, quantized, runs locally through transformers.js (no API call). 113 MB on disk, downloaded once into `server/data/models/`. Card vectors take ~30 s on first start and are cached in `server/data/`, keyed by the card text and model. Measured on an M1 Pro: ~300 ms to load, ~10 ms per question, ~250–310 MB more memory. `RETRIEVAL=bm25` turns it off. If the model can't load, retrieval falls back to BM25 and logs one line.

**Cards** (`server/src/retrieval/cards.json`)
- Name and module come from the catalog. Description, synonyms, siblings and entity types were generated once by an LLM per action (~$2 for all 500) and are committed.
- The generator never sees `eval/`. A test fails if any synonym equals an eval paraphrase after normalising.
- Unbuilt actions keep their cards. Retrieval can then say "that's Send invoice reminder, which isn't in this version" instead of guessing at something nearby.

**Text** (`retrieval/text.ts`)
- Porter stemming, stopwords, numbers dropped, hyphen forms ("follow-up" → follow, up, followup).
- A small shorthand table (txt, appt, to-do, opp…) expands both ways.
- Fuzzy matching (edit distance 1 from 5 letters, 2 from 9) absorbs typos like "apointment".

**Shaping the shortlist** (`retrieval/retrieve.ts`)
1. **Field boosts:** name 3, synonyms 2, module 1.5, description 1.
2. **Clause splitting:** "…, give them to …, and make …" becomes one search per clause. The lists are merged with Reciprocal Rank Fusion, `Σ 1/(60 + rank)`, over the clause lists and the whole message.
3. **Per-clause guarantee:** the top 2 of each clause go first. RRF on its own favoured cards that were middling in every list, and ranked Search leads 20th for the Facebook request.
4. **Module cap** 6, **score floor** 10% of the top score, then cut to **k = 15** (where the dev recall@k curve levels off). The cap makes room for other modules; when nothing else clears the floor, the capped cards get the empty slots back ("answer the 2-star review" is all about reviews). All questions 97.1% → 97.6%, test split unchanged; it only adds picks, so no question can lose one.
5. **Siblings** of the top 3 picks only. Adding them for every pick cost ~12 cards a question for under a point of recall.
6. **Producers:** if a pick consumes a record type no pick produces, add the best producer. Contact, lead, user and team are skipped, because the planner resolves those by name.
7. **Carried actions:** the previous plan's actions, so "make those high priority" keeps its tools.
8. **Names** (`retrieval/mentions.ts`): capitalized runs in the message are looked up with the resolvers (contact, lead, user, team; not tasks, whose titles are too noisy). A name links only if all its words are whole words of a record's name, so "Tom" doesn't link to "Tomas". A run that opens a sentence is retried without its first word ("Call Ana Ruiz"); mid-sentence it isn't, so an unknown "Jo Park" doesn't link to a user named Park. Each linked type adds its get and search actions. Before this, "What is Sarah Johnson's status?" never says "contact", and the shortlist had no contact actions at all. A linked name also overrides no-match ("tell me about Victor Larsen").
- Every added card records `via` (which pick brought it in). The trace shows it.

**Query construction**
- When the last reply was a question, the retrieval query is that question plus the answer. ("Ana Ruiz" on its own finds nothing useful.)
- `search_tools`: the planner names what's missing. One more retrieval runs on that text, excluding cards already shown, and the new cards are appended. A second `search_tools` ends the turn as unsupported.
- **No-match detection is left to the planner.** "Book a flight" scores higher than a typical in-scope question, because "book" and "order" are real action words. The threshold only catches nonsense.

**What the planner sees**
- `<actions>` holds only the shortlisted *implemented* actions. The cost is ~6 k characters instead of ~35 k for every implemented action, and it falls further as modules are added.
- `<not_available>` lists unbuilt actions that matched, so the reply can name them.
- `<mentions>` names the record type each linked name belongs to ("Hiro Reyes: lead", "Sarah Johnson: 2 contacts"). The planner had resolved Hiro Reyes as a contact, and the step failed.
- Compile rejects any action the planner wasn't offered, and any unbuilt one, with an error the repair round can act on.

**Measured** (`npm run eval:retrieval`; no LLM, ~0.3 ms a question)
- 40% of the 167 questions (`eval/retrieval/queries.jsonl`) are held out by id hash: 67 in scope plus 2 out of scope. All tuning used the dev split only. At this size one question moves recall by about 1.5 points, and a paraphrase by about 5.

| held-out test split | R@5 | R@15 | all needed @15 | MRR | cards |
|---|---|---|---|---|---|
| names only | 62.4% | 71.7% | 69.8% | 0.56 | ~14 |
| final, before names | 84.9% | 93.1% | 92.1% | 0.69 | ~18 |
| with names linked | 85.8% | 93.5% | 92.5% | 0.65 | ~19 |

- By group at R@15: direct 100%, paraphrase 88.9%, multi-intent 97.0%, typo 83.3% (n=6), follow-up 66.7% (n=3), lookup 100% (n=4). No in-scope question was rejected as no match.
- The remaining misses are vague questions, a typo too short for fuzzy matching ("tagg"), and context-free follow-ups ("did it go through?"), the territory `search_tools` covers.
- The lookup group (10 questions that ask about a named person: "is Hiro Reyes qualified yet?") was added for the names step. On the full set it went from 40% to 100% at R@15, with no other group moving. Its MRR stays near 0 because those actions come from the link, not from BM25. `--no-mentions` turns linking off for comparison.
- `retrieve.test.ts` gates regressions on the full set: R@15 ≥ 90%, direct 100%, paraphrase ≥ 80%, zero false rejects.

**What retrieval can't do**
- **It matches words, not direction or negation.** "Haven't replied" and "replied" share terms, and so do "exclude booked" and "booked". Those cases are handled by card wording, params (`waitingOn`) and the planner's ops.
- **It doesn't know your data.** "The Facebook campaign" can't tell retrieval whether a Campaign record exists. Entity resolution (③) checks that.

### ② Plan (1 LLM call)
- Output: one JSON object matching the `submit_plan` schema, enforced through the provider's structured-output mode. It's one of `answer | clarify | unsupported | plan | search_tools`.
- **Why structured output, not a forced tool:** on Claude Opus 5.5 and Sonnet 5.5, forcing a tool (`tool_choice` of `tool` or `any`) returns a 400 error. Anthropic's docs point to structured outputs instead, and OpenAI supports the same idea, so it's the most portable mechanism (checked 2026-10-21, see [Model providers and routing](#model-providers-and-routing)).

#### Prompt structure
For a full two-turn example with real payloads and token counts, see [PROMPT-EXAMPLE.md](PROMPT-EXAMPLE.md).

```
format:  submit_plan JSON schema                  static, structured-output mode (no tools)
system:  role + rules + plan grammar + examples   static   ── cache breakpoint ──
user:    <now> <context> <recent_turns> <actions> <message>   rebuilt every turn
```
- **Retrieved actions are prompt text, not tool definitions.** The model gets no tools at all; it must answer in the `submit_plan` schema. That keeps the request prefix static and cacheable, and the model plans instead of calling tools.
- **Cache minimums are well below our prefix:** 512 tokens for Opus 5.5, Sonnet 5.5 and Haiku 5.5, and 1,024 for GPT-5.6 and later. Our static prefix is ~1,500 tokens.
- **Nothing that changes per request goes before the breakpoint**: no timestamp, user name or retrieved cards.
- **`<now>`** holds the date, the timezone and precomputed ranges (today, tomorrow, this week, last week). The model picks a range and never does calendar math.
- **Across user turns the request is rebuilt from scratch.** History arrives only as `<context>` (the working set) and `<recent_turns>` (the last 2–3 exchanges as text). So the size of turn 10 stays close to turn 2.
- **Within one turn** (the observe loop), the next round appends an `<observations>` block (previous plan + result digest) after `<message>`. The prefix stays byte-identical, so the cache still hits, and no provider-specific tool-result format is needed (see [Model providers and routing](#model-providers-and-routing)). Extra cards from `search_tools` go inside `<observations>` rather than replacing `<actions>`.

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

### Model providers and routing

> **Decision, 2026-10-21: development runs on `claude -p`.** `server/src/planner/claude-cli.ts` (`PLANNER=claude-cli`, the default) spawns `claude -p --json-schema` on the developer's Claude subscription. It uses `claude-sonnet-5-5` for both tiers (`CLAUDE_FAST_MODEL` overrides `fast`): through `claude -p`, Haiku 5.5 always thinks (~1.2k tokens; `MAX_THINKING_TOKENS=0` and `--effort low` only trim it to ~900), so it took 7–11 s against Sonnet's 4 s. It runs with no tools, no MCP, no settings or hooks, an empty cwd and our own system prompt. Both models passed the 4-message probe with correct workflow semantics, at 4–10 s per call (~1.5 s of that is process start). **Update, 2026-10-25:** both tiers now default to `claude-haiku-5-5`, by its full id: the `haiku` alias resolves to `claude-haiku-4-5-20251001` on CLI 2.1.284, which scored 91.3% on regression against 100% (8x, 7.2 s p50) for Haiku 5.5. Set `CLAUDE_MODEL=claude-sonnet-5-5` to run the model measured here.
>
> **This adapter is for development only and is never used for benchmark numbers.** It has no temperature control, Claude Code places its own cache breakpoints, its `total_cost_usd` is an estimate (it priced Haiku above Sonnet), and it shares the subscription's rate limits. The benchmark runs on a direct API key through the Anthropic adapter below, which still has to be built.
>
> - **Args travel as a JSON string (`argsJson`).** Strict modes require `additionalProperties: false` on every object, so a loose `args` object isn't allowed. Zod checks the parsed args against each action's schema.

#### One planner interface, thin adapters
Retrieval, `<context>` rebuilding, the plan grammar, validation, execution, the risk policy and the observe loop are all app code. The model has one job: return one valid `submit_plan` object. So the provider boundary is small:

```ts
interface Planner {
  readonly id: string                      // "anthropic:claude-sonnet-5-5"
  readonly caps: { mode: "json_schema" | "forced_tool"; strictSchema: boolean; explicitCache: boolean }
  plan(req: { system: string; user: string }): Promise<{ decision: unknown; usage: Usage; raw: unknown }>
}
type Usage = { input: number; cachedRead: number; cacheWrite: number; output: number; costUsd: number }
```

- **Two adapters**, each ~100–150 lines, written directly against the provider SDK:
  - `anthropic`;
  - `openai-compatible`, which covers OpenAI, DeepSeek, Groq, Together and local vLLM/Ollama by changing `baseURL`.
- **How each provider is made to return `submit_plan`** (checked against the official docs on 2026-10-21):

  | Provider | Mechanism | Notes |
  |---|---|---|
  | Anthropic (Sonnet 5.5, Opus 5.5) | `output_config.format: { type: "json_schema", schema }` | Forced `tool_choice` (`tool` / `any`) returns 400 on these models. Haiku 5.5 still allows it, but we use one mechanism for both tiers |
  | OpenAI (Responses API) | `text.format: { type: "json_schema", strict: true, schema }` | Schema root must be an object, not `anyOf` |
  | DeepSeek (`deepseek-flash`, `deepseek-v4-pro`) | Forced function: `tool_choice: { type: "function", function: { name: "submit_plan" } }` with `strict: true` | Strict is beta and needs `baseURL` `https://api.deepseek.com/beta`. A named `tool_choice` returns 400 in thinking mode, which is on by default, so send `thinking: { type: "disabled" }`. We found no documented JSON-schema response format |

- **Why not a unified SDK:** it would hide the things the benchmark needs, which are exact cache-token fields, raw requests for traces, and control over `cache_control`.
- **Caching is mostly the layout, not adapter code.** All three caches match on a byte-identical prefix, so the static-first layout suits every provider:
  - **Anthropic:** explicit `cache_control` breakpoints, up to 4 per request. Order is `tools` → `system` → `messages`. TTL is 5 minutes by default, or 1 hour. Writes cost 1.25× input (2× for 1 hour); reads cost 0.05× on Opus 5.5 and Sonnet 5.5, and 0.1× on Haiku 5.5. Changing `tool_choice` only invalidates the messages cache.
  - **OpenAI:** on by default. GPT-5.6 and later have implicit mode (the default, with a breakpoint at the end of the latest message) or explicit breakpoints. Minimum 1,024 tokens. TTL is `30m` by default or `12h`. Writes cost 1.25× (2.5× for 12h) and reads 0.1× on most models. Earlier models have no write charge. Changing `tools`, `parallel_tool_calls`, `text.format` or reasoning effort can change the cached prefix, so keep them constant.
  - **DeepSeek:** automatic and best-effort, with no stated minimum. Caches are cleared after "a few hours to a few days" of disuse.
- **What does differ is reading usage back.** Each provider names the cache counters differently:

  | Provider | Cache read | Cache write |
  |---|---|---|
  | Anthropic | `cache_read_input_tokens` | `cache_creation_input_tokens` (`input_tokens` = tokens after the last breakpoint; total = read + write + input) |
  | OpenAI (Responses) | `usage.input_tokens_details.cached_tokens` | `usage.input_tokens_details.cache_write_tokens` (GPT-5.6+; reads exclude tokens billed as writes) |
  | DeepSeek | `prompt_cache_hit_tokens` (also `prompt_tokens_details.cached_tokens`) | n/a (`prompt_tokens` = hit + miss) |

  Normalise these into `Usage`. Prices live in `pricing.json` per model, with the date checked. The cost report depends on this.

#### The schema works in every provider's dialect
- **One source of truth:** the plan schema is written in Zod. Each adapter generates the JSON Schema form its provider accepts.
- **What the strict modes share** (OpenAI, DeepSeek; Anthropic's list overlaps):
  - every property must be in `required`, so optional fields become nullable (`"type": ["string", "null"]`);
  - `additionalProperties: false` on every object;
  - `anyOf` is supported. `oneOf` isn't listed as supported by any of the three, so we don't use it.
- **Provider-specific limits that shape our schema:**
  - **OpenAI:** the root must be an object, not `anyOf`. A Zod discriminated union at the root "won't work". `$defs`, `$ref` and recursion are supported. Up to 5,000 properties and 10 levels of nesting.
  - **DeepSeek:** definitions use `$def`, not `$defs` (`"$ref": "#/$def/step"`). `minLength`, `maxLength`, `minItems` and `maxItems` are unsupported.
  - **Anthropic:** recursive schemas, numeric limits and string length limits are unsupported. `minItems` is only allowed as 0 or 1. This came from a summary of the docs page, so check the exact text when building the adapter.
- **So the wire schema is shaped as follows:**
  - The root is an object: `type` enum plus nullable fields for each variant.
  - Steps are an `anyOf` of three flat shapes: action, resolve and op.
  - **No recursion.** `forEach.do` holds a list of action calls (its own non-recursive shape), and `if.then` / `if.else` name step ids instead of nesting steps.
  - The canonical Zod type stays a discriminated union, and each adapter converts it.
- **Always validate with Zod afterwards**, whatever the provider guarantees. DeepSeek and local models don't enforce schemas, and the existing single repair call covers them.
- **Adapter settings:**
  - Function-call `arguments` arrive as a JSON string (OpenAI, DeepSeek), so parse them in the adapter.
  - Where a forced function is used (DeepSeek), set `parallel_tool_calls: false`.
  - DeepSeek's docs warn the model "does not always generate valid JSON, and may hallucinate parameters" outside strict mode. Zod catches this.
  - Capabilities are per-model flags (`caps.mode`), filled from the docs and confirmed by an adapter smoke test, not assumed.

#### The observe loop doesn't use native tool-result messages
- The observe loop doesn't thread native `tool_use`/`tool_result` messages, whose format differs by provider.
- Instead, the next round **appends an `<observations>` block after `<message>`** in the same user block. It holds the previous plan and its digest.
- Everything before it stays byte-identical, so both explicit and automatic caching still hit. There's nothing to translate between formats.
- Native threading stays available as an adapter option, if a model does measurably better with it.

#### Prompt overrides per model
- The prompt's structure carries over between models, but its wording may not. Smaller or non-Anthropic models follow rules differently and need different examples.
- Each model gets an optional override file (`prompts/<model>.md`) for extra examples or rule emphasis. The core prompt is never forked.
- Every model is a separate benchmark variant on the same scenarios.
- Compare models on **cost per successful task**, not raw token counts, because tokenizers differ.

#### Routing by difficulty
There's essentially one LLM call per turn, the planner. The summary is templated and retrieval uses no LLM (only a small local embedding model). So the saving comes from choosing **which model plans each request**, not from moving "other work" to a cheaper model.

**Two tiers:** `fast` and `strong`. To start, `fast` is Haiku 5.5 and `strong` is Sonnet 5.5: same provider, same tokenizer, one adapter, so the routing effect is measured on its own. On the API adapter, `fast` sets thinking explicitly (off or a small budget); the dev CLI path showed Haiku's default thinking makes it slower than Sonnet, so Haiku's latency must be measured with thinking pinned.

| Model (per MTok, checked 2026-10-21) | Input | Cache read | Output |
|---|---|---|---|
| Haiku 5.5 (prompts ≤ 100k tokens) | $0.10 | $0.01 | $0.50 |
| Sonnet 5.5 | $2.00 | $0.10 | $10.00 |
| Opus 5.5 | $4.00 | $0.20 | $20.00 |

Haiku 5.5 costs about 1/20 of Sonnet 5.5, and Opus 5.5 costs only 2× Sonnet 5.5.

**1. Feature routing (no LLM, from the retrieval output)**

| Signal | Leans `fast` | Leans `strong` |
|---|---|---|
| Clauses after splitting | 1 | ≥ 2 |
| Distinct modules in the shortlist | 1–2 | ≥ 3 |
| Gap between top-1 and top-2 score | clear winner | close |
| Words like "unless", "skip", "except", "only", "if" | absent | present |
| Follow-up that changes `$ctx` | n/a | present |

The rules are plain thresholds, logged with every decision. They're explainable and hard to overfit to 100 scenarios. A trained classifier only gets considered if the rules clearly fail.

**2. Validation cascade (for requests routed to `fast`)**
- `fast` plans first.
- If the plan fails Zod or the reference checks, or the model returns `search_tools` or `unsupported`, **escalate to `strong`** instead of making the usual repair call. Most model-routing setups lack a deterministic check; we have one for free.
- **Limit:** a valid plan isn't always a correct plan. For example, `waitingOn: "team"` would pass validation. That's why requests that look complex go straight to `strong`, and why misroutes are measured.

**3. What's measured**
- The share of requests on each tier.
- The escalation rate.
- **Misroutes:** scenarios that failed on `fast` but pass on `strong`.
- Cost per successful task, and p50/p95 latency.
- Thresholds are tuned on a pilot split, then **frozen before the final run**, so they aren't fitted to the scenarios they're scored on.

Illustrative only: `fast` costs ~1/20 as much. If it takes 60% of traffic and escalates 10% of that, cost is `0.4 + 0.6 × 0.05 + 0.06 ≈ 0.49×`, about half. The benchmark gives the real number. Most of the remaining cost is the 40% routed straight to `strong`, so the feature thresholds matter more than Haiku's price.

#### Variants in the benchmark
- `routed`: Haiku → Sonnet. This is the candidate default.
- `strong-only`: Sonnet.
- `ceiling`: Opus 5.5 as the planner, reported as "X% of Opus's quality at Y% of its cost". At only 2× Sonnet 5.5, it's also a real candidate for the `strong` tier if it clearly wins on complex scenarios.
- `routed-deepseek`: `deepseek-flash` as `fast`, through the OpenAI-compatible adapter. It runs separately so a provider difference isn't mistaken for a routing effect. The legacy `deepseek-chat` and `deepseek-reasoner` ids were discontinued on 2026-07-24.
  - **Data handling note for the README:** DeepSeek's privacy policy, as quoted by secondary sources, says it stores data on servers in the People's Republic of China. The API docs don't say where API data is processed, so check the policy and API terms directly before the README cites it. Either way, a real deployment would point to self-hosting the open weights or a US inference host.
  - DeepSeek prices weren't retrievable from its docs on 2026-10-21. Its change log says off-peak prices are half the peak rate, so record the time window in `pricing.json`.
- **Caches are per model**, so routing splits traffic across two prefix caches and lowers each one's hit rate at low volume. Report it.

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
    m01-contacts/   index.ts  (10 actions)  schema.ts  contacts.test.ts
    ...
    m50-reports/
  store/       db.ts (node:sqlite, faults), seed.ts, fixtures.ts, dev.ts (file DB), clock.ts
eval/
  scenarios/*.yaml   runner.ts   assertions.ts   report.ts   smoke.test.ts
web/           Vue 3 + Vite
```

### Action definition

```ts
export const createContact = defineAction({
  id: "M01.A01", module: "contacts", name: "create_contact",
  description: "Create a new contact person with name, email, phone, tags.",
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
- **Hand-written handlers for the v1 modules.** A CRUD factory was the plan for 500 actions; at 15 modules in depth, each handler is written by hand so its guards are specific (e.g. a merged contact names the contact it went into). Shared pieces live in `registry/helpers.ts`: `mustGet`, `activeUser`, `requireState`, `requirePermission`, `atLeastOne`, `notPast`, `page`.
- **Every action has an `example(f)`** built from the seed or from fixtures, so the smoke test can run it.
- **One path to run a handler:** `registry/invoke.ts` checks injected faults, runs the handler, parses the output schema and writes the audit entry. The executor and tests both go through it.
- **Data:** `node:sqlite`. Tests get a fresh in-memory seeded store each (`testWorld()`), and add what a case needs through fixtures (`f.lead({...})`, `f.task({...})`). The CLI and UI use a file DB, `server/data/dev.sqlite` (gitignored), rebuilt with `npm run db:reset`.
- **Auto-registration:** modules are discovered by directory scan. A new module is one folder with no core change (the extensibility requirement).
- **Descriptions in user language**, not REST language. They're the retrieval surface and the main quality lever.
  - Spell out direction and meaning wherever everyday words are ambiguous. For example, M11.A10 takes `waitingOn: "contact" | "team"`, and its description says which side wrote last in each case.
  - Look-alike siblings in other modules cross-reference each other, e.g. "(For contacts use M01.A07.)"
- **Search cards** (synonyms, a user-language description, siblings, entity types) live in `retrieval/cards.json`, not in the handler. They're generated once by an LLM (`npm run cards`), checked by tests, and committed. A read-through by hand is still to do. They describe the action in general terms, not the brief's example prompts or the eval questions. Disclose this in the README.
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
- Model variants: `routed`, `strong-only`, `ceiling` (Opus), `routed-deepseek` (see [Model providers and routing](#model-providers-and-routing)).
- Ablations: retrieval off, loop off (single plan only), small vs large planner model, prompt cache off.
- Retrieval ablations (no LLM, see [Retrieval](#retrieval)): names only vs. full cards, and per setting via `--set` (k, module cap, boosts, fuzzy, clause splitting). Embeddings and hybrid are a later variant.

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

- **Backend:** Node 26 + TypeScript, Fastify (SSE), Zod 4 (built-in `z.toJSONSchema`), the built-in `node:sqlite`, a small seeded generator instead of faker (fixed seed).
- **Retrieval:** MiniSearch (BM25) over LLM-generated action cards, fused with a local embedding model (bge-base via transformers.js). Offline, ~10 ms a question. Added after it beat BM25 alone on the held-out split (see [Retrieval](#retrieval)).
- **LLM:** Anthropic (Haiku 5.5 / Sonnet 5.5), no LangChain. Development plans through `claude -p` on the subscription; the benchmark needs the direct-API Anthropic adapter, which is designed, not built (see [Model providers and routing](#model-providers-and-routing)). A direct adapter gives exact token accounting, prompt-cache control and less overhead. A two-tier router (Haiku → Sonnet) with a validation cascade, as described in [Model providers and routing](#model-providers-and-routing).
- **Testing and UI:** `node:test` (run through tsx) for the smoke tests. Vue 3 + Vite for the web app.

---

## 7. Schedule

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

`../ask-ai-slice/` is an earlier dependency-free JS prototype: 1 module and 5 actions, with a rule-based planner standing in for the LLM. It already shows the descriptor shape (user-language descriptions, aliases, `sideEffect`, `requiresConfirmation`), slot-filling clarification, the confirmation gate, and evals that assert state. Reuse those ideas. This repo is the real TypeScript build.
