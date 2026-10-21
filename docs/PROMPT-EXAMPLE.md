# Prompt structure: a worked example

What the planner call actually looks like, over two turns of the brief's showcase prompt. The layout and rules are summarised in [PLAN.md §2 ②](PLAN.md#prompt-structure). Action ids come from the catalog PDF. Input and output schemas are our proposals, since we define them.

## The layout

```
format:  submit_plan JSON schema                   static, structured output (no tools)
system:  role + rules + plan grammar + examples    static
         ── cache breakpoint ──
messages:
  user:  <now>           date, timezone, precomputed ranges
         <context>       working set summary
         <recent_turns>  last 2–3 exchanges, text only
         <actions>       the ~15–20 retrieved cards (implemented actions only)
         <not_available> catalog actions that matched but aren't built yet, by name
         <message>       what the user just typed
```

- The provider caches in the order **tools → system → messages**, and only for a byte-identical prefix. So anything that changes per request goes after the breakpoint. That includes the timestamp and the retrieved cards. Keep the output schema constant too: OpenAI documents that changing `text.format` changes the cached prefix.
- **Across user turns** the request is rebuilt from scratch. Earlier turns arrive only as `<context>` and `<recent_turns>`, never as a growing list of messages.
- **Within one turn**, observe-loop rounds append an `<observations>` block (previous plan + digest) after `<message>`, so each round gets a cache hit on the round before it. This is shown at the end.

---

## Turn 1

> **User:** Find leads created last week who haven't replied, exclude anyone with a booked appointment, assign the rest to available sales reps, and create follow-up tasks.

### Request

```jsonc
{
  "model": "claude-sonnet-5-5",
  "temperature": 0,
  "max_tokens": 1500,
  "output_config": { "format": {                              // reply must match the schema; no free prose
    "type": "json_schema", "schema": SUBMIT_PLAN } },          // static
  "system": [{ "type": "text", "text": SYSTEM_PROMPT,          // static
               "cache_control": { "type": "ephemeral" } }],    // cache everything up to here
  "messages": [{ "role": "user", "content": USER_BLOCK_1 }]    // rebuilt every turn
}
```

### `SUBMIT_PLAN`: the output schema (~400 tokens; abridged)

```jsonc
{
  "type": "object",                     // root is an object, not anyOf (OpenAI strict requires this)
  "additionalProperties": false,
  "required": ["type", "steps", "question", "options", "reason", "alternatives", "query", "text"],
  "properties": {                       // every field required; unused ones are null
    "type":     { "enum": ["plan", "clarify", "unsupported", "answer", "search_tools"] },
    "steps":    { "type": ["array", "null"], "items": { "$ref": "#/$defs/step" } },  // type = plan
    "question": { "type": ["string", "null"] },                                       // type = clarify
    "options":  { "type": ["array", "null"], "items": { "type": "string" } },
    "reason":   { "type": ["string", "null"] },                                       // type = unsupported
    "alternatives": { "type": ["array", "null"], "items": { "type": "string" } },
    "query":    { "type": ["string", "null"] },                                       // type = search_tools
    "text":     { "type": ["string", "null"] }                                        // type = answer
  },
  "$defs": { "step": { "anyOf": [       // anyOf: supported by all three providers; oneOf isn't listed by any
    { "$ref": "#/$defs/actionStep" },   // { id, action, args }: run a catalog action
    { "$ref": "#/$defs/resolveStep" },  // { id, resolve }: name → id, done by our code
    { "$ref": "#/$defs/opStep" }        // { id, op, in, ... }: filter | exclude | forEach | if | observe
  ] } }                                 // no recursion: forEach.do lists action calls; if.then/else name step ids
}
```

