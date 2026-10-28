# Prompt structure: a worked example

What the planner call looks like over two turns of the brief's showcase request. The prompts below are the ones today's code builds (`server/src/planner/prompt.ts`), rendered offline from the benchmark's seeded account. The replies, token counts and timings come from the release benchmark run (`eval/results/scenarios-release-deepseek-planner-3x.json`, commit `d74874f`, DeepSeek `deepseek-v4.1-flash-1017` through the Qwen Token Plan). Nothing here is invented or estimated unless it says so.

The prompt was rendered by replaying the recorded replies through the real turn loop with a stand-in planner, so every round is built by the same code that built it in the benchmark. The system prompt hashes to the same value the benchmark recorded (`7d0e8b09bebf`). The user block is about 150 tokens longer than the one the benchmark sent, because a later commit reworded the `limit` hint on search cards. That hint matters below.

## The layout

```
system:  role + rules + plan grammar                       static, byte-identical on every call
         + the submit_plan JSON Schema                     (appended, because this model has no strict schema mode)
user:    <now>                date, timezone, precomputed ranges
         <context>            the last 4 exchanges, text only
         <resolvable>         record types a name can be looked up as
         <delivery_surfaces>  where email, SMS and public posts can go
         <requested_outcome>  the outcome the planner stated earlier this turn      (after a look or repair)
         <identity_check>     what a name lookup found, before a clarify is asked   (when one ran)
         <lookup_qualifiers>  exact-match keys a name lookup may use
         <recent_records>     typed ids of records this chat touched                (follow-ups)
         <mentions>           which record type each name in the message matched    (when names matched)
         <actions>            the retrieved cards
         <not_available>      catalog actions that fit but aren't built             (when some matched)
         <failed_attempt>     this message's plan that ran and failed               (on a retry)
         <message>            what the user just typed
         <looked>             results of read-only steps the planner asked for      (after a look)
         <new_step_ids>       which step ids are taken                              (after a look)
```

- **One system message, one user message.** The request goes to the Token Plan's OpenAI-compatible chat endpoint:

  ```jsonc
  {
    "model": "deepseek-v4.1-flash-1017",
    "messages": [
      { "role": "system", "content": SYSTEM + "\n\nReply with one JSON object that matches this JSON Schema:\n" + SUBMIT_PLAN },
      { "role": "user",   "content": USER_BLOCK }
    ],
    "response_format": { "type": "json_object" },  // this model answers HTTP 400 to json_schema
    "max_tokens": 8192,
    "enable_thinking": false
  }
  ```

  A model that accepts strict `json_schema` gets the schema in `response_format` instead, and the system message is `SYSTEM` alone. The Claude CLI fallback receives the same two strings.
- **The provider caches the prefix on its own.** There is no `cache_control` marker. The system message never changes, so every call can reuse it from the provider's cache. Everything that changes per request (the date, the cards, the message) sits in the user message after it.
- **Across user turns the request is rebuilt from scratch.** Earlier turns arrive only as `<context>` (text) and `<recent_records>` (typed ids), never as a growing list of messages.
- **Within one turn, each round is a fresh request too.** A look round adds `<looked>` at the end of the user block. A repair round appends the rejected plan and the errors. Nothing is threaded as tool-call messages, so the same loop runs on every provider.
- **All text from the account or the user is escaped** (`&`, `<`, `>`) before it goes in, so a record called `</message>` can't close a block.

---

## Turn 1

> **User:** Find leads created last week who have not replied, exclude anyone with a booked appointment, assign the remaining leads to available sales reps, and create follow-up tasks.

### `SUBMIT_PLAN`: the reply schema (~3,700 characters; abridged)

