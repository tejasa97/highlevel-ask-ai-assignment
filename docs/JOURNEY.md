# Journey

How Ask AI got where it is: each change, the problem it went after, why it was built that way, and what it did to
the numbers. `docs/trajectory.html` is built from this file and `eval/results/history.jsonl`
(`npm run trajectory`).

Some entries name build-time reports (the M45–M47 and Wave 1 reports, the planner validation reports) that were removed
before submission. They are in git history: `git show 0b24cca:docs/M45-M47-FINAL-REPORT.md`, for example.

## How to read the numbers

- **Retrieval eval** (`npm run eval:retrieval`): no LLM. For each held-out question, is the action it needs in the
  shortlist the planner sees? R@15 is "the right action is in the top 15". Entries 3 to 21 compare on one question
  set, the 105 held-out questions of 22 Oct, with old commits re-run on it so the line is fair; older saved results
  used a smaller 63-question split. The test split has since grown to 150 questions (BENCHMARK.md, `26e7a36`), and
  the trajectory's retrieval chart draws only runs on the newest set, so the 105-question re-runs are in the table.
- **Scenario eval** (`npm run eval:scenarios -- --repeat 3`): real planner, fresh seeded database, end to end. A run
  passes when the status, the planned actions, their arguments, the database afterwards and the reply all check out.
  Runs the planner couldn't serve (quota, timeout, provider down) are **infra**: counted apart, never in the pass rate.
  The trajectory's headline tiles follow the widest 3x suite that includes `eval/scenarios`: since entry 33, the
  273-scenario release benchmark, not the original 23.
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
the harder 105-question split of 22 Oct, this commit scores 82.1%: the first split flattered BM25, which is why the
paraphrase questions were added.

## 4. Linking names in the message to records
`557f570` · 2026-10-21 · runs: rerun-d3d9942 → rerun-557f570

**Problem.** "Assign Hiro Reyes to Raj" says nothing about which record types are involved, so the lookups the plan
needs weren't shortlisted, and the planner guessed whether Hiro was a contact or a lead.

**Change.** Capitalized names are matched against contacts, leads, users and teams. A match adds that type's
get and search actions to the shortlist, and a `<mentions>` line tells the planner "Hiro Reyes: lead".

**Result.** Lookup questions: R@15 40% → 100%. All questions, re-measured: 82.1% → 85.9%. Turning it off at `911b204`
(22 Oct, 105 questions) cost 3.8 points (94.9% → 91.1%).

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

**Result.** R@15 85.9% → 94.9%, R@5 76.0% → 89.0%, MRR 0.58 → 0.66. The same code with embeddings off (`911b204`, 22 Oct): 87.1%, so most of the gain is the embeddings.

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

## 19. Ask before proceeding with the eligible ticket-reply subset
`739d986` · 2026-10-22 · runs: codex-sol-partial-confirmation-v1-3x

**Policy.** The user chose explicit consent to partial completion: explain which ticket cannot receive a reply and why, then ask whether to send only the eligible replies. Do not silently drop blocked targets or ask an unbound model-generated question in place of approval.

**Change.** Added side-effect-free ticket-reply preflight and reused the existing confirmation route. Single-call forEach and consecutive independent checked sends show eligible recipients plus blocked reasons. Approval hashes include eligibility and recipients; changes require renewed consent. Cancel sends nothing. Approved eligible items send once; blocked items remain failed and the final result is partial. All-blocked requests fail without an empty gate. Dependent/multi-call write transactions retain existing semantics; no speculative dry-run executes handlers.

**Verification.** Integrated GitHub main d63f198, retaining its baseline/report implementation and historical evidence. 814 backend tests pass, typecheck and web build pass. Sol low-reasoning passes both new policy cases ×3 (6/6), no infrastructure failures. Confirmation-content assertions ensure success requires the actual bound subset preview. A scripted browser check verified zero writes before approval, the blocked email-address reason, the eligible recipient and one send after approval. This targeted result does not replace full-suite acceptance. Frozen seed/development/reporting files and old results remain untouched. Details: PARTIAL-CONFIRMATION.md.