- `args` differs per action, so here it's a loose object. Zod checks it against the action's own schema after the reply.
- The adapter derives this from the canonical Zod type. DeepSeek gets the same schema as a strict function, with `$defs` renamed to `$def` (see [PLAN.md: Model providers and routing](PLAN.md#model-providers-and-routing)).

There's no `confirm` field. Confirmations are decided by the risk policy in code (PLAN.md §2 ③).

### `SYSTEM_PROMPT` (static, ~1,100 tokens; abridged)

```text
You are Ask AI, the assistant inside a CRM. You never run anything yourself.
Every turn, reply with one submit_plan object of one of these types:
  plan          steps for the executor to run
  clarify       ONE question, only when a required detail is missing and no search can find it
  unsupported   no action in <actions> can do this; suggest the closest ones.
                If the request needs one in <not_available>, name it in plain words.
  answer        the question can be answered from <context> alone
  search_tools  the actions you need are not in <actions>; say what to search for

Rules
1. Use only action ids listed in <actions>. Never invent ids, fields, records or values.
2. Refer to earlier results with $<stepId>.<path>, e.g. $s1.items[*].contactId.
   Refer to the previous turn's records with $ctx.<name>, as listed in <context>.
   Never copy data out of results.
3. For people, teams or records the user names, add a resolve step. The system turns
   the name into an id and asks the user if there are several matches.
4. Express logic with ops, not with extra actions:
   filter  {in, where}           keep items matching where
   exclude {in, by, set}         drop items whose <by> is in set
   forEach {in, do, roundRobin?} run do per item; $item = current, $rr = next roundRobin entry
   if      {cond, then, else?}
   observe {of, why}             stop and show yourself a digest of this result.
                                 Use it only when the next steps depend on judging content.
5. Dates: use the ranges in <now>. Never compute calendar math yourself.
6. Leave optional args out unless the user implied them.
7. Don't ask for confirmation; the system does that for risky steps.
8. Never state results. The system writes the reply from what actually ran.

Example
user: "assign Acme Dental's open deals to Priya"
→ {"type":"plan","steps":[
    {"id":"s1","resolve":{"entity":"company","name":"Acme Dental"}},
    {"id":"s2","resolve":{"entity":"user","name":"Priya"}},
    {"id":"s3","action":"M04.A03","args":{"companyId":"$s1.id","status":"open"}},
    {"id":"s4","op":"forEach","in":"$s3.items",
     "do":[{"action":"M04.A06","args":{"opportunityId":"$item.id","ownerId":"$s2.id"}}]}]}
(+ 2 more examples: one clarify, one unsupported)
```

### `USER_BLOCK_1` (rebuilt each turn, ~1,600 tokens)

```text
<now>
Tue 2026-10-20 14:02, Asia/Kolkata
today 2026-10-20 · tomorrow 2026-10-21
this week 2026-10-19..2026-10-25 · last week 2026-10-12..2026-10-18
</now>

<context>
(new conversation)
</context>

<recent_turns>
(none)
</recent_turns>

<actions>
M03.A03 search_leads: Find leads (prospects, not yet customers) by created date, source, status or owner.
  in  { createdAfter?: date, createdBefore?: date,
        source?: "facebook_ads"|"google_ads"|"website"|"referral"|"import",
        status?: "new"|"working"|"qualified"|"disqualified", ownerId?: userId }
  out { items: [{ id: leadId, contactId, name, source, status, ownerId?, createdAt }] }

M11.A10 list_unanswered_conversations: Conversations waiting on a reply.
  waitingOn "contact" = we wrote last and the contact hasn't replied.
  waitingOn "team"    = the contact wrote last and nobody on our side has answered.
  in  { waitingOn: "contact"|"team", channel?: "sms"|"email"|"any", since?: date }
  out { items: [{ id: conversationId, contactId, lastMessageAt, lastFrom }] }

M21.A03 search_appointments: Find meetings by contact, host, date range or status.
  in  { contactId?, hostId?, from?: date, to?: date,
        status?: "booked"|"completed"|"cancelled"|"no_show" }
  out { items: [{ id, contactId, hostId, startsAt, status }] }

M49.A09 get_team_workload: Open work per team member, and whether each is available today.
  in  { teamId }
  out { members: [{ userId, name, available: bool, openLeads, openTasks }] }

M03.A05 assign_lead_owner: Make a user responsible for a lead. (For contacts use M01.A07.)
  in  { leadId, ownerId: userId }   out { lead }

M06.A01 create_task: Create a to-do for a user, optionally linked to a contact, lead or deal.
  in  { title, assigneeId: userId, dueDate?: date, priority?: "low"|"normal"|"high",
        relatedTo?: { type: "contact"|"lead"|"opportunity", id } }
  out { task: { id: taskId, ... } }

M01.A07 assign_contact_owner: Make a user responsible for a contact. (For leads use M03.A05.)
M11.A02 search_conversations: …
M49.A03 list_teams: …
M48.A03 list_users: …
… 5 more (15 total)
</actions>

<message>
Find leads created last week who haven't replied, exclude anyone with a booked
appointment, assign the rest to available sales reps, and create follow-up tasks.
</message>
```

The lines in brackets in a card description, such as "(For contacts use M01.A07.)", are deliberate. They are look-alike hints, which matter most when siblings from different modules are both shortlisted.

### Response (~380 output tokens)

```jsonc
// content[0].text, parsed; the null fields are left out here
{
  "type": "plan",
  "steps": [
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
        { "action": "M06.A01", "args": { "title": "Follow up with {{$item.name}}",
            "assigneeId": "$rr.userId", "relatedTo": { "type": "lead", "id": "$item.id" } } }
    ] }
  ]
}
```

### What happens in code after that

1. **Validate.** Every `$ref` must point at an earlier step and every `args` object must pass its Zod schema. On failure, make one repair call.
2. **Risk policy.** s9 writes 12 records, so it's marked bulk and needs a confirmation gate.
3. **Execute.** s1, s2, s3 and s4→s5 run in parallel, giving 14 leads → 9 → 6 and 3 available reps. The run pauses at s9 and the user confirms.
4. **Summarize.** The reply is built from the results.
5. **Update the working set.** Store the 6 leads and 6 tasks with their filterable fields, plus a text summary of the turn. This is all turn 2 will see.

There's no `dueDate` on the tasks. The user didn't give one, and rule 6 says not to invent it.

---

## Turn 2

> **User:** Only include leads from the Facebook campaign, and make those tasks due tomorrow.

### Request

```jsonc
{
  "output_config": { ... SUBMIT_PLAN ... },  // ┐ byte-identical to turn 1
  "system": [ SYSTEM_PROMPT ],                // ┘ → cache read, 5% of normal input price on Sonnet 5.5
  "messages": [{ "role": "user", "content": USER_BLOCK_2 }]   // only this is new
}
```

Turn 1's messages are **not** resent: no turn-1 plan and no step results. What turn 2 needs from turn 1 is in `<context>`.

### `USER_BLOCK_2`

```text
<now>
Tue 2026-10-20 14:05, Asia/Kolkata
today 2026-10-20 · tomorrow 2026-10-21
this week 2026-10-19..2026-10-25 · last week 2026-10-12..2026-10-18
</now>

<context>
Last request (completed 14:03): leads created 2026-10-12..18, waiting on the contact's
reply, no upcoming booked appointment → 6 leads. Owners assigned round-robin
(Priya, Marco, Dana). 6 follow-up tasks created, no due date.

$ctx.leads (6):
  ld_88  Ana Ruiz   source=facebook_ads  owner=Priya
  ld_91  Ben Cole   source=google_ads    owner=Marco
  ld_93  Chen Wei   source=facebook_ads  owner=Dana
  ld_97  Dee Park   source=facebook_ads  owner=Priya
  ld_102 Eli Stone  source=referral      owner=Marco
  ld_110 Fay Lin    source=facebook_ads  owner=Dana
$ctx.tasks (6): each { id, leadId, assigneeId, dueDate: null }   tk_201..tk_206
</context>

<recent_turns>
user: Find leads created last week who haven't replied, exclude anyone with a booked …
assistant: Done. 6 of 14 new leads needed follow-up (5 had replied, 3 had appointments).
           Assigned 2 each to Priya, Marco and Dana, and created 6 tasks.
</recent_turns>

<actions>                      re-retrieved from the message + context entity types
M06.A06 set_task_due_date …
M06.A10 cancel_task …
M06.A03 search_tasks …
M03.A05 assign_lead_owner …
M03.A06 set_lead_source …      look-alike trap: "Facebook" pulls this in
M15.A03 list_campaigns …       "campaign" pulls this in
M03.A03 search_leads …
… 8 more
</actions>

<message>
Only include leads from the Facebook campaign, and make those tasks due tomorrow.
</message>
```

The working set lists items with their filterable fields only while it's small, up to about 20. Past that it shows counts and the `$ctx` handle, and the records stay in the executor.

### Response

```jsonc
{ "type": "plan", "steps": [
  { "id": "s1", "op": "filter",  "in": "$ctx.leads", "where": { "source": "facebook_ads" } },
  { "id": "s2", "op": "exclude", "in": "$ctx.leads", "by": "id", "set": "$s1[*].id" },
  { "id": "s3", "op": "filter",  "in": "$ctx.tasks", "where": { "leadId": { "in": "$s2[*].id" } } },
  { "id": "s4", "op": "filter",  "in": "$ctx.tasks", "where": { "leadId": { "in": "$s1[*].id" } } },
  { "id": "s5", "op": "forEach", "in": "$s3", "do": [
      { "action": "M06.A10", "args": { "taskId": "$item.id", "reason": "Not a Facebook lead" } } ] },
  { "id": "s6", "op": "forEach", "in": "$s4", "do": [
      { "action": "M06.A06", "args": { "taskId": "$item.id", "dueDate": "2026-10-21" } } ] }
] }
```

Our code then applies the risk policy. s5 cancels tasks, which is destructive, so it asks: "Cancel 2 tasks for non-Facebook leads and set 4 tasks due Oct 21?" After that it executes and writes the reply. The reply also says the 2 non-Facebook leads still have owners, and offers to unassign them.

---

## Where the tokens go

| Part | Turn 1 | Turn 2 | Cache |
|---|---|---|---|
| `submit_plan` + system prompt | ~1,500 | ~1,500 | written in turn 1, **read** in turn 2 |
| `<now>` | 40 | 40 | no |
| `<context>` | 10 | ~280 | no |
| `<recent_turns>` | 5 | ~90 | no |
| `<actions>` (15 cards) | ~1,500 | ~1,450 | no |
| `<message>` | 35 | 25 | no |
| **Input total** | **~3.1k** | **~3.4k** | turn 2 pays full price on only ~1.9k |
| Output | ~380 | ~260 | n/a |
| LLM calls | 1 | 1 | n/a |

These are estimates. The benchmark measures the real numbers. Turn 10 costs about the same as turn 2. The ReAct baseline at turn 2 would be resending all of turn 1: 14 leads, 31 conversations and 12 write results.

---

## Within a turn: the observe loop

When a plan ends in `observe`, the next round keeps the same request and **appends an `<observations>` block after `<message>`**. The model needs its own earlier plan in front of it, so the block carries that plan plus the result digest:

```
Round 1:  [format][system] | user{ <now> … <actions> <message> }                              → plan (… observe)
Round 2:  [format][system] | user{ <now> … <actions> <message> <observations>plan + digest</observations> }
                             └──────────── same bytes as round 1 ────────────┘                 → prefix cache hit
```

- `<observations>` holds a **digest**: summaries, ids, counts and at most 5 sample rows.
- If round 1 returned `search_tools`, the new cards go *inside* `<observations>`. Replacing the original `<actions>` block would break the cache.
- This avoids native `tool_use`/`tool_result` threading, whose format differs by provider. The same loop runs on Anthropic, OpenAI and DeepSeek. Anthropic needs a second `cache_control` breakpoint at the end of round 1's content (up to 4 are allowed); OpenAI's implicit mode and DeepSeek match the prefix automatically. See [PLAN.md: Model providers and routing](PLAN.md#model-providers-and-routing).
- When the turn ends, all of this is dropped. Only the working set and the text summary carry forward.

---

## Decisions this example settled

1. **M11.A10 gets a `waitingOn` parameter.** "Leads who haven't replied" means *we* wrote last, while "unanswered conversations" normally means the *customer* wrote last. That's the opposite. Without the parameter and a description that says both cases plainly, the showcase prompt would silently pick the wrong leads.
2. **Code computes the calendar ranges** and lists them in `<now>`. The model picks from them and never does date arithmetic.
3. **Confirmations are decided only in code.** The plan has no `confirm` field.
4. **Follow-ups use `$ctx.<name>` plus ordinary ops.** No special syntax.
5. **The working set lists items only while it's small** (≤ ~20 items, with filterable fields). Past that, counts plus a handle.
6. **"Facebook campaign" is ambiguous.** It could mean the lead source `facebook_ads` or a Campaign record (M15). This example assumes the source field. Add an eval scenario for it.
7. **Nothing that changes per request goes before the cache breakpoint**: no timestamp, user name or retrieved cards.