```jsonc
{
  "type": "object", "additionalProperties": false,
  "required": ["type", "steps", "question", "options", "reason", "alternatives", "query", "text",
               "outcome", "clarification", "lookup", "missing"],      // every field required; unused ones are null
  "properties": {
    "type":    { "enum": ["plan", "look", "clarify", "unsupported", "answer", "search_tools"] },
    "steps":   { "type": ["array", "null"], "items": STEP },
    "outcome": { "effect": "read" | "change", "actions": [ids of the final operations], "destination": surface | null },
    "clarification": "identity" | "content" | "choice" | null,
    "missing": { "action", "argument", "argsJson" } | null,      // what a clarify asks for
    "lookup":  { "entity", "name", "whereJson" } | null,
    "question", "options", "reason", "alternatives", "query", "text": strings or null
  }
}
STEP = anyOf
  { id, kind: "action",  action, argsJson }                          // run a catalog action
  { id, kind: "resolve", entity, name, whereJson }                   // a name → one id, done by our code
  { id, kind: "op", op: "filter"|"exclude"|"forEach", in, whereJson, by, set, roundRobin, do }
```

- **Arguments travel as JSON strings** (`argsJson`, `whereJson`). They differ per action, so the wire schema can stay one static object. Each action's own Zod schema checks them after the reply.
- **No recursion and no `$defs`.** `forEach.do` is a flat list of action calls. That keeps the schema inside what every provider's structured-output mode accepts.
- **There's no `confirm` field.** Code decides what needs approval.

### `SYSTEM`: the rules (static, 11,526 characters; abridged)

```text
You are Ask AI, the planner inside a CRM. You never run anything yourself.
Reply with one submit_plan object. Set unused fields to null.
  plan          steps for the executor to run
  look          read-only steps to run first, when a value must be worked out from what a record holds now;
                their results come back in <looked> and you plan again
  clarify       ONE question, only when a required detail is missing
  unsupported   no listed action can do this; say why
  answer        a direct answer from <context>, or, after a look, the answer to a question about records
  search_tools  the actions you need are not in <actions>; put what's missing in query
Rules:
- A yes/no, how-many or which question about records: look with the reads, then answer from <looked>,
  starting with the verdict.
- Fill outcome with the user's requested final effect (read or change) and the IDs of ALL final operations.
  Prerequisite searches are not the outcome ...
- Refer to earlier results with $refs: "$s1.items", "$s1.items[*].contactId", "$item.id" inside forEach.
  "$prev" is what the call before it returned for the same item. $rr is one item of the roundRobin list.
  Inside a string, interpolate with {{$item.name}}.
- Step ids count up in the order you list them (s1, s2, s3); a step may use only earlier ids.
- For an existing named record, put {"$lookup":{"entity":"report","name":"Monthly Revenue"}} directly in an
  ID argument. Code finds exactly one record; no match fails without creating anything, and multiple
  matches ask the user.
- A follow-up that narrows or changes what the last turn already did amends the records it made: update
  the ones that stay, cancel or undo the ones now left out, and don't make them again.
- Dates come from <now>. Don't ask for confirmation; the app asks the user before risky or bulk changes.
  ... (about 30 rules in all)
Ops (kind "op"):
- filter:  keep items of "in" matching whereJson: {"available": true}  {"score": {"gt": 80}}
           {"contactId": {"in": "$s2.items[*].contactId"}}
           operators: eq ne gt gte lt lte in nin contains exists; orNull also admits a missing value
- exclude: drop items of "in" whose field "by" is in the list "set". To keep only the items that ARE in
           another list, filter with "in" instead. Pick records by a $ref, never by ids copied out of <looked>.
- forEach: run each call in "do" once per item of "in"; "roundRobin" (optional) spreads a list across items as $rr
```

There are no worked examples in the system prompt. Each rule carries its own short example inline, which costs less and keeps the static prefix one block.

### `USER_BLOCK_1` (27,833 characters; the cards abridged)