## 20. Wave 1: the other 32 modules, all 500 actions
`0c3fbe2` · 2026-10-23

**Problem.** Only 18 of the 50 modules had handlers; a request that landed on one of the other 32 got a "not available" answer. The submission is a 500-action framework, so the catalog needed to run end to end.

**Change.** All 32 remaining modules were built in seven groups (A to G) on parallel branches and merged into `wave1/modules`: registry actions with permissions, state guards and tests per action, no stubs. One registry check confirms 50 modules and 500 actions, M01 to M50 with no gaps. A second copy of group A on `wave1/group-a` conflicts with the merged one and was deliberately not merged. Details: WAVE1-REPORT.md.

**Verification.** 1941 deterministic tests pass; typecheck is clean.

**Side effects.** Every catalog action now executes, so the retrieval pool the planner draws from is all 500 real actions, not 180. Entry 21 measures what that did.

## 21. Hardening Wave 1, and what it did to the numbers
`5bbc440` · 2026-10-23 · runs: wave1-hardening-test → wave1-hardening-dev → wave1-hardening-haiku

**Problem.** A review of the 32 new modules found thin tests (one test per module doing five jobs), look-alike actions the planner could confuse, and some real defects behind green tests.

**Change.** Fixed what the review found, and nothing for the sake of a number:
- M33: a cash refund was recorded as failed while the call reported success. It is now refused with a conflict at request, approve and execute, and nothing is written.
- M22 and the shared clock: a local time inside a daylight-saving change could land an hour off. One conversion (`zonedInstant`) now lives in `store/clock.ts` and M22 and `atLocal` both use it.
- M32: cancelling an order now releases the coupon redemption it held.
- Permissions: publishing a workflow (M16.A08) and the publish and unpublish actions of M35 to M38 need `messaging.send`. Where every role already held the only fitting permission, no check was added. The reasoning is in WAVE1-ASSUMPTIONS.md.
- Siblings: look-alike pairs are declared mutual when the cards are built, so retrieving either action brings the other.
- Tests: the 32 modules went from 343 to 602 tests by splitting multi-action tests one per action; no assertion was removed. Chain tests run one action's output into the next across modules, a SQLite close-and-reopen test checks state survives, and a mutation spot-check of 11 guards found two untested ones, which now have tests.

**Why this way.** Each defect was fixed in the one place the class lives (a shared helper, one clock function, one sibling rule), not per scenario. The cards were not regenerated, because no retrieval miss touched an action whose text or siblings changed.

**Result.** 2215 deterministic tests pass. Retrieval on the unchanged test split (now 107 questions): R@15 95.6% → 96.0%, all@15 94.3% → 94.3%, MRR 0.65, mean shortlist 19.4 → 21.4; the dev split is R@15 97.0%. No in-scope question is wrongly rejected. Scenarios (23 × 3, haiku, as the 98.6% baseline): 94.2% both before and after hardening, with the same two scenarios failing, so hardening changed nothing there. The fall from 98.6% was already in `wave1/modules`. `unsupported-card-refund` fails 0 of 3 because its premise ("no refund action") stopped being true; the planner now correctly plans M29.A06 then M33.A01, and the scenario should change, not the code (it was then replaced by `direct-card-refund-request`; the next 23 × 3 haiku run scored 97.1%, with the failures moving between scenarios from run to run). `multi-bulk-archive-declined` is 2 of 3: the planner is offered about 22 actions now instead of 11 and in the failing run reads companies instead of archiving. Not patched.

**Cost.** About $3.7 for the 3x haiku scenario run; retrieval evals use no model. The pre-hardening comparison (`0c3fbe2`) was measured in a scratch checkout and is not in the history file.

