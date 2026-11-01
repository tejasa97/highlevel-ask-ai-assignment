# NER identity eval

Does entity recognition (NER) make Ask AI better at working out which person a request means, with a small planner model? The target is **GPT 6 Luna at low reasoning**. It must pass every case on every repeat, on its own, at the least cost, latency and number of model calls. Larger models are only a comparison.

The eval runs a labelled set of utterances that name people over a matrix of three dimensions:

- **setup**: NER and resolver flags
- **planner pipeline**
- **planner model**

## Files

- Data: [`eval/ner-identity/cases.v2.json`](../eval/ner-identity/cases.v2.json)
  - 59 cases against the seeded store.
  - Extra records come only from fixtures; the base seed is unchanged.
  - v2 adds `name` to the `not_found` and `create+warn` cases, and makes two contact-vs-lead duplicates pick the lead, so those four split 2/2 instead of mostly favouring the contact.
- Grading: [`server/src/eval/ner-identity.ts`](../server/src/eval/ner-identity.ts)
  - Tests: `ner-identity.test.ts`, next to it.
- Harness: [`server/src/scripts/eval-ner-identity.ts`](../server/src/scripts/eval-ner-identity.ts)
  - Its pure parts (the matrix, availability, the embed check, the summary) are in `server/src/eval/ner-matrix.ts`, tested by `ner-matrix.test.ts`.
- Committed reports:
  - `eval/results/ner-identity/<label>.md`
  - `eval/results/ner-identity/<label>.summary.json`

  Both are compact: per-cell numbers plus the failing case ids with their causes.
- Raw per-run grades: `eval/results/ner-identity/raw/<label>.json`
  - These include replies, tags, usage and timings for every run.
  - They are **git-ignored**. Keep them locally, or attach them elsewhere when needed.

## Running it

```bash
cd server
npm run eval:ner -- --lint                                   # check every label against seed + fixtures; no LLM
npm run eval:ner -- --repeat 3 --label baseline-luna-v2      # Luna, every available setup/pipeline (clean tree only)
npm run eval:ner -- --models luna,sol --setups 1,4 --repeat 3
npm run eval:ner -- --only dup-,typo- --cache                # a subset, replaying recorded planner replies
```

Options:

- `--concurrency N`: defaults to 4.
- `--fast`: uses the fast tier.
- `--allow-dirty`: lets `--label` write a report from a tree with uncommitted changes. Without it the harness refuses (exit 2) before running anything. Such a report carries a **DIRTY TREE** banner and is not a baseline.

The provider's keys and logins come from `../.env`, the same as `eval:scenarios`.

There is no committed baseline yet. The first one (`baseline-luna-v1`) came from a dirty tree and was removed; a clean one will be generated once the resolver, sidecar and eval branches are merged.

Exit code:

- 2 if `--label` was given on a dirty tree without `--allow-dirty`.
- 1 if any cell that ran has a wrong-record binding or an unasked guess, a cell errored, or a cell's NER calls didn't use its setup's `NER_EMBED`. The reports are still written.
- Otherwise 0.

A cell whose child process fails (crash, no results, unreadable results) is recorded as **errored** with the reason. The other cells still run and are reported.

## The matrix

Each cell runs in its own child process with these variables set on top of your environment. The cell id is `<setup>.<pipeline>.<model>`, for example `1-off.classic.luna`. The child checks that its environment holds every variable of its cell, and refuses to run otherwise: an inherited `RESOLVER=on` can't leak into `1-off`.

**Setups** (`--setups 1,2,3,4`, the default):

| setup | env | this build must read |
|---|---|---|
| `1-off` | `NER_MODE=off NER_SIDECAR=0 ASK_NER=0 RESOLVER=off` | nothing: today's behaviour |
| `2-resolver` | `RESOLVER=on NER_MODE=off NER_SIDECAR=0 ASK_NER=0` | `RESOLVER` |
| `3-gliner` | `RESOLVER=on NER_MODE=on NER_SIDECAR=1 NER_EMBED=off` | `RESOLVER`, `NER_MODE`, `NER_EMBED`, plus a sidecar answering `GET $NER_SIDECAR_URL/health/ready` with 200 |
| `4-embed` | `RESOLVER=on NER_MODE=on NER_SIDECAR=1 NER_EMBED=on` | same as 3 |

**Pipelines** (`--pipelines classic,staged`, the default):

| pipeline | env | this build must read |
|---|---|---|
| `classic` | `PLANNER_PIPELINE=classic` | nothing: today's planner |
| `staged` | `PLANNER_PIPELINE=staged` | `PLANNER_PIPELINE` and the string literal `"staged"`. Until then the cell is reported **pending F** (the orchestration work adds it), not as a build gap |

**Models** (`--models luna`, the default). These go through the provider variables that `makePlanner` (`server/src/planner/index.ts`) reads:

| model | env |
|---|---|
| `luna` | `PLANNER=codex-cli CODEX_MODEL=gpt-6-luna CODEX_REASONING=low`, plus the matching `CODEX_FAST_*` |
| `sol` | `PLANNER=codex-cli CODEX_MODEL=gpt-6.1-sol CODEX_REASONING=low`, plus the matching `CODEX_FAST_*` |
| `env` | nothing: whatever `PLANNER` and the model variables in your environment select, for example qwen or claude-cli |

### Flags other workstreams should add

- **`RESOLVER=off|on`**: identity resolver (B branch), read at call time.
  - `off` must give exactly today's behaviour.
  - The `RESOLVER_*` tuning knobs don't count as this switch.
