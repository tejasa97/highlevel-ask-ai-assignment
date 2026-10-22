import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { SubmitPlan, Step } from "../planner/submit-plan.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { compile } from "./compile.js";
import { execute } from "./execute.js";
import { summarize } from "./summarize.js";

// Scripted execution invariants, not model quality scores. Each workflow uses the existing compiler,
// references, item transactions, confirmation and replay ledger. No alternate module runner.
let registry: Registry;
before(async () => {
  registry = await loadRegistry();
});
const action = (id: string, action: string, args: unknown): Step => ({
  id,
  kind: "action",
  action,
  argsJson: JSON.stringify(args),
});
const filter = (id: string, input: string, where: unknown): Step => ({
  id,
  kind: "op",
  op: "filter",
  in: input,
  whereJson: JSON.stringify(where),
  by: null,
  set: null,
  roundRobin: null,
  do: null,
});
const each = (id: string, input: string, calls: [string, unknown][]): Step => ({
  id,
  kind: "op",
  op: "forEach",
  in: input,
  whereJson: null,
  by: null,
  set: null,
  roundRobin: null,
  do: calls.map(([action, args]) => ({
    action,
    argsJson: JSON.stringify(args),
  })),
});
function compiled(steps: Step[]) {
  const p: SubmitPlan = {
    type: "plan",
    steps,
    question: null,
    options: null,
    reason: null,
    alternatives: null,
    query: null,
    text: null,
  };
  const r = compile(p, registry);
  if (!r.ok) assert.fail(r.errors.join("\n"));
  return r.plan;
}

test("completed appointments → distinct contacts → review drafts → confirmed sends, replay-safe", async () => {
  const w = world();
  w.f.appointment({
    contactId: "ct_35",
    status: "completed",
    startAt: "2026-10-20T18:00:00.000Z",
  });
  const p = compiled([
    action("s1", "M21.A03", {
      status: "completed",
      from: "2026-10-19",
      to: "2026-10-21",
    }),
    action("s2", "M01.A03", {}),
    filter("s3", "$s2.items", { id: { in: "$s1.items[*].contactId" } }),
    each("s4", "$s3", [
      [
        "M45.A01",
        {
          contactId: "$item.id",
          subject: "Your visit",
          body: "Please review your visit",
        },
      ],
    ]),
    each("s5", "$s4", [["M45.A02", { requestId: "$item.results[0].id" }]]),
  ]);
  const requests = w.store.all("review_requests").length,
    emails = w.store.all("emails").length;
  const first = await execute(p, registry, w, {
    executionId: "appointment-reviews",
  });
  assert.equal(first.status, "awaiting_confirmation");
  assert.equal(first.pending!.count, 2);
  assert.equal(w.store.all("emails").length, emails);
  const done = await execute(p, registry, w, {
    executionId: "appointment-reviews",
    approvals: [first.pending!],
  });
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.equal(w.store.all("review_requests").length, requests + 2);
  assert.equal(w.store.all("emails").length, emails + 2);
  await execute(p, registry, w, {
    executionId: "appointment-reviews",
    approvals: [first.pending!],
  });
  assert.equal(w.store.all("review_requests").length, requests + 2);
  assert.equal(w.store.all("emails").length, emails + 2);
});

test("overdue invoices ∩ recent inbound conversations → one support ticket per contact", async () => {
  const w = world();
  // A second overdue invoice must not produce a second ticket for the same customer.
  w.f.invoice({ contactId: "ct_31", status: "open", dueDate: "2026-10-10" });
  const p = compiled([
    action("s1", "M28.A10", {}),
    action("s2", "M11.A02", {}),
    filter("s3", "$s2.items", {
      lastInboundAt: {
        gte: "2026-10-14T14:00:00.000Z",
        lte: "2026-10-21T14:00:00.000Z",
      },
    }),
    action("s4", "M01.A03", {}),
    filter("s5", "$s4.items", { id: { in: "$s1.items[*].contactId" } }),
    filter("s6", "$s5", { id: { in: "$s3[*].contactId" } }),
    each("s7", "$s6", [
      [
        "M47.A01",
        {
          contactId: "$item.id",
          title: "Invoice follow-up",
          body: "Overdue invoice and recent customer reply",
        },
      ],
    ]),
  ]);
  const result = await execute(p, registry, w, {
    executionId: "invoice-conversation-tickets",
  });
  assert.equal(result.status, "done", JSON.stringify(result));
  const made = w.store.find<any>(
    "tickets",
    (t) => t.title === "Invoice follow-up",
  );
  assert.deepEqual(
    made.map((t) => t.contactId),
    ["ct_31"],
  );
});

test("bulk note + ticket reply rolls back the failed item, preserves successes and deduplicates resume", async () => {
  const w = world(),
    before = w.store.all("emails").length;
  const p = compiled([
    action("s1", "M47.A03", { status: "open" }),
    each("s2", "$s1.items", [
      ["M47.A07", { ticketId: "$item.id", body: "Private triage" }],
      ["M47.A08", { ticketId: "$item.id", body: "We are investigating" }],
    ]),
  ]);
  const first = await execute(p, registry, w, {
    executionId: "partial-tickets",
  });
  assert.equal(first.status, "awaiting_confirmation");
  assert.equal(first.pending!.count, 3);
  const done = await execute(p, registry, w, {
    executionId: "partial-tickets",
    approvals: [first.pending!],
  });
  assert.equal(done.status, "partial");
  assert.equal(
    done.steps.at(-1)!.items!.filter((i) => i.status === "done").length,
    2,
  );
  const failed = w.store.get<any>("tickets", "tic_4")!;
  assert.deepEqual(failed.notes, []);
  assert.deepEqual(failed.replies, []);
  assert.equal(failed.firstResponseAt, null);
  assert.equal(w.store.all("emails").length, before + 2);
  assert.match(summarize(p, done, registry), /Failed for 1:.*email address/);
  await execute(p, registry, w, {
    executionId: "partial-tickets",
    approvals: [first.pending!],
  });
  assert.equal(w.store.all("emails").length, before + 2);
  assert.equal(w.store.get<any>("tickets", "tic_1")!.notes.length, 1);
});

test("a new ticket in the bulk target set invalidates the old approval before any send", async () => {
  const w = world(),
    before = w.store.all("emails").length;
  const p = compiled([
    action("s1", "M47.A03", { status: "open" }),
    each("s2", "$s1.items", [
      ["M47.A08", { ticketId: "$item.id", body: "Status update" }],
    ]),
  ]);
  const first = await execute(p, registry, w, {
    executionId: "changed-ticket-set",
  });
  w.f.ticket({ title: "New export issue" });
  const changed = await execute(p, registry, w, {
    executionId: "changed-ticket-set",
    approvals: [first.pending!],
  });
  assert.equal(changed.status, "awaiting_confirmation");
  assert.equal(changed.pending!.changed, true);
  assert.equal(changed.pending!.count, first.pending!.count + 1);
  assert.equal(w.store.all("emails").length, before);
});