```text
<now>2026-10-21 (Wednesday), America/New_York. today = 2026-10-21. tomorrow = 2026-10-22.
yesterday = 2026-10-20. this_week = 2026-10-19..2026-10-25. last_week = 2026-10-12..2026-10-18.
last_7_days = 2026-10-15..2026-10-21. last_30_days = 2026-09-22..2026-10-21.
weekdays = {"Friday":{"upcoming":"2026-10-23","next":"2026-10-23"}, ...}. Bare weekday uses upcoming
(including today); "next weekday" uses next (strictly future). Date ranges are inclusive.</now>
<context>empty</context>
<resolvable>appointment, blog_post, booking_page, calendar, campaign, ... user, website, workflow</resolvable>
<delivery_surfaces>[{"id":"sms","label":"SMS","actions":["M12.A03","M12.A04"]}, {"id":"email", ...}, ...]</delivery_surfaces>
<lookup_qualifiers>{"contact":["company","companyId","email","phone"], "lead":["email","company"], ...}</lookup_qualifiers>
<actions>
M03.A03 Search leads: Find leads (prospects, not yet customers) by when they were created, source,
  status, owner or score. Dates are inclusive. args { createdFrom?: date, createdTo?: date,
  source?: "facebook_ads"|"google_ads"|"website"|"referral"|"event"|"manual" /* where the lead came from;
  Facebook ads → facebook_ads */, status?: ..., ownerId?: string, unassigned?: boolean, ...,
  limit?: number /* only when the user asks for a number of records ("the 10 newest"); leave it out otherwise */ }
  → { items: { id, name, source, status, ownerId, createdAt, ... }[], total: number }
M11.A10 List unanswered conversations: List open conversations waiting for a reply, longest wait first.
  waitingOn "team" = the customer wrote last and we haven't answered. waitingOn "contact" = we wrote last
  and they haven't replied (e.g. leads who never answered our follow-up). People we never messaged have no
  conversation, so they don't appear. args { waitingOn: "team"|"contact", personType?: "contact"|"lead",
  ownerId?: string, minHours?: number, limit?: number } → { items: { conversationId, contactId, leadId,
  personName, waitingSince, hoursWaiting, ... }[], total: number }
M21.A03 Search appointments: Find appointments by contact or lead, host, status (default booked; 'any' for
  all) and date range. Use it to check whether someone has a meeting booked. Soonest first. ...
M48.A03 List users: List the people who work in this account (staff users, not contacts or leads). Filter
  by role, status, availability, team or name. args { role?: "admin"|"manager"|"sales"|..., status?: ...,
  available?: boolean /* true = not on leave */, ... }
M03.A05 Assign lead owner: Make a staff user the owner of a lead. For contacts, use M01.A07 Assign contact owner.
  args { leadId: string /* lead id (ld_…) */, ownerId: string /* user id */ } → { ... }
M06.A01 Create task: Create a to-do for a staff user, optionally about a contact, lead or opportunity. Leave
  dueDate out unless the user gave one; it can't be in the past. args { title: string, assigneeId?: string,
  dueDate?: date, priority?: ..., relatedTo?: { type: "contact"|"lead"|"opportunity", id: string } } → { ... }
  named IDs by record type {"relatedTo.id":"relatedTo.type"}
... 23 more: Create booking page, Disqualify lead with reason, Cancel appointment, Assign opportunity owner,
    Create lead, Create appointment, Find available slots, Search contacts, Search companies,
    Assign contact owner, Assign task owner, Search conversations, ... (29 in all)
</actions>
<message>Find leads created last week who have not replied, exclude anyone with a booked appointment,
assign the remaining leads to available sales reps, and create follow-up tasks.</message>
```

Where the characters go:

| Block | Characters |
|---|---|
| `<now>` | 792 |
| `<context>` | 24 |
| `<resolvable>` | 461 |
| `<delivery_surfaces>` | 978 |
| `<lookup_qualifiers>` | 811 |
| `<actions>` (29 cards) | 24,570 |
| `<message>` | 191 |

