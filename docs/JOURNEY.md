# Journey

How Ask AI got where it is: each change, the problem it went after, why it was built that way, and what it did to
the numbers. `docs/trajectory.html` is built from this file and `eval/results/history.jsonl`
(`npm run trajectory`).

## How to read the numbers

- **Retrieval eval** (`npm run eval:retrieval`): no LLM. For each held-out question, is the action it needs in the
  shortlist the planner sees? R@15 is "the right action is in the top 15". The trajectory uses one question set,
  today's 105 held-out questions, and re-runs old commits on it, so the line is fair. Older saved results used a
  smaller 63-question split and are shown apart.
- **Scenario eval** (`npm run eval:scenarios -- --repeat 3`): real planner, fresh seeded database, end to end. A run
  passes when the status, the planned actions, their arguments, the database afterwards and the reply all check out.
  Runs the planner couldn't serve (quota, timeout, provider down) are **infra**: counted apart, never in the pass rate.
- Every recorded run is one line in `eval/results/history.jsonl`, with the commit, whether there were uncommitted
  edits, and a fingerprint of the question set. Runs are comparable only when the fingerprint matches.
  A run of a change that was later reverted is marked `reverted`: it stays in the table, off the charts.

## How to add an entry

1. Before the change, run the eval it should move, with a label (`--label before-x`).
2. Make the change. Run the same eval again (`--label x`); scenarios 3x.
3. Add an entry below in the same commit: a `## N. Title` heading, a meta line with the commit, the date and
   `runs: before-label → after-label`, then Problem, Change, Why this way, Result, Cost, Side effects.
4. `npm run trajectory`.

## 0. Design before code
`a6710e8` · 2026-10-20

**Problem.** HighLevel's catalog has about 500 actions across 50 modules. A model can't be shown all of them on every
message, and a free-running tool loop is hard to make safe for bulk and destructive changes.

**Change.** Wrote the plan first: the planner returns a whole plan of steps as one structured reply; code
checks it and runs it. Retrieval picks a shortlist of action cards for each message. Approval is decided by code from
the risk of the exact records touched, never by the model.

**Why this way.** A plan can be validated before anything runs, shown to the user, and approved once. Forced
tool calls return 400 on the current Claude models, so the reply is structured output instead.

## 1. Thin slice: registry, two-stage executor, planner
`bed8db9` · 2026-10-21

**Problem.** Nothing ran end to end yet.

**Change.** SQLite store with a deterministic seed and a frozen clock; a registry of actions checked against the
catalog; an executor in two stages: compile (every `$ref` and argument checked against schemas, errors worded for a
repair call) then run (destructive, external and bulk writes wait for approval, keyed on a hash of the exact targets).
Replies are templated from what ran, not written by the model.

**Why this way.** Everything after the planner is deterministic, so it can be unit tested, and the model can't
claim something happened that didn't.

## 2. Five modules in depth, and a debug UI
`f1034d7` · 2026-10-21

**Change.** Contacts, leads, tasks, users and teams: ten hand-written actions each with permissions, state guards,
edge-case tests and injectable faults. A web UI streams every turn: planner request and reply, the compiled plan,
each call, and the rows that changed.

**Why this way.** Depth before breadth: a few modules that behave like the real product give honest evals; the
debug view made every later failure quick to diagnose.

## 3. BM25 retrieval over generated action cards
`d3d9942` · 2026-10-21 · runs: names-only-test → final-test

**Problem.** The planner needs the right handful of actions out of 500, quickly and without an LLM call.

