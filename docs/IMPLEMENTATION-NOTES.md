# Implementation notes

Build history and module-specific rules that the [README](../README.md) leaves out. The design itself is in [PLAN.md](PLAN.md).

## How main came together

All 500 actions in all 50 modules are executable. The first 18 modules (Contacts, Leads, Opportunities, Tasks, Notes, Tags, Conversations, SMS, Email, Campaigns, Appointments, Invoices, Payments, Reviews, Business Listings, Support Tickets, Users and Teams) were built in depth first and carry the regression and module evals; the other 32 were added in Wave 1 and then hardened (assumptions in [WAVE1-ASSUMPTIONS.md](../WAVE1-ASSUMPTIONS.md)). Wave 1's own set of 27 planner scenarios (`eval/module-scenarios/wave1`) scored 96% of clean runs on Haiku (3 repeats), up from 66.7% before the failure classes it exposed were fixed; in that Haiku run, "Move X from Starter to Pro" was read as an opportunity stage change every time instead of a subscription plan change. DeepSeek passes that scenario 3 of 3 in the release benchmark.

Two planner lines were developed in parallel and merged into main: one on GPT-6 Luna through Codex, one on DeepSeek/Qwen through the Token Plan. The lookup and retrieval work came first: consistent named lookup, child names bound to their parents, and clarifying questions tied to the action arguments that are actually missing ([rationale](PLANNER-CHANGES.md), [scoped lookups and clarifications](SCOPED-LOOKUPS-AND-CLARIFICATIONS.md)). The two lines then added:

- Id arguments named for a role look up their record type.
- Invoices, quotes, orders and subscriptions can be named by state or owner, as in "Marco Patel's open invoice".
- Clarification repair, plus repair for invented ids.
- Up to two looks per turn, and a retry when a search finds nothing.
- Answers to questions start with a verdict, with record cards under it.
- The Qwen Token Plan adapter.

## Reviews, listings and tickets (M45–M47)

These thirty actions use the existing registry, compiler, executor, approval gates, replay ledger, SQLite persistence, audit, traces and UI ([module-building guide](ADDING-A-MODULE.md)). Ticket-reply batches disclose known blocked targets and require approval of the eligible subset before sending ([subset confirmation](PARTIAL-CONFIRMATION.md)).

- Reviews: draft/send/cancel requests, record/search reviews, draft/publish responses and compute rating summaries. Requests are marketing emails and respect opt-outs/DND.
- Listings: one profile per business/location/directory; the same business on Google and Yelp is valid and ambiguous by name alone. Changes increment a version; publication syncs that version. Hours use America/New_York, all seven days, one interval per day; no overnight/split shifts.
- Tickets: requester/contact links, eligible support owners, priority/status/history, private notes, replies and **elapsed first-response SLA**, not resolution SLA. Targets: urgent 1h, high 4h, normal 24h, low 72h. Exactly at deadline meets it. Reopening does not reset it. Only delivered requester replies count; automatic acknowledgements do not exist. Closed/resolved tickets must reopen before a reply.
- New customer sends need their domain permission plus `messaging.send`; ordinary reads/internal writes retain the existing selective permission policy. This is not a global authorization retrofit. Publication needs reputation permission, not messaging permission.
- Generic email preview/send/schedule routes module-owned kinds back to the review/ticket action so request state and ticket SLA cannot be skipped. Ticket emails bypass marketing preferences under simulator policy but **never** the address requirement.
- Failed module-owned sends roll back their database effects and surface in traces. Injected directory failure likewise preserves the previous published version; it does not manufacture a stored failed sync after rollback.

### Their eval sets

```sh
# From server/; scenario directories are relative to the repository root.
npm run eval:scenarios -- --scenario-dir eval/module-scenarios/m45-m47/development --repeat 3 --label m45-m47-development
npm run eval:scenarios -- --scenario-dir eval/module-scenarios/m45-m47/reporting --repeat 3 --label m45-m47-reporting
npx tsx src/scripts/eval-module-retrieval.ts
```

The 45 development cases cover all thirty action IDs. The 12 reporting cases and matching seed IDs were frozen before the handlers, in commit `080618f`; reporting outcomes were not used for tuning. Development revision 2 corrects one test that counted existing seeded requests and asserts appointment reads through actual calls (which may run in a look); its original bytes/results are archived and its fingerprint changes. Seed and reporting definitions remain unchanged. The old 23-scenario regression fingerprint is unchanged **but its seeded database has expanded**. Legacy-row hashes check that existing records were not rewritten.

## Search-card review status

The initial five modules (M01, M03, M06, M48, M49) were reviewed during the original build. M45–M47's generated metadata was compared with the new handlers; registry descriptions and entities supply their implemented contracts. Aliases incorrectly promising SMS review requests, holiday hours, a pending ticket state or resolution SLA were corrected. Proposed extra sibling links were measured on development cases and not adopted, because they increased shortlist size without improving recall. The other cards have not been reviewed by hand; regenerating cards overwrites hand edits.
