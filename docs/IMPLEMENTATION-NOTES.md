# Implementation notes

Build history and module-specific rules that the [README](../README.md) leaves out. The design itself is in [PLAN.md](PLAN.md).

## How main came together

All 500 actions in all 50 modules are executable. The first 18 modules (Contacts, Leads, Opportunities, Tasks, Notes, Tags, Conversations, SMS, Email, Campaigns, Appointments, Invoices, Payments, Reviews, Business Listings, Support Tickets, Users and Teams) were built in depth first and carry the regression and module evals; the other 32 were added in Wave 1 and then hardened (assumptions in [WAVE1-ASSUMPTIONS.md](../WAVE1-ASSUMPTIONS.md)). Wave 1's own planner scenarios (`eval/module-scenarios/wave1`) numbered 25 during the hardening runs. On those 25, Haiku scored 96% of clean runs (3 repeats), up from 66.7% before the failure classes they exposed were fixed. In that Haiku run, "Move X from Starter to Pro" was read as an opportunity stage change every time instead of a subscription plan change; DeepSeek passes that scenario 3 of 3 in the release benchmark. Two scenarios were added afterwards, so the folder now holds 27.

The shared planner work is explained in [PLANNER-CHANGES.md](PLANNER-CHANGES.md) and [scoped lookups and clarifications](SCOPED-LOOKUPS-AND-CLARIFICATIONS.md). In short: records are looked up by name in code, child names are bound to their parent, ids named for a role look up the right record type, contact-owned records (invoices, quotes, orders, subscriptions, enrollments) can be named by owner and state, and clarifying questions must point at an argument that is actually missing.

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

The 45 development cases cover all thirty action IDs. The 12 reporting cases and matching seed IDs were frozen before the handlers, in commit `080618f`; reporting outcomes were not used for tuning. Development revision 2 corrects one test that counted existing seeded requests and asserts appointment reads through actual calls (which may run in a look); its original bytes/results are archived and its fingerprint changes. Seed and reporting definitions remain unchanged. When M45–M47 landed, the 23-scenario regression set kept its fingerprint (`fcc7ddef4615`) **but its seeded database expanded**. The set has since been edited twice (`ab4218f` replaced the card-refund scenario, `9a973d8` edited `followup.json`); it is still 23 scenarios, and the current fingerprint, `6b297b0555d4`, is pinned in `server/src/eval/selection.test.ts`. Legacy-row hashes check that existing records were not rewritten.

## Search-card review status

The initial five modules (M01, M03, M06, M48, M49) were reviewed during the original build. M45–M47's generated metadata was compared with the new handlers; registry descriptions and entities supply their implemented contracts. Aliases incorrectly promising SMS review requests, holiday hours, a pending ticket state or resolution SLA were corrected. Proposed extra sibling links were measured on development cases and not adopted, because they increased shortlist size without improving recall. The other cards have not been reviewed by hand; regenerating cards overwrites hand edits.