**Open.** The scenario above and the wider candidate pool are the next measured work; WAVE1-HARDENING-REPORT.md has the full list, including the places this work stopped (no quote email kind, no `CommunityMember.membershipId`, no dedicated site permission).

## 22. Measuring the other 32 modules, and the final benchmark
`503e8ac` · 2026-10-23 · runs: wave1-modules-haiku-dev → wave1-modules-haiku-fix1 → wave1-modules-haiku-fix2 → final-planner-3x → final-planner-3x-fix → haiku-final-planner-3x

**Problem.** The 32 Wave 1 modules had tests and retrieval coverage but no planner scenarios, so nobody knew whether a real request reached the right action.

**Change.** Wrote 25 scenarios across commerce, learning, support and web (`eval/module-scenarios/wave1`, including cross-module chains), plus 112 retrieval questions held out from the card synonyms, then fixed the failure classes the runs showed, not the individual scenarios:
- A read-only loop nothing else used produced an empty reply; it now shows what each item looked up.
- Child records (M24 registrations, M44 memberships) could be addressed only by id; they now take parent + contact too, and the parent's get action lists its children so "who is registered" is answerable.
- M41.A01 needed a section id on a course with none; it now makes a default section.
- Retrieval: "Archive every contact at Wayne" named no record, and contacts resolve by name, so no search was offered and the planner improvised with a saved smart list (a write nobody asked for). A request that says every, all or each now brings in the search for the type being acted on.

**Result.** Wave 1 scenarios (Haiku, 3 repeats): 66.7% → 92% → 96% of clean runs, 24 of 25 passing every run. Retrieval after the bulk rule (357 questions, 6 added for it): R@15 97.2% → 97.5%, all@15 95.8% → 96.6%, test split 97.0% → 97.4%, mean shortlist 20.7 → 20.9. Final 23 × 3 benchmark of that day, on Haiku 5.5 (`BENCHMARK.md` as of `93c28a1`; entry 33 replaced it): the whole-plan planner passed 98.6% (68/69) of runs against 91.3% (63/69) for the one-call-per-step baseline, with action selection at 100% against 93.8% and 2 model calls per complex task against 4. A Sonnet 5.5 run of the same planner earlier the same day went 95.7% → 98.6% (`multi-bulk-archive-declined` 0/3 → 3/3). Tests 2215 → 2222.

**Targets.** Committed 2026-10-23 before the final run: 4 of 8 met on Haiku (5 of 8 on the Sonnet run). The four misses are latency: direct first reply p50 8.1 s against 1.5 s and p95 23.9 s against 3 s, complex end-to-end p50 12.1 s against 6 s and p95 16.2 s against 12 s. They were written for a direct API call; the only planner at the time was `claude -p`, which starts a process per call (about 1.5 s of each). Not relaxed. Entry 26 added a direct HTTPS provider; entry 33 measures the targets on it.

**Still failing.** `w1-subscription-change-plan` is 0/3 on Haiku: "Move X from Starter to Pro" reads as an opportunity stage change. `direct-payment-request` is 2/3: in one run the planner found the invoice and stopped before creating the request. Neither was patched.

**Caveat.** Both benchmark columns ran on Haiku 5.5 on 23 Oct, after the Claude usage limit stopped an earlier baseline rerun on Sonnet (its record, `final-baseline-3x`, is not a clean run and the report ignores it). The Sonnet planner run was compared against the 22 Oct Sonnet baseline, not a rerun. The Wave 1 scenario set is a separate set (Haiku, 3 repeats) and is not part of the 23-scenario benchmark. The Haiku planner's one failure was `ambiguous-zoe-then-answer` (assigned the contact to the wrong user after the clarifying answer), 2/3.
## 23. Shared record lookup, and a regression gate not yet passed
`26e7a36` · 2026-10-23 · runs: shared-lookups-luna-coverage-20261023-1x → shared-lookups-final-luna-regression-20261023-1x → shared-lookups-final-hybrid-test-20261023