- **The cards are almost all of it.** Each card is the action's description plus its full input and output types, generated from the Zod schemas. The output types are there so the planner can write `$s2.items[*].leadId` knowing the field exists.
- **Bracketed hints in a description are deliberate.** "For contacts, use M01.A07 Assign contact owner" steers between look-alikes from different modules when both are shortlisted. "Facebook ads → facebook_ads" maps the user's words onto the enum.
- **`waitingOn` carries the direction.** "Leads who haven't replied" means *we* wrote last. "Unanswered conversations" normally means the *customer* wrote last, which is the opposite. The card says both cases plainly, so the planner can pick `"contact"`.
- **The shortlist is wide on purpose.** Retrieval doesn't know that "booked appointment" is a filter and not a request to book one, so Create booking page and Create appointment come along too. The planner ignores them.

### Response (492 output tokens, 2.8 s)

The reply from the first of the three benchmark runs, with the null fields left out:

```jsonc
{
  "type": "plan",
  "steps": [
    { "id": "s1", "kind": "action", "action": "M03.A03",
      "argsJson": "{\"createdFrom\":\"2026-10-12\",\"createdTo\":\"2026-10-18\",\"limit\":50}" },
    { "id": "s2", "kind": "action", "action": "M11.A10",
      "argsJson": "{\"waitingOn\":\"contact\",\"personType\":\"lead\",\"limit\":50}" },
    { "id": "s3", "kind": "op", "op": "filter", "in": "$s1.items",
      "whereJson": "{\"id\":{\"in\":\"$s2.items[*].leadId\"}}" },
    { "id": "s4", "kind": "action", "action": "M21.A03",
      "argsJson": "{\"status\":\"booked\",\"from\":\"2026-10-21\",\"limit\":50}" },
    { "id": "s5", "kind": "op", "op": "exclude", "in": "$s3", "by": "id", "set": "$s4.items[*].leadId" },
    { "id": "s6", "kind": "action", "action": "M48.A03",
      "argsJson": "{\"role\":\"sales\",\"status\":\"active\",\"available\":true,\"limit\":50}" },
    { "id": "s7", "kind": "op", "op": "forEach", "in": "$s5", "roundRobin": "$s6.items", "do": [
        { "action": "M03.A05", "argsJson": "{\"leadId\":\"$item.id\",\"ownerId\":\"$rr.id\"}" },
        { "action": "M06.A01", "argsJson": "{\"title\":\"Follow up with {{$item.name}}\",\"assigneeId\":\"$rr.id\",\"relatedTo\":{\"type\":\"lead\",\"id\":\"$item.id\"}}" }
    ] }
  ],
  "outcome": { "effect": "change", "actions": ["M03.A05", "M06.A01"], "destination": null }
}
```

- **`last week` came from `<now>`**, not from date arithmetic.
- **"Not replied" is a filter with `in`, and "booked" is an `exclude`.** Getting those two the right way round is the most common way this request goes wrong.
- **`outcome` names the two writes**, not the four searches. Code checks the plan against it: a plan that drops one of those actions is sent back.
- **`"limit":50` on every search** is a leftover of the old card hint, which read "max items to return (default 50)". The model copied the default into each call. A limit of 50 or more that the user never asked for is now dropped before the search runs, so a write is never fed a silently truncated list, and the card hint now says to leave it out.

### What happens in code after that

