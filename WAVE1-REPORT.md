# Wave 1 report

Every catalog module is now registered: 50 modules, 500 actions. The table in the task lists 32 modules (the ones that were still unbuilt). All 32 are done. None were skipped. Nothing was pushed.

Group A was implemented on `wave1/modules` itself, and a second copy landed on `wave1/group-a`. The two copies conflict, so `wave1/group-a` was not merged. The commits below are the ones on `wave1/modules`. Groups B through G were merged with `git merge --no-ff`.

## Modules

| Module | Commit | Actions | Tests | Status |
|---|---|---|---|---|
| M02 companies | `b4bf88b768d3339e2ba9118fe32fdb4d049f27d1` | 10 | 8 | done |
| M05 pipelines | `2099e18ec5b7b15f819393f62252b0111236b8e7` | 10 | 9 | done |
| M09 smart lists | `38bb8e77754bce6686a3febb5869a30056ab5c02` | 10 | 6 | done |
| M10 custom fields | `e0ad1bf344cebc6445987c66981be5c647e5038e` | 10 | 7 | done |
| M14 message templates | `98c2903f118c00c5dabdc401a114e39f5bb0d995` | 10 | 8 | done |
| M16 workflows | `a61f24dadab0b4b71ad78ac41cfcba994d3809f0` | 10 | 4 | done |
| M17 event triggers | `d1e8facd415113aeea20580de3de6dd2cef03ef5` | 10 | 4 | done |
| M18 forms | `0c2f1b254da93184bd3ddd974165117748945d52` | 10 | 3 | done |
| M19 surveys | `228761a5445504f355a3e16207cb1dff4000bf69` | 10 | 3 | done |
| M20 calendars | `17ceb4710b0221e59c295e777607b794e7da191e` | 10 | 3 | done |
| M22 availability | `5e499b4c3d7acd6059782bcd816dfb3f4d51a91d` | 10 | 5 | done |
| M23 booking pages | `d9f220cf062762cf2c30d33b5990bc5a034fae77` | 10 | 2 | done |
| M24 events | `e0c051ed0b60ca0025aa423e87b54b9b3e5bbea1` | 10 | 2 | done |
| M25 products | `e420c8a9fa86046b8613322abf513fe32c773a08` | 10 | 3 | done |
| M26 prices | `49883e0ffb6ba5854acf46a40cb618f5a7b8f883` | 10 | 3 | done |
| M27 quotes | `1f75429b5b49b6b79eb2d31494c7b1630e36143e` | 10 | 4 | done |
| M30 subscriptions | `aa4fa9a72be0e3b9726335438f5f3a4f97fd83b2` | 10 | 4 | done |
| M31 coupons | `16dfdf5cc28e49a5074cc4019dc9c532a7f56388` | 10 | 3 | done |
| M32 orders | `1a5047b2450d1cb981ca577f9fa57ee8a47f8f3e` | 10 | 6 | done |
| M33 refunds | `6b5d9fa244dc63f91963c6a736f1134f3ae932ed` | 10 | 5 | done |
| M34 tax rules | `4909d2c14df1985e1ce4c882dcda18a38fb39b63` | 10 | 3 | done |
| M35 websites | `513f52e434b79acc5cc18f2567b1ea282a09a585` | 10 | 9 | done |
| M36 funnels | `3356d0b1cd49b2679273524ef10a83cc167b3312` | 10 | 10 | done |
| M37 landing pages | `2c3d1de4b58ee4f639ced4d3b72de9b2019f15a3` | 10 | 8 | done |
| M38 blogs | `a05d365051817e8c9995fc79fb42722c66d23fc5` | 10 | 7 | done |
| M39 media assets | `7b2dd956fbc35e5d9fbb38d48125574b92ff58a0` | 10 | 8 | done |
| M40 courses | `a125f032ea41db00eb5cf71cd13092463fa44a93` | 10 | 11 | done |
| M41 lessons | `c987e64a056746a962f7566339fb1008fbd1d346` | 10 | 10 | done |
| M42 enrollments | `e789f48fd2b42c75c357dc999359a6bc03318f48` | 10 | 11 | done |
| M43 communities | `b4191b04f631a41fcb5228165c47b2e4aebe524e` | 10 | 11 | done |
| M44 memberships | `bf588b171b7fcd6c6092bb98bdc49e4893a5aa43` | 10 | 11 | done |
| M50 reports | `7919a1f58cfce21807845c77c500298a623d429f` | 10 | 12 | done |