**Change.** Expanded module-owned named lookup to 39 types, added exact qualifiers and inline named-ID arguments lowered into the existing executor, separated discovery from creation in retrieval, and carried bounded typed identities across turns. This is shared across providers, not a Luna-specific adapter. Source/scenario base is `64c9e45`; seed data and scenario expectations are unchanged. Generated lookup references are retained across read/replan rounds, and redundant discovery helpers were trimmed to preserve the existing shortlist-size gate.

**Verification.** Typecheck, web build and 2,298 deterministic tests pass, including the real embedding model. Initial checkpoint `ffdfadd` improved the unchanged 75-case development suite from the historical Luna 37/75 to 69/75, with zero infrastructure failures. This is not the final-source score: the complete 75 was not rerun after hardening. The final-source legacy run was 14/23, below its historical 18/23; it remains a failed merge gate. The initial subset-confirmation run passed 2/2. Final retrieval test R@15 is 97.4%, all-needed 96.7%, mean final shortlist 22.3 on that split. Individual cases and an old-prompt ablation are diagnostics only, not substituted successes or holdout results. See PLANNER-RECORD-LOOKUPS-VALIDATION.md for all checkpoints, regressions and limitations. Not pushed or merged.

## 24. Ground final outcomes, identities and delivery capabilities
`abe136b` · 2026-10-24 · source checkpoints: `d73b973` → `f97aae9` → `10ee277` → `abe136b`

**Change.** Implemented the seven older-suite improvements across all providers: typed identity checks before questions, stable declared final-action coverage across read/search rounds, richer module retrieval metadata and optional dependencies, precomputed weekdays, account-local reminder eligibility, ordinary message composition without invented facts, and explicit delivery surfaces checked before content questions. Corrected the round-robin field example. Quality guards preserve existing permissions/confirmation and distinguish bookkeeping-only queries (report execution and trigger testing) from real domain changes. Seed data, retrieval questions, scenario assertions and reporting freezes are unchanged.

**Verification.** Final source passes typecheck, web build and 2,323 deterministic tests. Final combined retrieval is 97.6% R@15, 96.9% all-needed, 21.8 mean cards and zero false rejection of in-scope questions. Latest complete live checkpoints at `10ee277` passed 21/23 older cases and 70/75 coverage cases on Luna/low, once each with zero provider failures. The last trigger-query metadata correction passed a three-case selected diagnostic at `abe136b`; it was not a complete-suite rerun or a substituted 71/75 result.

**Caveat.** An earlier three-repeat older-suite run had 17 upstream 403 failures (46/52 clean attempts passed); an overlapping 100-case development run had 15 provider failures (73/85 clean passed). Both remain recorded and neither is a clean benchmark. The final one-pass results improve on the previous 14/23 snapshot, but do not establish repeat consistency or clear the merge gate. Rescheduling, team clarification, nested IDs, missing discovery/detail steps and broader task verification remain imperfect. PLANNER-OUTCOMES-VALIDATION.md records every checkpoint, failure and condition. No model-specific branch, assertion relaxation, push or merge.

## 25. Bind children to parents and questions to missing inputs
`167f4a4` · 2026-10-24 · runs: scoped-inputs-dev-all-20261024 → scoped-inputs-final-luna-regression-20261024-1x → scoped-inputs-final-luna-coverage-20261024-1x

**Problem.** Field, channel and stage labels are meaningful only under their parent. Identity questions could also bypass grounding by being labelled a business/content choice. Models were being asked to reconstruct relationships that code already owns.

**Change.** Added parent-bound nested/array lookup metadata, typed form answer entries alongside legacy ID-keyed values, form-field/community-channel resolvers and scoped stage bindings. Every fresh clarification names an offered action and its actual missing argument; code rejects supplied/unspecified optional inputs, respects declared conditional messaging routes, and grounds names regardless of display category. Generated lookup IDs cannot shadow referenced read IDs. Existing membership, permissions, rollback and approval paths remain intact. Only these first two follow-on priorities are implemented; no independent final-state verifier or workflow retrieval bundle.