1. **Compile.** Every `$ref` must point at an earlier step, every `argsJson` must pass its action's Zod schema, and every field a filter or exclude reads must exist on those items. The third benchmark run got this wrong once: its exclude used `"by": "leadId"`, and the error went back as `step s5: "by": items have no field "leadId"; fields: id, firstName, ...`. The repair call (12,025 input tokens) fixed it and the run passed.
2. **Contract checks.** The plan must do what `outcome` says, must not make again what the last turn made, and must not invent ids. A plan that only reads is sent back.
3. **Risk policy.** s7 writes per item, and 3 or more items make it a bulk write, so the run pauses for one approval. The approval is bound to the plan's hash and to a hash of the exact targets: if the data changes before the user approves, they're asked again.
4. **Execute.** Names resolve first, then the steps run in order. 12 leads came in last week; 6 of them are waiting on our reply; 1 of those (Hiro Reyes) has a booked appointment; that leaves 5. Three sales reps are available. The round-robin gives Ben Nguyen and Femi Silva to Raj Iyer, Victor Larsen and Dev Kim to Tom Becker, and Marco Brown to Aisha Bello.
5. **Resume.** After the approval, the reads run again (so the targets are current) and the writes run, deduplicated through a ledger keyed by execution, step, item and call. Each item's two calls run in one transaction.
6. **Summarize.** Code writes the reply from what ran: *"Assign lead owner + Create task for 5 of 5: Ben Nguyen, Victor Larsen, Marco Brown, Femi Silva, Dev Kim."*

There's no `dueDate` on the tasks. The user didn't give one, and the Create task card says to leave it out.

All three benchmark runs of this turn passed: two in one planner call, one with a repair.

---

## Turn 2

> **User:** Only include leads from the Facebook campaign, and make those tasks due tomorrow.

This follow-up is the hard half of the showcase. The model has to see that "only include" narrows what turn 1 already did. That means it must update four of the five tasks it made and cancel the fifth, not make new ones. In the release benchmark the brief's exact wording failed all 3 runs, and a reworded version ("Actually, just the ones that came from Facebook ads, and have their tasks due tomorrow") passed 1 of 3. The walkthrough below follows that passing run. Its turn 1 used reworded text too, and ended with the same five leads, owners and tasks.

### What's different in the request

The system message is byte-identical to turn 1. Only the user block is new, and it's rebuilt from scratch: no turn-1 plan and no step results. What turn 2 needs from turn 1 is in two blocks.

```text
<context>user: Which leads that came in last week never got back to us? Leave out anyone who already has an
appointment booked, split the rest between the sales reps who are available, and give each of them a
follow-up task.
assistant: Assign lead owner + Create task for 5 of 5: Ben Nguyen, Victor Larsen, Marco Brown, Femi Silva, Dev Kim.</context>
<recent_records>[{"entity":"lead","id":"ld_44","name":"Dev Kim"},
  {"entity":"appointment","id":"ap_2","name":"Intro call with Hiro Reyes","for":"ld_1"}, ...
  {"entity":"user","id":"us_2","name":"Raj Iyer"}, ...
  {"entity":"task","id":"tk_20","name":"Follow up with Ben Nguyen","for":"ld_3"},
  {"entity":"task","id":"tk_21","name":"Follow up with Victor Larsen","for":"ld_41"}, ... tk_24]</recent_records>
<actions>
M03.A06 Set lead source ...       look-alike: "Facebook" pulls this in
M06.A06 Set task due date ...
M06.A03 Search tasks ...
M06.A10 Cancel task ...
M03.A03 Search leads ...
... 19 more (24 in all)
</actions>
<message>Actually, just the ones that came from Facebook ads, and have their tasks due tomorrow.</message>
```

- **`<recent_records>` holds identities, not contents.** It says tk_20 is "Follow up with Ben Nguyen" for ld_3. It doesn't say which lead came from Facebook, so the planner has to read that.
- **The cards are re-retrieved** from the new message plus the record types the last turn touched, so task actions come in.

### Rounds

This turn took four planner calls. Each one is a fresh request with the same system message:

| Round | What the planner sent | What code did |
|---|---|---|
| `plan` | A plan that creates a task for Ben Nguyen again, due tomorrow | Rejected it: *"the last turn already made 5 task records (Follow up with Ben Nguyen (tk_20, for ld_3), ...); if this message narrows or changes what it did, update those that stay and cancel or undo those now left out instead of M06.A01 again"* |
| `repair remake` | `look`: Search leads from last week with `source: facebook_ads`, and Search tasks | Ran both reads and added their results as `<looked>` |
| `plan after look` | A plan that sets the due date on the Facebook leads' tasks and cancels **every** task in the search | Compiled it, then said back what each step keeps before running anything (below) |
| `check selection` | The same plan, with the cancel narrowed to the tasks *not* linked to a Facebook lead | Ran it |

The plan after the look, as sent:

```jsonc
{ "type": "plan", "steps": [
  { "id": "s3", "kind": "op", "op": "filter", "in": "$s2.items",
    "whereJson": "{\"relatedTo.id\":{\"in\":\"$s1.items[*].id\"}}" },
  { "id": "s4", "kind": "op", "op": "forEach", "in": "$s3", "do": [
      { "action": "M06.A06", "argsJson": "{\"taskId\":\"$item.id\",\"dueDate\":\"2026-10-22\"}" } ] },
  { "id": "s5", "kind": "op", "op": "forEach", "in": "$s2.items", "do": [
      { "action": "M06.A10", "argsJson": "{\"taskId\":\"$item.id\",\"reason\":\"Lead is not a Facebook ads lead; no longer needed\"}" } ] }
],
  "outcome": { "effect": "change", "actions": ["M06.A06", "M06.A10"], "destination": null } }
```

s5 would have cancelled all five tasks, including the four just given a due date. Code doesn't know that's wrong; the model has to see it. So before a change runs on looked records, code reads the filter and exclude steps back in plain words, with what each keeps:

```text
check which records this changes before it runs: s3 keeps 4 of the 5 (Follow up with Victor Larsen, Follow up
with Marco Brown, Follow up with Femi Silva, Follow up with Dev Kim) items of $s2.items where relatedTo.id is
among $s1.items[*].id (what s1, M03.A03 Search leads {"createdFrom":"2026-10-12","createdTo":"2026-10-18",
"source":"facebook_ads"}, found); s4 runs M06.A06 on each. If those are exactly the records the request means,
plan the same again. ...
```

The model's next plan added `{ "op": "filter", "in": "$s2.items", "whereJson": "{\"relatedTo.id\":{\"nin\":\"$s1.items[*].id\"}}" }` in front of the cancel. Then code applied the risk policy. Setting four due dates is a bulk write, and cancelling a task is destructive, so the turn paused for two approvals. The reply:

> Set task due date for 4 of 4: Follow up with Victor Larsen, Follow up with Marco Brown, Follow up with Femi Silva, Follow up with Dev Kim.
> Cancel task for 1 of 1: Follow up with Ben Nguyen.

### How it fails

The readback only covers filter and exclude steps that feed a write loop. In the first run of the brief's own wording, the planner looked up the Facebook leads into s2 and filtered them into s3, then wrote its loop over the full task list:

```jsonc
{ "id": "s4", "kind": "op", "op": "forEach", "in": "$s1.items", "do": [
    { "action": "M06.A06", "argsJson": "{\"taskId\":\"$item.id\",\"dueDate\":\"2026-10-22\"}" } ] }
```

The loop reads the task search directly, so there's no filter chain to say back. The plan compiled, and all five tasks got tomorrow's due date. Ben Nguyen's task stayed open. The other two runs failed in different ways. One ran out of repairs: its plan still lacked the cancel its own stated outcome needed. The other assigned the four Facebook leads again and created four new tasks for them, so each ended up with two, and its cancel step selected nothing. The benchmark marks these as failed follow-ups (BENCHMARK.md lists them). "Amend what the last turn made" is the weakest part of the planner on this model.

---

## Where the tokens go

Measured, from the benchmark runs above. "Cached" is the part of the input the provider read from its prompt cache. It comes in 1,024-token blocks and varies from run to run, because the provider decides what stays cached.