Test counts are the verifier's `test(` count for that module folder. Every module registers 10 actions.

Registry check: 50 modules, 500 actions, M01 through M50 with no gaps.

## Final gate

Typecheck (`npm run typecheck` in `server/`):

```
> typecheck
> tsc --noEmit
```

Exit code 0.

`npm test`:

```
ℹ tests 1940
ℹ suites 531
ℹ pass 1935
ℹ fail 5
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10782.833667
```

The five failures are outside the module folders. They are listed under gaps. Baseline before this work was 830 passing.

Verifier:

```
REVIEW M24.A10 Check in attendee: risk is write, name suggests read; justify in report
verify: OK
```

`grep` for `TODO`, `not implemented`, `@ts-ignore`, `Date.now(`, and `new Date(` in the new `index.ts` files prints nothing.

Scope, before this report commit: `git diff --name-only 3a10127 HEAD` is only files under the 32 module folders. `git status --porcelain` is `?? server/.wave1/`. The verifier was not committed.

## Risk justifications

The verifier flagged one action.

- **M24.A10 Check in attendee** is `write`. The name starts with "check", which the verifier treats as a query, but the handler records that a registered attendee has arrived and sets `checkedInAt`. A waitlisted person is refused until they are promoted.

Other risks that do not match a naive reading of the name, and that the verifier did not flag:

- **M17.A09 Test trigger with sample event** is `write`. It inserts a `trigger_firings` row. It does not start a workflow run.
- **M32.A08 Submit order** is `external`. It issues an open invoice, redeems a coupon, and decrements inventory. The name does not start with a word on the verifier's external list.
- **M50.A07 Run report** is `write` because it sets `lastRunAt`.
- **M50.A10 Schedule report delivery** is `external` because it schedules delivery. No email row is inserted.
- **M42.A10 Issue course completion certificate** is `external` because the name starts with "issue".
- **M14.A09 Render template with sample data** is `read`. It does not send.
- **M39.A09 Generate asset access link** is `write`. It stores the link on the asset and does not send it.

Publish actions are `external`. Archive, cancel, delete, unpublish, deactivate, merge, revoke, remove, and execute-refund actions are `destructive`. Searches, gets, lists, previews, validates, exports, and calculates are `read`.

Permission checks use only permissions that already exist. `billing.manage` gates quote send and convert, subscription cancel, order submit and cancel, and refund approve, reject, and execute. Quote send also requires `messaging.send`. Report run, compare, export, and schedule require `reports.view`. Schedule also requires `messaging.send`. There is no permission for workflows, websites, calendars, or companies, so those destructive and external actions are ungated, same as deleting a note.

## Gaps for the integrator

These files were not edited. Each one now fails because the new modules exist.

- `server/src/server/app.test.ts` expects `meta.actions.length` to be 180. It is 500.
- `server/src/planner/turn.test.ts` still uses M02.A03 as an action that is not built, and still expects the word "product" inside `<not_available>`.
- `server/src/retrieval/retrieve.test.ts` requires BM25 recall at 15 to stay at least 0.9. It measured `0.8988842398884239`. Descriptions on workflows and triggers were left as the existing card sentences because rewriting them moved this ranking. `npm run cards` was not run.

`ENTITY_TYPES` in `server/src/retrieval/cards.ts` does not include `membership`, `community_member`, `saved_report`, `custom_field_value`, `message_template`, `event_trigger`, `workflow_run`, `trigger_firing`, `survey_response`, or `tax_exemption`. Actions use the nearest name already on that list (`membership_plan`, `community`, `report`, `custom_field`, `template`, `trigger`, `workflow`, `form_submission`, `survey`, `event`, `tax_rule`, `contact`). M34.A08 records a tax exemption but declares `contact` as what it produces.

`Email.kind` has no quote or report value, so sending a quote and scheduling a report do not insert an `emails` row. Quote send still checks that the contact can be emailed.

`CommunityMember` has no `membershipId`. Revoking a membership sets `leftAt` on that contact for every community on the plan, including a community they had already joined on their own.

M05 does not define its own pipeline builder. `Fixtures.prototype.pipeline` in `store/fixtures.ts` is the one tests already use. New stages created by M05 get ids from `store.nextId`.