**Change.** Each catalog action got a card (name, synonyms, description, LLM-written and checked by tests), ranked with
BM25. Long messages are split into clauses so each one gets its own candidates. `planTurn` allows one
`search_tools` round (the planner asks for what's missing) and one repair round (compile errors fed back).

**Result.** On the 63-question split of the day, the cards took R@15 from 70.6% (names only) to 93.1%. Re-run later on
today's harder 105 questions, this commit scores 82.1%: the first split flattered BM25, which is why the
paraphrase questions were added.

## 4. Linking names in the message to records
`557f570` · 2026-10-21 · runs: rerun-d3d9942 → rerun-557f570

**Problem.** "Assign Hiro Reyes to Raj" says nothing about which record types are involved, so the lookups the plan
needs weren't shortlisted, and the planner guessed whether Hiro was a contact or a lead.

**Change.** Capitalized names are matched against contacts, leads, users and teams. A match adds that type's
get and search actions to the shortlist, and a `<mentions>` line tells the planner "Hiro Reyes: lead".

**Result.** Lookup questions: R@15 40% → 100%. All questions, re-measured: 82.1% → 85.9%. Turning it off today costs
3.8 points (94.9% → 91.1%).

## 5. Planner deadline and server tests
`905733e` · 2026-10-21

**Problem.** A planner call that never returned left the turn hanging.

**Change.** Each planner call gets 120 s, then the child process is stopped and the turn ends with a plain failed
reply. 14 HTTP tests over a scripted planner.

## 6. Hybrid retrieval: BM25 + local embeddings, ten more modules
`911b204` · 2026-10-22 · runs: rerun-557f570 → rerun-911b204

**Problem.** BM25 misses paraphrases: "who hasn't heard back from us" shares no words with "list conversations
waiting on a reply".

**Change.** A small local embedding model (bge-base, quantized) ranks cards by meaning; its ranking joins BM25 by
reciprocal-rank fusion. If the model can't load, retrieval falls back to BM25 and says so. 80 paraphrase questions
added to the held-out set. Ten more modules built in depth (opportunities, notes, tags, conversations, SMS, email,
campaigns, appointments, invoices, payments).

**Why this way.** Local and free per query, so there's no extra API call or key. Out-of-scope rejection by
retrieval is unchanged (2 of 8 in both modes); the planner turns down the rest, and both unsupported scenarios pass
every run.

**Result.** R@15 85.9% → 94.9%, R@5 76.0% → 89.0%, MRR 0.58 → 0.66. Today's code with embeddings off: 87.1%, so most of the gain is the embeddings.

**Cost.** About 12 ms per question to embed it; ranking itself stays under 0.5 ms. Timed the same way, a
retrieval eval question takes 13.3 ms hybrid against 1.5 ms BM25 alone.

## 7. End-to-end scenario eval
`5359c12` · 2026-10-22 · runs: pilot-1 → pilot-3x

**Problem.** Retrieval recall says the right tool was offered, not that the user got the right result.

**Change.** 23 scenarios in 7 groups (direct, indirect, multi-step, ambiguous, follow-up, failure, unsupported),
each from a fresh seeded database. Checks: final status, actions planned and not planned, their arguments, SQL
on the database afterwards, words in the reply, and "nothing changed". The chat logic moved into a `Conversation`
class that the web app and the eval both drive, so the eval tests the real path.

**Result.** Pilot: 87% of 69 runs pass; 20/23 scenarios pass every run; median 5.7 s; $0.012 a run. Three
scenarios failed every time, each a different failure class (below).

## 8. Deactivated users are reported, not silently skipped
`5359c12` · 2026-10-22 · runs: pilot-3x → fix-3x

**Problem.** "Assign this to Dan Ortiz" when Dan is deactivated: the resolver ignored him, so the plan failed with
"no user named Dan Ortiz", which is wrong and unhelpful.

**Change.** Resolvers return usable matches first; when there are none, they return the inactive ones with their
status. The executor then fails the step with "Dan Ortiz is deactivated" and skips what depends on it. The same rule
covers inactive contacts, closed opportunities and tasks, appointments no longer booked and inactive teams.

**Why this way.** One rule in the resolver helper fixes the whole class, not one prompt case.

**Result.** failure-deactivated-assignee 0/3 → 3/3.

## 9. Lists named by their person, and a wrong expectation fixed
`5359c12` · 2026-10-22 · runs: fix-3x → fix2-3x

**Problem.** "Who is waiting on a reply?" listed conversations as "?, ?, ?": the summary looked only for a `name`
or `title` field, and conversations carry `personName`. The scenario also expected Sarah Johnson first; she is 11th of 11.

**Change.** The summary names a record by `name`, then `title`, then the first non-empty `…Name` field. The scenario
now expects 11 conversations led by Tara Silva.

**Result.** who-is-waiting 0/3 → 2/3. The question set changed here (new fingerprint), so fix2-3x isn't directly
comparable with the pilot.

## 10. A "look" before planning, for values worked out from a record
`5359c12` · 2026-10-22 · runs: fix-3x → fix2-3x

**Problem.** "Move Sarah's walkthrough to Monday, same time": the time comes from the appointment as it is now,
which the planner can't see, and a `$ref` can't change a date. The planner asked a question instead. The appointment
also wasn't found by "Sarah Johnson Agency plan walkthrough".

**Change.** A new planner reply, `look`: read-only steps run at once, as the same user, and their results come back in
`<looked>` for one more planning round. At most one look a turn; any write in it is rejected and repaired.
Appointments are now named "title with person".

**Why this way.** The planner computes the new time from real data, and code still checks and approves the
plan. Reads only, so a look can never change anything without approval.

**Result.** direct-appointment-reschedule 0/3 → 3/3.

**Cost.** Turns that look make one more planner call (about 5 s and $0.01).

**Side effects.** In 2 of 64 turns the planner looked and then answered in its own words (raw ids included) instead
of planning. Fixed by a prompt rule ("to show records, plan the reads") and a guard: an answer after a look runs
the look as the plan, so the reply is the usual summary. Measured in entry 12: the prompt rule did harm and was
removed.

## 11. Infrastructure failures counted apart
`5359c12` · 2026-10-22 · runs: fix2-3x

**Problem.** fix2-3x reported 73.9%, which looked like a regression. 14 of its 69 runs had hit the Claude CLI session
limit and never reached the app.

**Change.** A planner failure from quota, timeout or the provider is marked infra on the turn and the run. Pass rates
leave those runs out, the report says "NOT A CLEAN RUN", and hitting the quota stops the eval. Every labelled run of
either eval is appended to `eval/results/history.jsonl`; a run where nothing reached the app isn't.

**Result.** fix2-3x read correctly: 92.7% of 55 clean runs, 15/19 measured scenarios pass every run; 4 scenarios
unmeasured.

## 12. The look guard measured; a person's name alone no longer names their meeting
`af25b82` · 2026-10-22 · runs: look-guard-3x → resolver-fix-3x

**Problem.** The first full run with the look guard (look-guard-3x) fell to 91.3%, with two scenarios failing every
run. direct-appointment-reschedule: the planner returned a plain plan of reads instead of a look, so nothing moved.
ambiguous-two-sarahs: name linking ran the appointment resolver over "Sarah Johnson", matched "Agency plan
walkthrough with Sarah Johnson" (the naming from entry 10), and `<mentions>` called her an appointment; the planner
resolved the meeting, texted its contact and never asked which Sarah. It had started failing in fix2-3x (2/3).

**Change.** A meeting still matches by who it's with, but some word of the name must be of its title: "Sarah Johnson
Agency" finds her walkthrough, "Sarah Johnson" alone finds no meeting. Removed the prompt rule from entry 10 ("to
show records, plan the reads"); the code guard covers the case it was written for.

**Why this way.** The resolver rule fixes the class (any person with a meeting, for any message that names them),
not this scenario. The prompt rule was a patch for 2 of 64 turns and pushed the planner away from look.

**Result.** 91.3% → 97.1% of 69 clean runs, no infra failures; 21/23 → 22/23 scenarios pass every run.
ambiguous-two-sarahs 0/3 → 3/3. direct-appointment-reschedule 0/3 → 1/3: in the two failures the planner still
sent a plan of reads (a lone resolve, so the reply was empty) instead of a look. That's the open problem.

**Cost.** None at run time. Cost per run is about $0.02 against fix2-3x's $0.012, with or without these changes:
the token counts show fewer prompt-cache hits, not a bigger prompt.

## 13. Tried and reverted: a plan that only finds records, taken as a look
`4726980` · 2026-10-22 · runs: resolver-fix-3x → no-action-look-3x

**Problem.** direct-appointment-reschedule still failed 2 of 3: the planner sent "find Sarah's walkthrough" as the
plan, with no action after it, so nothing moved and the reply was empty.

**Change.** A plan that only resolves names, running no action, was run as a look instead, and the planner asked
to plan again with the results.

**Result.** Worse: 97.1% → 92.8%, 22/23 → 19/23 scenarios pass every run, and the reschedule stayed at 1/3. A
resolve gives back only the record's id, not its time; turned into a look it used up the turn's one look, so the
planner couldn't read the meeting and asked the user its time instead. Three other scenarios each failed once on a
turn that went through a look. Reverted; the run is kept in the history, marked `reverted`.

**What it says.** The fix belongs where the planner gets what it needs from one look, not in reinterpreting its
replies. Entry 14 goes further: the planner needn't read the time at all.

## 14. Reschedule to a day, keeping the time; a plan that calls no action is repaired
`d8d4692` · 2026-10-22 · runs: resolver-fix-3x → reschedule-date-3x

**Problem.** "Push Sarah Johnson's Agency plan walkthrough to Monday, same time" still passed 1 of 3. To fill
reschedule's `startAt` the planner needed the meeting's current time, which a resolve doesn't give; so it had to
look, then work out Monday 11:00 New York in UTC itself, across a daylight-saving date. When it skipped the look it
sent a plan that only found the meeting: it ran, ended "done", and the user saw an empty reply.

**Change.** Reschedule takes `date` as well as `startAt`: the meeting moves to that day at the same time of day in
the business timezone, worked out in code (it holds across the change to standard time). Separately, a plan whose
steps call no action is sent back for one repair round, like any invalid plan, and fails with a message if it's
still empty; it can no longer end "done" with nothing said.

**Why this way.** Requests name the part of the time that changes ("to Thursday", "same time next week"); the
action takes that part, and the date and timezone arithmetic moves from the model to code that's tested. The repair
is the general rule entry 13 lacked: it tells the planner what's wrong instead of reinterpreting its reply.

**Result.** 97.1% → 100% of 69 clean runs, no infra failures; 22/23 → 23/23 scenarios pass every run, none flaky.
direct-appointment-reschedule 1/3 → 3/3. Planner rounds per run 1.30 → 1.28.

**Cost.** Cost per run $0.020 → $0.0125, from more prompt-cache hits rather than this change. Latency went the other
way: end-to-end p50 5.8 s → 7.3 s, p95 11.1 s → 15.9 s, with fewer planner rounds; the reverted run (entry 13) sat
in between. It looks like `claude -p` timing from run to run, not the change, but one run can't show that.

## 15. Thirty reviews/listings/ticket actions; isolated eval sets and guarded reporting
`c5df916` · 2026-10-22 · runs: m45-m47-after

**Problem.** Three more catalog modules needed full integration, not thirty unconditional-success handlers. Closely related messaging/note/ownership/publication actions can be confused; new seed data and interleaved scenario sets could also make regression numbers misleading.

**Change.** A separate branch from main `3d4588d` froze seed IDs, 45 development scenarios and 12 separate reporting scenarios at `080618f`, before handlers. Added all ten actions per module with strict inputs, persistent state, permissions, reusable delivery, resolver identity rules, first-response SLA and normal confirmation/audit/replay. Generic email preview/send/schedule refuse module-owned kinds so request status and ticket SLA cannot be bypassed. Added folder selection and per-folder trajectory lines, leaving the old suite as the headline. README and the module-building guide document the conventions and simulator limitations.

**Verification.** 769 deterministic tests pass without skips, including real local embeddings, all-180 smoke checks, actual SQLite close/reopen, role/consent matrices, DST/SLA boundaries, HTTP/SSE and cross-module execution. A scripted browser run verified ticket reply approval, task creation and row changes; it is not an AI result. Browser inspection exposed an inherited conversation bug: spreading an email/SMS reference copied its ID and private fields into a new conversation. Whitelisting contact/lead IDs fixes it; new tests require clean cv_ records.

**Retrieval.** On the unchanged test split, hybrid recall@15 moves 94.9% → 95.6%, mean shortlist 19.5 → 19.4. No in-scope false rejects; the two off-topic cases still need planner rejection. The module-development ablation has 97.56% explicitly required-action availability and 44/45 cases with every required action retrieved across their turns, mean/max shortlist 17.83/25 and 9,573 prompt characters. Six extra symmetric sibling links together give no recall gain, but raise mean/max to 18.11/26 and 9,806 characters; none were adopted. Initial retrieval still misses Create support ticket in the invoice/conversation chain. Tool-search plumbing is tested; real planner recovery is not yet measured.

**Data caveat.** Original 23 scenario definitions and fingerprint fcc7ddef4615 are unchanged, but the starting seed is expanded by four contacts, two appointments, three review requests, two reviews, three listings and four tickets. Every legacy row hash is preserved. Equal scenario fingerprints therefore do not mean identical seeded data. Freeze hashes and implementation commits are recorded in M45-M47-VERIFICATION.md; retrieval's after measurement records the dirty implementation tree that was subsequently committed.

**AI evaluation pending.** Before implementation, m45-m47-before passed 69/69 original-suite runs, no flaky or infrastructure cases, p50 5.438s/p95 13.100s. The first new development evaluation then hit session quota: four infrastructure failures, 41 cases unstarted, zero clean runs. It is saved separately and correctly not recorded as an application score. Development 45×3, regression 23×3 and reporting 12×3 remain required; no after-regression or reporting success is claimed. Reporting outcomes remain unrun. The separated trajectory still needs visual browser verification.

**Cost.** The before regression recorded $1.47 total, $0.0213/run using the existing CLI estimates. Offline deterministic/retrieval checks add no planner calls. Quota failures establish no task cost or success rate; provider accounting and cost-per-success methodology were not changed in this batch.

## 16. Codex integration; implementation verified, AI acceptance remains unmet
`9295670` · 2026-10-22 · runs: codex-luna-module-development-3x

**Change.** At the user's request, stopped Claude and ported the merged Codex provider into this separate worktree, retaining per-folder trajectory grouping. Explicit model/reasoning cohorts prevent future Luna/Sol curves from mixing. Subscription dollar cost is unknown, not zero. No API fallback, push or main-branch edits.

**Verification.** 795 deterministic tests pass, no skips/failures; typecheck and production web build pass. This includes fixes for prior-approval retention and clean conversation records, real SQLite persistence, all-180 smoke checks, HTTP/SSE and the thirty module contracts. Actual and synthetic three-folder trajectory browser checks passed; the synthetic screenshot is labelled a fixture, not measured evidence.

**Results.** Luna low reasoning: development 115/135 (85.2%, 34/45 cases pass every repeat), original regression 39/69 (56.5%, 10/23), frozen reporting 26/36 (72.2%, 7/12). No infrastructure failures. A selected Sol low-reasoning diagnostic passed 4/5, not a full-suite estimate: it still invented loop/list references for appointment→review planning. Initial action retrieval can omit Create support ticket; Luna did not reliably request missing tools. Other failures are unnecessary clarification, omitted mutations and choosing search instead of an offered SLA action. Acceptance targets are not met.

**Comparison and data.** Before switching providers, corrected development v2 passed 135/135 on Claude; original regression went 69/69 → 68/69, with the lost assignment repeat investigated. The later Luna regression is not a same-model before/after comparison. Development v2 fixes a test expectation and preserves archived v1/results; seed and reporting hashes are unchanged. The old scenario fingerprint still excludes the expanded seed, as entry 15 explains. Reporting is now exposed; no implementation tuning followed its results.

**Conditions.** Three repeats; concurrency four for Luna development/regression, two for reporting. Reporting overlapped regression; the Sol diagnostic overlapped development. Latencies are descriptive rather than controlled comparisons. Full result files, reproduction commands and unresolved shared-planner work are in M45-M47-FINAL-REPORT.md. Earlier entry 15 is a historical checkpoint, not the current evaluation status.

## 17. Full GPT-6.1 Sol evaluation, with no implementation changes
`28268dc` · 2026-10-22 · runs: codex-sol-module-regression-3x

**Question.** Does Sol recover quality lost when switching from Claude to Luna?

**Measurement.** All 80 cases ×3, low reasoning, identical prompts/cards/code/seed/expectations. Original regression 63/69 (91.3%, Luna 56.5%); development 124/135 (91.9%, Luna 85.2%); reporting 30/36 (83.3%, Luna 72.2%). Respectively 21/23, 40/45 and 9/12 cases pass every repeat; zero infrastructure failures. Direct module cases pass 88/90, below the 100% target; development remains below 95%. All evidence is saved in the three scenarios-codex-sol-module-*-3x.json files.

**Findings.** Sol is stronger overall, not uniformly better. Two consistent original-suite failures and five reporting listing failures use descriptive/company/possessive strings that the resolvers cannot match. Appointment→reviews still produces invalid loop/post-look references. Bulk partial replies clarify instead of completing the valid item. Missing-address development failures stop at compiler errors, so they do not prove an address-check bypass. SLA, reopening, invoice/conversation→tickets and reply+task improve. No handler, prompt, retrieval or default-model edits were made during this comparison.

**Conditions and limits.** Suites ran sequentially, concurrency four for regression/development and two for reporting, matching Luna's per-suite settings but not its overlap. This is not controlled latency attribution. Reporting was already exposed, so this is model comparison on a fixed set, not fresh holdout evidence. Shared account usage was 72% before and 83% after (account-wide, not isolated billing); USD remains unknown. The report records per-case regressions and next diagnostic areas. AI acceptance is still unmet.

## 18. A baseline: one call per step, against a whole plan per call
`b10bd51` · 2026-10-22 · runs: baseline-3x → planner-3x

**Problem.** The planner writes the whole plan in one model call. Nothing showed that this beats the usual design,
an agent that calls one tool per model call and reads each result before picking the next.

**Change.** A baseline agent (`server/src/server/baseline.ts`) built that usual way: each model call picks one action
or name lookup, sees its result, and picks the next, up to 15 calls. It gets the same shortlist of actions, name
matches, context and approval rules as the planner, and goes through the same compile checks and executor; only
the planning differs. `npm run eval:scenarios -- --agent baseline` runs it, and `npm run report -- --compare`
puts the two side by side in BENCHMARK.md. Both ran the same 23 scenarios × 3 in the same hour, on the same code.

**Result.** Quality is about even: planner 97.1% (67/69), baseline 95.7% (66/69). The planner failed two runs once
each (it picked the invoice reminder instead of a payment request; one ambiguous-name follow-up failed). The
baseline's three failures are one scenario, and mostly the check's fault: its answer was right, but it quoted
customers' questions, and the check rejects any "?" as the agent asking one. It also showed raw user ids
("Owner is us_2"), which no check catches. The check is left as it is; changing it after seeing results would
fit the test to them.

**Cost.** This is where the designs differ. Median model calls per complex task 2 vs 5. Direct first reply p50
5.3 s vs 15.5 s; complex end-to-end p50 10.6 s vs 32.5 s, p95 24.8 s vs 47.5 s. Cost per successful task
$0.011 vs $0.070, 6.4× more for the baseline, since every step resends the prompt.

**What it says.** On these tasks a capable model picks the right actions either way; planning the whole task in
one call is what makes it fast and cheap. The gap grows with the number of records a task touches: the baseline
makes one model call per record, where the planner writes one forEach.
