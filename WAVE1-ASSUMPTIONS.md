# Wave 1 assumptions

Decisions made during the Wave 1 hardening (October 2026) without a product owner to ask. Each one is an assumption, so each can be reversed. Where a decision is in code, the place is named. The hardening report these notes came from was removed from the tree; read it with `git show 0b24cca:WAVE1-HARDENING-REPORT.md`.

## A1. Which write actions need a permission

**Context.** After hardening, five write actions had no `requirePermission` check: M02.A05, M02.A09, M20.A10, M35.A09 and M35.A10. `m48-users` (where permissions are defined) is outside the Wave 1 brief, so no new permission could be added. Only the eleven existing ones can be used:

`users.manage`, `teams.manage`, `contacts.manage`, `leads.manage`, `opportunities.manage`, `tasks.manage`, `billing.manage`, `messaging.send`, `reports.view`, `tickets.manage`, `reputation.manage`.

**Rule used.** A permission check is added only where it excludes someone. The test is `ROLE_PERMISSIONS` in `m48-users/schema.ts`: if every role holds the permission, the check does nothing and is not added.

| Action | Decision | Assumption |
|---|---|---|
| M35.A09 publish website | Gated on `messaging.send` | Putting a site in front of the public is outbound communication, so it is held to the same bar as M16.A08 (publish workflow) and M27.A08 (send quote). This excludes the `billing` role only. |
| M35.A10 unpublish website | Gated on `messaging.send` | Taking a live site offline is the reverse of publishing and must not be easier to do than publishing. |
| M02.A05 archive company | Left ungated | The only fitting permission is `contacts.manage`, and all six roles hold it, so a check would do nothing. Matches M01, where contact archive is also ungated. Archive is reversible state, not a delete. |
| M02.A09 merge companies | Left ungated | Same reason as M02.A05. It moves contacts and marks the duplicate `merged`, but it is limited to contacts every role can already edit. |
| M20.A10 archive calendar | Left ungated | No calendar permission exists, and no other M20 or M21 action is gated. The handler already refuses when upcoming booked appointments exist, so it cannot orphan a booking. |

**Where it is in code.** `m35-websites/index.ts`, first line of the A09 and A10 handlers. Test: `M35.A09 publish and M35.A10 unpublish need messaging.send` in `m35-websites/websites.test.ts`. It checks that `billing` and an unknown actor get `PERMISSION`, that a refusal leaves the site status unchanged, and that `marketing` succeeds.

**To reverse.** Delete the `requirePermission` line from the two handlers and that one test.

### Why `messaging.send` and not something else

- It is the existing permission closest to "publish content to an audience". `reputation.manage` and `reports.view` are about reviews and analytics.
- `billing.manage` would lock out sales, support and marketing, who are the people most likely to run a site.
- Roles that can publish a site: admin, manager, sales, support, marketing. Roles that cannot: billing.

### Extended to the rest of the publishing family

The same rule was then applied to the other public-facing publish and unpublish actions, so one site-publishing rule holds across M35 to M38: **M36.A09** publish funnel, **M37.A09** publish landing page, **M37.A10** unpublish landing page, **M38.A09** publish post and **M38.A10** unpublish post. Each has a test with `billing`, an unknown actor and `marketing`.

Not gated, on purpose: **M38.A08** (schedule a post) only sets a future date and publishes nothing by itself, and **M36.A10** is a read. Whether scheduling should also need the permission is an open question for the product owner.

## A2. No quote email row

M27.A08 (send quote) stores no `emails` row. Adding a `quote` email kind means changing `EMAIL_KINDS` in M13 and making quote sends obey do-not-disturb and the send queue, which changes behaviour that the M27 description and tests state explicitly. That is a feature decision, not a hardening fix, so it was left alone in the final hardening pass on 23 October 2026.

## A3. Standing assumptions from earlier in the hardening

- **A default actor is admin.** When a call has no `actorId`, it runs as admin. Tests of a refusal must pass an explicit actor. An actor id that is not a known, active user is refused with `PERMISSION`.
- **Cash cannot be refunded through a processor.** A cash payment has no processor to send money back through, so M33 refuses the refund with `CONFLICT` at request, approve and execute (commit `51951eb`). The alternative, recording a manual cash refund, was not built.
- **A sibling link goes both ways.** If A lists B as a look-alike, retrieving B also brings A (commit `73f0a87`, `retrieval/cards.ts`). This is applied when the cards are built, not by editing every module.
- **M22 slots keep the full meeting length.** A local time that happens twice (clocks going back) is its first occurrence. One that never happens (clocks going forward) lands the same distance after the gap, as if the old offset still applied (commit `46cabdb`).
- **Releasing a coupon on cancel.** Cancelling an order frees the coupon redemption it held, so the same coupon can be used again (M32.A09, commit `3371395`).
- **Brief limits stayed in force.** During the Wave 1 hardening, nothing under `store/`, `registry/`, `retrieval/`, `planner/`, `core/`, `docs/`, `eval/` or `m48-users` was changed beyond two structural edits: the `noChange` helper in `registry/helpers.ts` and mutual siblings in `retrieval/cards.ts`. Later shared work has since changed those folders.