## Surprises

- Linking a contact who is already on another company is a conflict. Unlink them first. Unlink clears `companyId` and leaves `contacts.company` as it was. Merge moves the duplicate's contacts onto the survivor, id and name both. Renaming a company also rewrites `contacts.company` for contacts already linked to it.
- Archiving a pipeline is refused while any deal in it is still open. Removing a stage is refused if any opportunity, including a won or lost one, still sits in that stage.
- A workflow publishes from draft or paused, and only after validation passes and it has a step. Editing a published workflow says to pause it first. A trigger binds only to a published workflow. A test firing stores `test: true` and never inserts `workflow_runs`. There is no live dispatcher, so a matched test does not start a run. Published forms can still be edited. Survey questions lock once the survey leaves draft.
- Slot search treats a missing weekday as a day off. A date override replaces that day's weekly hours, even when the override is empty. A slot is returned once per free host. With no hosts, the calendar itself must be free. Booked appointments for a host block that host wherever they are. An appointment on this calendar whose host is not in `hostIds` blocks every host. Buffer is added after the appointment. The grid steps by the calendar's duration. Wall-clock conversion for zones other than America/New_York lives in `m22-availability/clock-local.ts`, because `atLocal` only knows the app timezone. Archiving a calendar counts booked appointments on that calendar whose `endAt` is still in the future.
- A draft booking page may link a private calendar. Publish refuses unless the linked calendar is public and active.
- Registering for a full event creates a waitlisted row and does not throw. Cancel frees a seat and does not promote. Promote takes the lowest waitlist position and renumbers the rest. Checked-in people count as seats taken.
- The first active price on a product becomes the default and sets `products.defaultPriceId`. Archiving that default is refused until another default is chosen. A non-USD price can exist, and adding one to a quote or an order is a conflict.
- Tax uses the longer region (`US-CA` before `US`) and does not fall through to a broader rule when the specific region has no matching category. A category match beats a null category. Inclusive tax is reported and not added on top. Exclusive tax is added. A valid exemption zeros the tax. Quote and order invoice totals are the discounted, taxed totals. Invoice line items are the product lines, so their sum can be short of `total` by the discount and the exclusive tax.
- Sending a quote requires `billing.manage` and `messaging.send`, marks a draft as sent, and does not insert an email. Only an accepted quote converts. The invoice is `open`, lines are copied, and the quote becomes `converted` with `invoiceId` set. There is no action that marks a quote declined or expired. A past expiry blocks acceptance and leaves the quote sent.
- Submitting an order checks stock before it writes. Pause then resume shifts both period ends forward by the time spent paused. The period is not restarted when the plan changes. A trial that is still in the future resumes as `trialing`.
- A cash refund is stored as a failed refund. The payment stays succeeded and its allocations are left alone. Cancelling an order restores inventory and voids an unpaid invoice, and it does not give the coupon redemption back.
- Publishing a funnel requires every linked landing page to be published. Linking also requires the page to be published already. A step with no page is allowed. Publishing a landing page refuses a draft form. Attaching a draft form to a page that is already published is refused. Deleting a media asset scans `mediaIds` on landing pages, blog posts, and lessons.
- A course publishes only when it has a published lesson. Lesson completion requires that published lesson, and it honors drip and enrollment expiry. A certificate is issued only when every published lesson is done, and the enrollment becomes `completed`. Granting a membership enrolls the contact in each course entitlement (a draft course is allowed here; direct enroll still requires the course to be published) and joins each community. If they were already enrolled, grant stamps `membershipId` on that enrollment, and revoke then revokes it.
- `pipeline_value` sums open opportunities and ignores the report's date range. Grouping that metric by day, week, or month still uses `createdAt`. Week starts on Monday in UTC. `source` applies only to new leads. `pipelineId` applies only to won deals and pipeline value.

## Not done

- The five failing tests above. Fixing them means editing the planner, the retrieval eval, and the HTTP meta test, which this pass does not touch.
- `wave1/group-a` still exists and was not merged. Do not merge it onto `wave1/modules`; it is a second copy of M02, M05, M09, M10, and M14.
- Retrieval cards were not regenerated. Seeds, resolvers, and eval scenarios were not added.
- `server/.wave1/verify.ts` is untracked on purpose.
