import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { compile } from "./compile.js";
import { execute } from "./execute.js";
import { summarize, touchedRecords } from "./summarize.js";

let registry: Registry;
before(async () => {
  registry = await loadRegistry();
});

const action = (id: string, act: string, args: unknown) => ({ id, kind: "action" as const, action: act, argsJson: JSON.stringify(args) });
const plan = (steps: SubmitPlan["steps"]): SubmitPlan => ({
  type: "plan",
  steps,
  question: null,
  options: null,
  reason: null,
  alternatives: null,
  query: null,
  text: null,
});

let runs = 0;
async function reply(steps: SubmitPlan["steps"], ctx = world(), approve = false) {
  const r = compile(plan(steps), registry);
  if (!r.ok) assert.fail(r.errors.join("\n"));
  runs++;
  let run = await execute(r.plan, registry, ctx, { executionId: `sum${runs}` });
  if (approve && run.pending) run = await execute(r.plan, registry, ctx, { executionId: `sum${runs}`, approvals: [run.pending] });
  return { text: summarize(r.plan, run, registry), ctx };
}

describe("summarize: writes", () => {
  test("say which record they made", async () => {
    const { text } = await reply([action("s1", "M06.A01", { title: "Call Ana" })]);
    assert.equal(text, "Done: Create task (Call Ana).");
  });

  test("an outcome recorded as a failure is not reported as a plain success", async () => {
    const ctx = world();
    const request = ctx.f.reviewRequest({ contactId: ctx.f.contact({ email: "gone@bounce.example" }).id });
    const bounced = await reply([action("s1", "M45.A02", { requestId: request.id })], ctx, true);
    assert.match(bounced.text, /^Done: .*, but the email bounced \(Mailbox doesn't exist \(hard bounce\)\), so the request is marked failed and was not sent\.$/);
    const listing = ctx.f.listing({ directory: "yelp-down" });
    const down = await reply([action("s1", "M46.A09", { listingId: listing.id })], ctx, true);
    assert.match(down.text, /but the sync to yelp-down failed \(yelp-down is not responding\), so the listing is still unpublished\.$/);
    const ok = await reply([action("s1", "M46.A09", { listingId: ctx.f.listing().id })], ctx, true);
    assert.doesNotMatch(ok.text, /but/);
  });
});

describe("summarize: a plan that only reads still answers", () => {
  test("ticket SLA keeps the actual verdict in the bounded user summary", async () => {
    const { text } = await reply([action("s1", "M47.A10", { ticketId: "tic_1" })]);
    assert.match(text, /Portal export fails/);
    assert.match(text, /status breached/);
    assert.match(text, /policy first_response/);
  });

  test("a search reports the total and names what it found", async () => {
    const { text, ctx } = await reply([action("s1", "M03.A03", {})]);
    const total = ctx.store.all("leads").length;
    assert.ok(total > NAMES_SHOWN, "seed has more leads than are named");
    assert.match(text, new RegExp(`^Found ${total} leads: .+ and ${total - NAMES_SHOWN} more\\.$`));
    assert.match(text, /\((new|contacted|qualified|disqualified|converted)\)/, "each name carries its status");
  });

  test("a search capped by its limit still counts everything, not just what came back", async () => {
    const { text, ctx } = await reply([action("s1", "M03.A03", { limit: 1 })]);
    const total = ctx.store.all("leads").length;
    assert.match(text, new RegExp(`^Found ${total} leads: [^,]+ and ${total - 1} more\\.$`));
  });

  test("a search with one match shows that record's fields", async () => {
    const ctx = world();
    const c = ctx.f.contact({ firstName: "Zelda", lastName: "Quill", email: "zelda@example.com" });
    const { text } = await reply([action("s1", "M01.A03", { query: "Zelda Quill" })], ctx);
    assert.match(text, /^Found 1 contact: Zelda Quill: /);
    assert.match(text, /status active/);
    assert.match(text, /email zelda@example\.com/);
    assert.doesNotMatch(text, new RegExp(c.id), "ids stay out of the reply");
  });

  test("an empty search says so, with what it searched for", async () => {
    const { text } = await reply([action("s1", "M03.A03", { query: "nobody-by-this-name" })]);
    assert.equal(text, "No leads found matching query nobody-by-this-name.");
  });

  test("a get returns the one record", async () => {
    const ctx = world();
    const lead = ctx.f.lead({ firstName: "Omar", lastName: "Haddad", status: "contacted" });
    const { text } = await reply([action("s1", "M03.A02", { leadId: lead.id })], ctx);
    assert.match(text, /^Omar Haddad \(lead\): .*status contacted/);
  });

  test("records titled rather than named lead with their title, and ids stay out", async () => {
    const ctx = world();
    ctx.f.task({ title: "Chase the Zelda quote", priority: "high" });
    const { text } = await reply([action("s1", "M06.A03", { query: "Zelda quote" })], ctx);
    assert.match(text, /^Found 1 task: Chase the Zelda quote: /);
    assert.doesNotMatch(text, /\b[a-z]{2,4}_\d+\b/, text);
  });

  test("two records with the same name are told apart", async () => {
    const ctx = world();
    ctx.f.contact({ firstName: "Zed", lastName: "Twin", email: "zed1@example.com" });
    ctx.f.contact({ firstName: "Zed", lastName: "Twin", email: "zed2@example.com" });
    const { text } = await reply([action("s1", "M01.A03", { query: "Zed Twin" })], ctx);
    assert.match(text, /Zed Twin, zed1@example\.com \(active\), Zed Twin, zed2@example\.com \(active\)/);
  });

  test("rows named by a …Name field (conversations' personName) are listed by it", async () => {
    const { text } = await reply([action("s1", "M11.A10", { waitingOn: "team" })]);
    assert.match(text, /^Found \d+ conversations matching waiting on team: [A-Z][a-z]+ [A-Z]/, text);
    assert.doesNotMatch(text, /\?|, ,/, text);
  });

  test("a read that feeds a later step stays quiet; the last one answers", async () => {
    const { text } = await reply([
      { id: "s1", kind: "resolve", entity: "team", name: "Sales" },
      action("s2", "M49.A09", { teamId: "$s1.id" }),
    ]);
    assert.equal(text.split("\n").length, 1, text);
  });

  test("a loop of reads is the answer, so it shows what each item returned", async () => {
    const ctx = world();
    const listing = ctx.f.listing({ name: "Harbor Dental", directory: "yelp" });
    const { text } = await reply([
      action("s1", "M46.A03", { query: "Harbor Dental" }),
      { id: "s2", kind: "op" as const, op: "forEach" as const, in: "$s1.items", whereJson: null, by: null, set: null, roundRobin: null, do: [{ action: "M46.A10", argsJson: JSON.stringify({ listingId: "$item.id" }) }] },
    ], ctx);
    assert.ok(text.length > 0 && text.includes(listing.name) && /never_published/.test(text), text);
  });

  test("a loop of writes names the ones whose outcome was recorded as a failure", async () => {
    const ctx = world();
    const good = ctx.f.reviewRequest({ contactId: ctx.f.contact({ email: "ok@example.com" }).id });
    const bad = ctx.f.reviewRequest({ contactId: ctx.f.contact({ email: "gone@bounce.example" }).id });
    const { text } = await reply([
      action("s1", "M45.A04", {}),
      { id: "s2", kind: "op" as const, op: "forEach" as const, in: "$s1.items", whereJson: null, by: null, set: null, roundRobin: null, do: [{ action: "M45.A02", argsJson: JSON.stringify({ requestId: "$item.id" }) }] },
    ], ctx, true);
    assert.match(text, /But 1 of those did not go through: .*email bounced/, text);
    assert.ok(good.id && bad.id);
  });
});

const NAMES_SHOWN = 5;

describe("touchedRecords", () => {
  async function records(steps: SubmitPlan["steps"]) {
    const r = compile(plan(steps), registry);
    if (!r.ok) assert.fail(r.errors.join("\n"));
    return touchedRecords(r.plan, await execute(r.plan, registry, world(), { executionId: `rec${++runs}` }));
  }

  test("name each record a turn found or made, with its id and status, for the next turn to refer to", async () => {
    const text = await records([{ id: "s1", kind: "resolve", entity: "user", name: "Raj" }, action("s2", "M06.A01", { title: "Call Ana", assigneeId: "$s1.id" })]);
    assert.match(text!, /^user us_\d+ "Raj[^"]*"/);
    assert.match(text!, /; task tk_\d+ "Call Ana" \(\w+\)$/);
  });

  test("a long list is cut short and says how many more", async () => {
    const text = await records([action("s1", "M06.A03", {})]);
    assert.match(text!, /; and \d+ more$/);
    assert.equal(text!.split("; ").length, 9);
  });

  test("nothing found, nothing said", async () => {
    assert.equal(await records([{ id: "s1", kind: "resolve", entity: "team", name: "Nonexistent Squad" }]), undefined);
  });
});
