# Assignment — what's being asked

From the HighLevel email of 2026-10-19 (Prakhar Gupta, Recruiting). The original PDFs are in [assignment/](assignment/):
- `HighLevel Hiring Assignment Ask AI Framework.pdf`: the brief
- `ask-ai-50-modules-500-actions.pdf`: the module/action catalog (M01.A01 … M50.A10)

**Due:** within 5 days, so by 2026-10-24. **Questions:** reply on the thread; Nikhil (panel) is cc'd.

> Open question: the brief's numbering jumps from section 4 to section 6, so section 5 is missing. It's worth asking Nikhil whether anything was left out.

## In one line

A chat assistant that turns natural language into the right calls across a simulated CRM with **50 modules × 10 actions = 500 actions**, with measured latency, cost and quality.

## Request types it must handle

| Type | Example from the brief |
|---|---|
| Direct | "Create a contact named Sarah with this email address." |
| Indirect | "I keep forgetting to follow up with new leads. Help me stay on top of them." |
| Complex | "Find leads created last week who have not replied, exclude anyone with a booked appointment, assign the remaining leads to available sales reps, and create follow-up tasks." |
| Conditional | "For unpaid invoices overdue by more than 15 days, draft reminders, but skip customers who already received one this week." |
| Follow-up | "Only include leads from the Facebook campaign, and make those tasks due tomorrow." |

The example prompts must not be hardcoded.

## Requirements checklist

### Setup
- [ ] Backend: Node.js
- [ ] Frontend: Vue.js chat interface
- [ ] LLM provider and agent libraries of our choice
- [ ] 50 realistic modules, **exactly 10** meaningful actions each (the catalog PDF defines them)
- [ ] Executable handlers for all 500 actions: stateful, meaningful data, not always-success
- [ ] Synthetic data; no real HighLevel integration
- [ ] Extensible registration: adding capabilities doesn't require rewriting the core agent
- [ ] Confirm destructive, bulk and externally visible operations before execution (catalog PDF)

### Agent behavior
- [ ] Multi-turn conversations and follow-ups; keep context, selected entities, filters and task progress
- [ ] Show useful progress while a workflow runs
- [ ] Final answer grounded in actual execution results
- [ ] Searchable catalog of all 500 actions; each has name, description, input schema, output schema and handler
- [ ] Correct selection despite overlapping or similar actions across modules
- [ ] Resolve entities and validate required params before execution
- [ ] Handle typos and paraphrases, as well as explicit and indirect requests
- [ ] Break complex requests into steps across modules; respect dependencies, filters, exclusions and conditions
- [ ] Use prior results in later steps
- [ ] Ask a focused clarification only when essential info is missing; don't make the user repeat known info
- [ ] Recognize unsupported requests honestly; never invent capabilities or results
- [ ] Report completed, failed and pending steps clearly

### Latency, cost, quality (with measurements)
- [ ] **Latency:** p50/p95 *time to first useful response* and *end-to-end completion*, separately for direct vs complex (a loading indicator doesn't count)
- [ ] **Cost:** input/output tokens, model calls, estimated cost per request **and** per successful task, retries included; document the model, pricing assumptions, cache behavior and test conditions
- [ ] **Quality:** action selection, parameter accuracy, end-to-end task success, checked against actual output and **final data state**
- [ ] **Evaluation:** ≥ 100 reproducible scenarios spanning all 50 modules, covering direct, indirect, multi-step, follow-up, ambiguous, unsupported and failure cases, with expected outcomes and automated assertions
- [ ] Separate smoke test of all 500 handlers
- [ ] **Trade-offs:** simple baseline vs optimized approach on the same scenarios; explain speed/cost gains and quality impact
- [ ] State performance targets **before** the benchmark; report failures and missed targets

## Deliverables
1. **Code:** chat UI + backend; full 500-action catalog; handlers, synthetic data and a reproducible reset/seed; eval suite, execution traces and benchmark results; install/run steps including env vars.
2. **Demo video (2–5 min):** direct request; indirect request; complex workflow across ≥ 3 modules; a follow-up that changes the previous request; an ambiguity or tool failure handled; the benchmark results.
3. **README:** architecture and agent design; module catalog, action schemas and registration; tool selection, context management and execution strategy; real vs mocked; how to run evals and reproduce results; latency/cost/quality trade-offs; known limitations and scaling past 500 actions.

**Submit:** GitHub repo, demo video, README, and the eval dataset with a benchmark report.

## Evaluation criteria
- **Agent design:** understands intent, plans across modules, completes tasks
- **Quality and reliability:** correct actions and params; handles ambiguity, failures and follow-ups
- **Latency:** fast responses and workflows, backed by p50/p95
- **Cost efficiency:** model calls, token usage, cost per successful task
- **Product and UX quality:** useful progress, appropriate confirmations, clear outcomes
- **Completeness and code quality:** end-to-end, all 500 actions, reproducible evals, modular code

The email notes it's competitive: not every submission progresses, and feedback may be limited.