| Call | Input | Cached | Output | Latency |
|---|---|---|---|---|
| Turn 1, `plan` (run 1) | 11,408 | 4,096 | 492 | 2.8 s |
| Turn 1, `plan` (run 2) | 11,408 | 11,264 | 498 | 2.7 s |
| Turn 2, `plan` | 9,773 | 4,096 | 175 | 6.4 s |
| Turn 2, `repair remake` | 10,121 | 9,728 | 163 | 1.3 s |
| Turn 2, `plan after look` | 10,960 | 4,096 | 291 | 1.9 s |
| Turn 2, `check selection` | 11,460 | 10,240 | 351 | 2.0 s |

- **About 4,000 tokens of every call are the static prefix** (the system rules plus the schema), and the rest is the user block, mostly cards. Turn 2 isn't bigger than turn 1, because it's rebuilt rather than appended to: 24 cards instead of 29, plus about 350 characters of `<context>` and 900 of `<recent_records>`.
- **A turn-10 request costs about the same as a turn-2 request.** `<context>` keeps the last 4 exchanges, and `<recent_records>` keeps identities, not contents.
- **Across the whole benchmark**, the planner averaged 12,852 input and 209 output tokens per run, and 74% of the input was read from cache. The one-call-per-step baseline, which resends the growing conversation on each step, averaged 21,063 input tokens per run.

The old version of this page estimated about 3,100 input tokens per call. That estimate assumed 15 short cards. Real cards carry full input and output types, and retrieval returns about twice as many.

---

## Within a turn: look and repair rounds

When the planner needs to read something before it can plan (which tasks belong to Facebook leads), it replies `look` with read-only steps. Code runs them and calls again with the same user block plus two more blocks at the end:

```
plan:             [system] | user{ <now> … <actions> <message> }                                   → look
plan after look:  [system] | user{ <now> <requested_outcome> … <actions> <message> <looked> <new_step_ids> }
                  └ same bytes ┘
```

- **`<looked>` holds the read results** as JSON, capped at 16,000 characters. The plan after it refers to them as `$s1`, `$s2` and so on, and those reads run again when the plan runs, so the records it changes are current.
- **`<new_step_ids>` says which ids are taken** ("$s1, $s2 are the looked steps; number this reply's steps from s3"), so each `$sN` means one step.
- **`<requested_outcome>` freezes the outcome** the planner stated in its first reply, so a later round can't quietly turn a change into a read.
- **A repair round appends `<rejected_plan>` and `<errors>`** after the user block. The errors are written for the model to act on: they name the step, the field and what to do instead.
- **The rounds are bounded.** A turn gets at most two looks. A plan that doesn't compile gets one repair, and a second only if the first got closer. A reply that isn't JSON is asked again once. Every call counts against the turn's budget of planner calls and time.
- **When the turn ends, all of this is dropped.** Only the exchange text and the records' identities carry forward.

---

## Decisions this example settled

1. **M11.A10 has a `waitingOn` parameter**, and its card spells out both directions. Without it, "leads who haven't replied" would silently pick the wrong leads.
2. **Code computes the calendar ranges** and lists them in `<now>`. The model picks from them and never does date arithmetic.
3. **Approvals are decided only in code.** The reply has no `confirm` field.
4. **Follow-ups carry identities, not contents.** `<recent_records>` lists typed ids; when the planner needs a record's fields, it reads them with a look.
5. **A plan states its outcome, and code holds it to it.** That's what catches a follow-up that remakes the tasks instead of amending them.
6. **Before a change runs on looked records, code says the selection back** and lets the planner correct it once. It only covers filter and exclude chains, which is why the run under "How it fails" got through.
7. **Nothing that changes per request goes in the system message**: no timestamp, user name or retrieved cards.
8. **"Facebook campaign" is read as the lead source `facebook_ads`.** The card maps "Facebook ads" to that value. A Campaign record of that name would be a different reading, and no scenario covers it yet.