**Verification.** Typecheck, web build and 2,353 deterministic tests pass. Combined development retrieval remains 97.6% recall, 96.9% all-needed, 21.8 mean cards; that measurement records dirty development source. Complete live suites at clean 48cbf80 use Luna/low once each: 16/22 older-suite clean attempts plus one timeout, and 69/73 coverage clean attempts plus two timeouts. Form submission, community post/pin, scoped stage refusal and Noah's team join pass. Neither run is a clean or repeated benchmark.

**Caveat.** The older suite regressed from the preceding 21/23 checkpoint; this does not clear the merge gate. Investigated failures include model-authored read-step ID reuse, conflicting clarification selectors, unsupported polymorphic ID lookup, empty-target loops and premature report discovery. A genuinely required booking-page slug still produces a question. No scenario assertions, seed records, retrieval questions or frozen reporting data changed. Full evidence and every failure are in SCOPED-LOOKUPS-VALIDATION.md. Changes are committed locally, not pushed or merged.

## 26. A second provider: the Qwen Token Plan, and DeepSeek on it
`8728216` · 2026-10-24 · commits: `6fa53ec`, `76f5bef`, `8728216`

**Problem.** Every planner so far ran through a CLI (`claude -p`, then Codex), which starts a process per call and
can't meet the latency targets (entry 22). Subscription limits had also cut several runs short.

**Change.** `planner/qwen.ts` calls the Token Plan's OpenAI-compatible endpoint directly, with the `submit_plan`
schema as structured output. Thinking is off unless `QWEN_THINKING` is set; a dropped connection, a 5xx or a 429 with
a short Retry-After gets one retry, while a quota fails at once; a truncated or filtered reply says so. Planners now
declare their own billing and models, so eval cost totals, history and `--cache` files follow the provider. DeepSeek
on the plan has no `json_schema` mode ("This response_format type is unavailable now"), so
`QWEN_RESPONSE_FORMAT=json_object` puts the schema in the system message instead; the app still validates and
repairs every plan.

**Why this way.** One file per provider behind the same `Planner` interface: the prompt, compile checks, executor and
evals don't change, so the models can be compared on the same scenarios.

**Result.** First full suites, 3 repeats, no infra failures (result files in `8728216`, not kept in the final tree):
deepseek-v4.1-flash-1017 passed regression 75.4%, development 93.3%, reporting 94.4%; qwen3.8-flash 62.3%, 86.7%
and 55.6%. Both were well behind the Claude runs on the same suites, which entry 27 went after.

**Cost.** Token Plan usage is prepaid and reports no dollars; cost cells were "–" until entry 29.

## 27. Two looks, and compiler errors a weaker model can act on
`c52cc7f` · 2026-10-25 · commits: `eac7788`, `19c0350`, `c52cc7f`

**Problem.** On the Token Plan models the failures were planning mechanics, not choosing actions: one look wasn't
enough when the second read depended on the first, answers came from nothing, plans used ids nobody had shown them,
step refs pointed one step off, and a "resolve" written in the wrong field came back as "unknown action resolve".

**Change.** A second look may build on the first; asking for a third gets one plain nudge. An answer with no
`<context>` or `<looked>` behind it is nudged once to plan the read. Literal ids the planner was never shown and no
record has are repaired before the plan runs. A write by id to one of several same-named records asks which. A ref
to the step being written, to `s0` or to a later step names the id to use instead, so one repair fixes it. A
resolve written in the action field becomes a resolve step instead of "unknown action resolve", and the errors for
`$rr`, `$item` outside a forEach and `[*].results` say where the ref belongs and which earlier step to point at.