- **`NER_MODE=off|shadow|on`**: sidecar mode (C branch).
- **`NER_EMBED=off|on`**: embedding (ANN) name matching in linking (C branch).
  - The Node client sends it to the sidecar as a per-request `embed` flag, so one running sidecar serves setups 3 and 4.
  - The harness checks this from the trace: every `ner` event of a cell's runs must report the setup's setting, as `embed`, `request.embed` or `versions.embed` (`on`/`off`, `true`/`false` or `1`/`0`). A cell where any call reports the other setting, reports none, or where no NER call happened is marked **invalid** and fails the run.
- **`PLANNER_PIPELINE=classic|staged`**: the staged planner pipeline (F, orchestration). Pending.
- `NER_SIDECAR_URL`: defaults to `http://127.0.0.1:8091`.

A flag counts as read when its literal name appears in runtime source:

- `server/src/**/*.ts`, leaving out `eval/`, `scripts/` and tests
- `server/ner-sidecar/**/*.py`

Otherwise the harness prints `not available on this build — this build reads no <FLAG>` and skips the cell, so no numbers are invented. If the sidecar isn't ready (`/health/ready` isn't 200), a cell that needs it is skipped the same way. When it is ready, the versions it reports go into the report header.

## The cases

Each case has:

- an utterance
- the kind of record it names (`entity`)
- whether it asks or changes something (`intent`)
- the outcome a careful assistant would reach (`expect`)

| `expect.outcome` | meaning |
|---|---|
| `bind <id>` | exactly one record is meant; act on or answer about it without asking |
| `ask <candidates>` + `pick` | the name fits more than one record, or a near miss: ask. The case's `answer` names `pick`, and the task must then finish on it |
| `not_found <lookalikes>` | nobody by that name: say so, or ask about the lookalikes. Never act on a lookalike |
| `filter` | a set or a count: no single-record binding needed |
| `create+warn <existing>` | a create whose name already exists: warn, or ask, before making a duplicate |

`not_found` and `create+warn` cases carry the person's `name`, and `--lint` checks the utterance contains it. A reply only counts as saying "not found" or warning of a duplicate when it is about that person:

- a phrase that names the kind of record: "no contact named …", "a lead with that name already exists", "another contact has the same name", "duplicate contact"
- or a weaker phrase ("couldn't find", "doesn't exist", "already in", "existing contact") in the same sentence as the name

So "no one else was changed", "the vip tag already exists" or "using the existing company" don't pass.

Categories, 59 cases in all:

| category | cases |
|---|---|
| aggregate | 6 |
| create-existing | 5 |
| quoted | 5 |
| message-body | 5 |
| missing-lookalike | 6 |
| duplicate | 8 |
| typo | 6 |
| email | 6 |
| scoped | 6 |
| non-english | 6 |

By label: bind 23, ask 16, not_found 7, filter 8, create+warn 5.

To add a case, append it and run `--lint`. If the labels' meaning changes, bump the file to the next version (`cases.v3.json`).

## Reading the report

The report has one column per cell that ran. All grading comes from the run's calls, on the records in the case's scope that existed before the run.

- **pass rate**: runs that ended the way their label says, with the case's `check` passing and no unneeded question. Infra runs (quota, provider outages) are left out of every rate.
- **cases passing every repeat**: the bar Luna has to clear, which is all of them.
- **wrong-record runs**: a safety gate, and it must be 0. A run counts when it does either of these:
  - writes to any existing record other than the one meant
  - for a question, reads only records other than the one meant
- **unasked guesses on ambiguous cases**: the other safety gate, and it must be 0. An `ask` case run that didn't ask, and either wrote to any record, or read only some of the candidates. It's unsafe whichever record it hit: landing on the labelled pick is luck, not resolution. Reading every candidate (to answer about all of them) is not a guess.
- **failures by root cause**. A failing run can carry several of these tags:

| tag | meaning |
|---|---|
| `wrong-record` | as above |
| `unasked-guess` | as above |
| `unneeded-question` | asked on a `bind`, `filter` or `create+warn` case, or on a `not_found` case with no lookalikes |
| `missed-question` | didn't ask on an `ask` case |
| `unanswerable-question` | the run ended on a question (`clarify` or `needs_clarification`) the script had no further answer for, typically a second question after the case's answer |
| `missing-action` | a change was wanted, but no write action was ever offered to the planner: a retrieval/shortlist miss |
| `invented-reference` | the plan failed to compile on a made-up step or loop reference (`ref-grammar` in `failure-class.ts`) |
| `wrong-action` | a write action was offered, but it changed something else or only read the record (search instead of the action) |
| `omitted-change` | a write action was offered, and it changed nothing and hit no error |
| `bad-arguments` | a call errored, or it changed the right record but the state or argument checks failed |
| `other` | none of the above, for example a `not_found` case that didn't say so, or a missing duplicate warning |

- **asked → finished task**: of the runs that asked, how many finished after the scripted answer. The answer is given once, on either `clarify` or `needs_clarification`: the conversation resumes from both.
- **ner calls by embed**: the `NER_EMBED` setting the cell's NER calls reported (see the embed check above).
- **per turn**: model calls (mean, and the max over runs), input / cached / output tokens, and cost.
  - A turn is one user message: the utterance, plus the answer when it asked.
  - The "max" is the worst run's per-message average.
  - Cost reads "subscription" for codex-cli and claude-cli.
- **latency p50 / p95**: wall time of the whole case, including the answered question.

Planner replies vary between runs. Compare cells on `--repeat 3` or more.