**Why this way.** Compiler changes are mechanical and hold across models. Prompt additions on this model moved
behaviour between cases without a net gain: six more lines describing what each step returns were tried and
reverted after they won the two cases they targeted and lost three indirect ones.

**Result.** From the line-B history (`git show bba0d86:eval/results/history.jsonl`; these runs were left out when
the branch merged in `9511f89`): qwen3.8-flash regression 23 × 3 reached 88.4% after the look changes; three
clean-tree batches before the compiler change passed 87.0%, 87.0% and 88.4%, and four batches with it 90.9% pooled
(251/276), p ≈ 0.06 by permutation, so suggestive rather than proven. DeepSeek at `19c0350` passed regression
98.6% (68/69) at 1.7 s p50.

**Side effects.** Temperature 0 was measured and rejected: three repeats of one case gave three different plans, so
the endpoint has no deterministic sampler to lean on.

## 28. Which planner runs by default, decided three times
`82e13a7` · 2026-10-25 · commits: `da0cc97`, `9706c83`, `148728d`, `bba0d86`, `82e13a7`

**Problem.** The default had to be a model that was measured, and that a reviewer's checkout could actually run.

**Change.** First DeepSeek became the default, with the reply format following the model: a 400 that blames the
format is retried once as `json_object` and remembered, so a model that loses the mode degrades instead of failing
every turn. Then the default went back to `claude-cli` on the `haiku` alias, with the Token Plan opt-in. A blank
`CLAUDE_MODEL=` line reached `claude -p --model ""` and failed every turn; blank model variables now fall back to the
default. Measuring the alias showed it resolved to an older Haiku on the installed CLI, so the default names
`claude-haiku-5-5` by its full id.

**Result.** All in the line-B history at `bba0d86`. DeepSeek as default: regression 95.7% (66/69) at 1.9 s p50,
development 97.8% (44/45, one repeat) at 1.1 s. The `haiku` alias: regression 91.3% (21/23, one repeat) at 23.9 s
p50. Haiku 5.5 by id: regression 100% of 184 runs (8 repeats) at 7.2 s p50, development 100% of 360.

**What it says.** An alias is not a measurement: the same word ran a different model than every Haiku baseline.
Entry 32 settles the default by which key is present.

## 29. A benchmark on DeepSeek: the brief, parameters and regression, 86 scenarios
`b92d7b2` · 2026-10-26 → 2026-10-27 · commits: `b43ebf3`, `d80b4b1`, `edbcb04`, `55461af`, `550a5df`, `b92d7b2`

**Problem.** The 23 regression scenarios didn't include the brief's own examples or check parameters directly, and
BENCHMARK.md still reported Haiku through `claude -p`.

**Change.** Added the brief's examples with held-out variants (`eval/brief-scenarios`, 12) and 51
parameter-accuracy scenarios (`eval/param-scenarios`), and fixed the general failures they exposed: forEach output
paths explained in errors, a follow-up that would make again what the last turn made is asked first, a question
about a name that fits two records goes to the user, and DUPLICATE reuses the existing record when later steps need
it. A write loop over a search that found nothing used to end "done"; it now replans once, and a retry repeating the
empty search is sent back with the look-alike search to try. The report prices prepaid DeepSeek tokens at Model
Studio list rates, marked "(list rate)", and loads the scenario folders the reported run used.

**Result.** 86 scenarios, one repeat each, at `94899ef`: planner 94.2% (81/86) against the baseline's 89.5%
(77/86), action selection 100% against 94.5%, direct first reply p50 1.5 s against 2.7 s. After the empty-loop
retry the planner passed 95.3% (82/86) in two separate runs. The report from the second (`550a5df`): cost per
successful task $0.0044 against $0.0112 (list rate), complex end-to-end p95 12.3 s, just over its 12 s target.

**Caveat.** One repeat per scenario; the baseline column is the earlier run, since the retry isn't on its path.

## 30. Replies that don't parse, and plans that read the wrong thing
`89300d1` · 2026-10-27 · commits: `659bd49`, `39e1f51`, `51bb812`, `e347a6a`, `d9d59c6`, `89300d1`

**Problem.** DeepSeek's failures in the 86-scenario runs were mostly mechanical: a reply cut off at the token cap or
wrapped in prose ended the turn; `"$s2.items[0].invoiceId}"` had a stray brace; a loop's results came back as a list
per item, so `in`/`nin` filters and exclude sets silently matched nothing or everything; a narrowing follow-up ("just
the Facebook ones, due tomorrow") restated the last request and was pushed to remake its records; plans after a look
reused the looked steps' ids (`s1`, `s2`) for new steps while still meaning the looked ones.

**Change.** A non-JSON reply is asked for once more per turn; the Qwen client trims prose around the object and drops
trailing commas (never for a cut-off reply); a ref closed by an unopened brace reads as the ref. Loop results are
typed per call and read as one flat list. A follow-up's stated outcome is checked against what the last turn made
before it binds; a `{{template}}` holding an expression is refused. Before a write loop over looked-at records, the
planner is told in plain words what each filter and exclude keeps, and if its next reply breaks, the plan said back
runs. A filter with no condition that nothing reads is dropped. After a look, a `<new_step_ids>` line names the
looked ids and the first free one.

**Why this way.** Each is a rule in the compiler or the turn loop, not a scenario fix: they hold for any model that
makes the same slip.

**Result.** Not measured on their own; entry 33's 273 × 3 runs include all of them.

## 31. Writes see every match; a turn has a budget; every planner call is traced
`a3df7ba` · 2026-10-27 · commits: `1a2b89d`, `a3df7ba`, `1d7adb4`, `c3a0353`, `c9de7c2`

**Problem.** A loop or bulk-id write fed by a search acted on its first page (50) and still reported done. A turn had
no overall limit: repairs, looks and retries could keep calling the model, and a closed browser tab didn't stop it.
Nothing recorded which call in a turn was slow or why.

**Change.** A search whose results feed a write loads every match (up to 500); if more match, the write refuses and
changes nothing, naming the search and the counts. A limit the plan asked for ("the 10 newest") is kept. One approval
over a run of sends lists every step it covers, and the approval preview lays out recipients, subject and body
instead of raw JSON. A turn makes at most 8 planner calls in 180 s, each call's timeout cut to the time left; a closed
stream aborts the call in flight. A turn that runs out changes nothing. Every planner call carries a trace (call
number, model, prompt hashes, wall-clock and model time, attempts, usage), shown in the debug view and `ask`.
BENCHMARK.md leads with tokens and model calls.

**Why this way.** Silent truncation is the worst outcome for a bulk write: the user sees success. Refusing with the
counts is safe and says what to narrow.

## 32. DeepSeek on the Token Plan is the default when a key is present
`d74874f` · 2026-10-27 · commits: `e9a1204`, `5920bf5`, `d74874f`

**Problem.** The benchmarked model (entry 33) was opt-in, while the default was Haiku through a CLI a reviewer might
not have.

**Change.** With `PLANNER` unset, a Token Plan key selects qwen, now defaulting to deepseek-v4.1-flash-1017; no key
falls back to `claude-cli` on Haiku 5.5. Key detection trims each key, falls through from `QWEN_API_KEY` to the
`ALIBABA_TOKEN_PLAN_API_KEY` alias and ignores the `.env.example` placeholder, so an old `.env` copy falls back to
Claude instead of failing every turn with 401. Every command prints which planner it picked. A missing Claude CLI
fails with how to install it or set a key, not a bare spawn error.

**Why this way.** The default is the measured setup when it can run, and a working one when it can't; `PLANNER`
still forces either.

## 33. Final benchmark: 273 scenarios × 3 on DeepSeek, planner against baseline
`0b24cca` · 2026-10-27 · commits: `5801aef`, `0b24cca`, `1b0806d` · runs: final-deepseek-planner-3x → release-deepseek-planner-3x

**Problem.** Every earlier benchmark was a subset: 23 scenarios, or 86. The submission claims all 50 modules.

**Change.** One run over eleven scenario folders (regression, brief, parameters, module coverage, Wave 1,
M45–M47 development, reporting and trails, questions, role ids, partial confirmation): 273 scenarios, 3 repeats,
both agents on deepseek-v4.1-flash-1017 through the qwen adapter. Two commerce scenarios gained asserted M25 actions
so every module is checked. The first run (`5801aef`) measured `b3a94d4` with uncommitted edits; it was re-run from a
clean checkout at `d74874f`, after entries 30–32, and that run is the one BENCHMARK.md reports. A run that timed out
before any model answered no longer blanks every cost. The build-time reports were removed (`1b0806d`); git history
keeps them.

**Result.** At `b3a94d4`+: planner 96.5% (790/819) against the baseline's 90.8% (744/819). Release at `d74874f`:
planner 96.9% (789/814 clean runs, 5 infra) against 91.6% (744/812, 7 infra); 254 of 273 scenarios pass every run.
Action selection 98.7% against 96.3%, parameters 98.1% against 94.9%, final data 98.7% against 96.5%. Median model
calls per complex task 1 against 5. On the brief's 12 scenarios the planner passed 29 of 35 clean runs, the
baseline 20 of 34. Seven of eight targets are met; the miss is direct first-reply p95, 4.3 s against 3.0 s (p50
1.3 s); complex end-to-end is 1.6 s p50 and 7.8 s p95.

**Cost.** Tokens per run 12,852 in / 209 out against 21,063 / 214. At Model Studio list rates (the plan is prepaid),
$0.0043 per successful task against $0.0073; $3.38 for the whole planner run.

**Still failing.** `param-create-ticket` 0/3 (the owner is left off the ticket), `merge-two-sarahs` and
`direct-card-refund-request` 1/3 each, the brief's Facebook follow-ups, and six coverage scenarios that failed once each,
mostly by not planning an offered action (report comparisons, tax, pipeline stages, a form submission, a community
pin). BENCHMARK.md lists every failing run.

## 34. After the release run: a retried turn's approval, and limits nobody asked for
`a2d2d13` · 2026-10-27 · commits: `3f7e2b0`, `405749a`, `a2d2d13`

**Problem.** Two bugs found after the release run. A retried turn waits for approval as `<turnId>_retry`, but the UI
posted the first attempt's id, so Approve failed with "Nothing is waiting for approval". And planners copy the
schema's default `limit: 50` into searches, which turned off entry 31's widening: a write could stop at the first 50
matches and report success. 50 of the 819 release planner runs wrote that limit, the brief's complex leads example
among them.

**Change.** The confirm event updates the turn's id. A limit is read against everything the user said in the turns
the planner saw: any limit of 50 or more their words never give is dropped, a smaller one ("the newest", "top three")
is kept, and amounts, shares and spans ("$50", "50%", "50 days") don't count as asking for that many. A limit the
user did give still applies, and the approval and reply say "the first N of the M found". A capped list that an
exclude or filter checks against refuses the write.

**Result.** Not re-measured: the release numbers in entry 33 predate both fixes.

## 35. README brought to the release run
`beddc34` · 2026-10-27 · commits: `4373b3a`, `0b459b6`, `cd43fc9`, `beddc34`

**Change.** The README's scores, latency and brief-suite numbers now come from the release run; links to files not in
the repo are gone. It says that filtering and joins run in memory over loaded records, and what real data volumes
would need instead. Provider detail moved to `docs/PROVIDERS.md` and build history to `docs/IMPLEMENTATION-NOTES.md`,
with sections on what is real and what is mocked, and the trade-offs.
