import assert from "node:assert/strict";
import { test } from "node:test";
import { call, failure, registry, testWorld } from "../../testkit.js";
import { frozenClock } from "../../store/clock.js";
import { mentions } from "../../retrieval/mentions.js";

test("create and search preserve requester identity, defaults, totals and filters", async () => {
  const w = await testWorld(),
    c = w.f.contact();
  assert.equal(
    failure(() =>
      w.call("M47.A01", { title: "Missing requester", body: "Details" }),
    ).code,
    "INVALID",
  );
  assert.equal(
    failure(() =>
      w.call("M47.A01", {
        title: "Mismatch",
        body: "Details",
        contactId: c.id,
        requesterEmail: "other@example.com",
      }),
    ).code,
    "INVALID",
  );
  const t = w.call("M47.A01", {
    title: "Export problem",
    body: "Detailed issue",
    contactId: c.id,
  });
  assert.equal(t.status, "open");
  assert.equal(t.priority, "normal");
  assert.equal(t.requesterEmail, c.email);
  w.f.ticket({ contactId: c.id, title: "Export problem 2" });
  const r = w.call("M47.A03", {
    contactId: c.id,
    query: "Export",
    status: "open",
    limit: 1,
  });
  assert.equal(r.total, 2);
  assert.equal(r.items.length, 1);
  assert.equal(w.call("M47.A02", { ticketId: t.id }).personName, c.name);
});
test("search words may span title, body and who asked, in any order", async () => {
  const w = await testWorld(),
    c = w.f.contact({ name: "Marcus Quillfeather" }),
    t = w.f.ticket({ contactId: c.id, title: "Receipt download fails", body: "The link is broken" });
  w.f.ticket({ title: "Receipt download fails" });
  const ids = (query: string) => w.call("M47.A03", { query }).items.map((x: { id: string }) => x.id);
  assert.deepEqual(ids("Marcus Quillfeather Receipt"), [t.id]);
  assert.deepEqual(ids("receipt marcus"), [t.id]);
  assert.deepEqual(ids("Marcus broken link"), [t.id]);
  assert.deepEqual(ids("Marcus invoice"), []);
  // Naming the record type is not part of what the ticket says.
  assert.deepEqual(ids("Marcus receipt support ticket"), [t.id]);
});
test("owner must be active, available and eligible; unrelated ownership is untouched", async () => {
  const w = await testWorld(),
    t = w.f.ticket();
  for (const ownerId of ["us_3", "us_4", "us_7", "us_9"]) {
    assert.equal(
      failure(() => w.call("M47.A04", { ticketId: t.id, ownerId })).code,
      "CONFLICT",
    );
  }
  assert.equal(
    failure(() => w.call("M47.A04", { ticketId: t.id, ownerId: "us_99999" }))
      .code,
    "NOT_FOUND",
  );
  const r = w.call("M47.A04", { ticketId: t.id, ownerId: "us_6" });
  assert.equal(r.ownerId, "us_6");
  assert.equal(
    failure(() => w.call("M47.A04", { ticketId: t.id, ownerId: "us_6" })).code,
    "CONFLICT",
  );
});
test("ticket status matrix is explicit, reopens retain SLA and clear active closure timestamps", async () => {
  const allowed = {
    open: ["in_progress", "resolved", "closed"],
    in_progress: ["open", "resolved", "closed"],
    resolved: ["open", "closed"],
    closed: ["open"],
  };
  for (const [from, tos] of Object.entries(allowed))
    for (const to of Object.keys(allowed)) {
      const w = await testWorld(),
        t = w.f.ticket({ status: from as any });
      if (tos.includes(to)) {
        const r = w.call("M47.A06", { ticketId: t.id, status: to });
        assert.equal(r.status, to);
        assert.equal(r.history.at(-1).from, from);
      } else
        assert.equal(
          failure(() => w.call("M47.A06", { ticketId: t.id, status: to })).code,
          "CONFLICT",
        );
    }
  const w = await testWorld(),
    t = w.f.ticket({
      status: "closed",
      closedAt: w.f.at(-1),
      resolvedAt: w.f.at(-2),
      firstResponseAt: w.f.at(-3),
      firstResponseDueAt: w.f.at(-3, 16),
    });
  const r = w.call("M47.A06", { ticketId: t.id, status: "open" });
  assert.equal(r.closedAt, null);
  assert.equal(r.resolvedAt, null);
  assert.equal(r.firstResponseAt, t.firstResponseAt);
});
test("resolved and closed tickets require reopening for writes/replies; internal notes remain private", async () => {
  for (const status of ["resolved", "closed"] as const) {
    const w = await testWorld(),
      t = w.f.ticket({ status });
    for (const [id, args] of [
      ["M47.A04", { ownerId: "us_6" }],
      ["M47.A05", { priority: "urgent" }],
      ["M47.A08", { body: "Hello" }],
      ["M47.A09", { contactId: "ct_35" }],
    ] as const)
      assert.equal(
        failure(() => w.call(id, { ticketId: t.id, ...args })).code,
        "CONFLICT",
      );
    const r = w.call("M47.A07", {
      ticketId: t.id,
      body: "Private investigation",
    });
    assert.equal(r.status, status);
    assert.equal(r.firstResponseAt, null);
    assert.equal(r.notes[0].body, "Private investigation");
  }
});
test("reply atomically updates ticket, email, conversation and frozen first-response deadline", async () => {
  const w = await testWorld(),
    c = w.f.contact(),
    t = w.f.ticket({ contactId: c.id });
  const r = w.call("M47.A08", { ticketId: t.id, body: "We are investigating" });
  assert.equal(r.status, "in_progress");
  assert.equal(r.firstResponseAt, w.clock.now().toISOString());
  assert.equal(r.replies.length, 1);
  const e = w.call("M13.A06", { emailId: r.replies[0].emailId });
  assert.equal(e.kind, "ticket_reply");
  assert.equal(e.status, "delivered");
  assert.ok(e.conversationId);
  const due = r.firstResponseDueAt;
  w.call("M47.A05", { ticketId: t.id, priority: "urgent" });
  w.call("M47.A08", { ticketId: t.id, body: "An update" });
  assert.equal(w.call("M47.A02", { ticketId: t.id }).firstResponseDueAt, due);
  assert.equal(w.call("M47.A10", { ticketId: t.id }).targetHours, 24);
});
test("transactional bypass permits opt-outs/DND but never missing or invalid email", async () => {
  const w = await testWorld(),
    c = w.f.contact({
      preferences: { email: false, sms: true, call: true, dnd: true },
    });
  w.call("M13.A10", { contactId: c.id });
  const t = w.f.ticket({ contactId: c.id });
  assert.equal(
    w.call("M47.A08", { ticketId: t.id, body: "Support update" }).status,
    "in_progress",
  );
  for (const email of [null, "not-an-email"]) {
    const ctx = await testWorld(),
      c = ctx.f.contact({ email }),
      t = ctx.f.ticket({ contactId: c.id });
    const emails = ctx.store.all("emails"),
      convs = ctx.store.all("conversations"),
      audit = ctx.store.audit();
    const sla = ctx.call("M47.A10", { ticketId: t.id });
    failure(() => ctx.call("M47.A08", { ticketId: t.id, body: "Hello" }));
    assert.deepEqual(ctx.store.get("tickets", t.id), t);
    assert.deepEqual(ctx.store.all("emails"), emails);
    assert.deepEqual(ctx.store.all("conversations"), convs);
    assert.deepEqual(ctx.store.audit(), audit);
    assert.deepEqual(ctx.call("M47.A10", { ticketId: t.id }), sla);
  }
});
test("a bounced reply stays as a trail but is not a first response, and a later good one is", async () => {
  const w = await testWorld(),
    c = w.f.contact({ email: "unreachable@bounce.example" }),
    t = w.f.ticket({ contactId: c.id });
  const r = w.call("M47.A08", { ticketId: t.id, body: "Hello" });
  assert.equal(r.status, "open", "the requester has not been answered");
  assert.equal(r.firstResponseAt, null);
  assert.equal(r.firstResponseDueAt, null);
  assert.deepEqual(r.history, []);
  assert.equal(r.replies.length, 1);
  assert.match(r.replies[0].failureReason, /hard bounce/);
  const e = w.call("M13.A06", { emailId: r.replies[0].emailId });
  assert.equal(e.kind, "ticket_reply");
  assert.equal(e.status, "bounced");
  assert.equal(w.call("M47.A10", { ticketId: t.id }).firstResponseAt ?? null, null);
  // Fixing the address and replying again records the real first response next to the failed one.
  w.call("M47.A09", { ticketId: t.id, contactId: w.f.contact().id });
  const ok = w.call("M47.A08", { ticketId: t.id, body: "Hello again" });
  assert.equal(ok.status, "in_progress");
  assert.equal(ok.firstResponseAt, w.clock.now().toISOString());
  assert.equal(ok.replies.length, 2);
  assert.equal(ok.replies[1].failureReason, undefined);
});
test("unlinked requester replies use their own address without touching another person's conversation", async () => {
  const w = await testWorld(),
    t = w.f.ticket({ contactId: null, requesterEmail: "guest@example.com" });
  const before = w.store.all("conversations");
  const r = w.call("M47.A08", { ticketId: t.id, body: "Welcome" });
  assert.equal(
    w.call("M13.A06", { emailId: r.replies[0].emailId }).conversationId,
    null,
  );
  assert.deepEqual(w.store.all("conversations"), before);
});
test("contact linking changes requester address, refuses inactive contacts and no-ops", async () => {
  const w = await testWorld(),
    t = w.f.ticket(),
    c = w.f.contact();
  const r = w.call("M47.A09", { ticketId: t.id, contactId: c.id });
  assert.equal(r.requesterEmail, c.email);
  assert.equal(
    failure(() => w.call("M47.A09", { ticketId: t.id, contactId: c.id })).code,
    "CONFLICT",
  );
  assert.equal(
    failure(() => w.call("M47.A09", { ticketId: t.id, contactId: "ct_34" }))
      .code,
    "CONFLICT",
  );
});
test("linking a contact with no email keeps the ticket's requester address", async () => {
  const w = await testWorld(),
    t = w.f.ticket(),
    c = w.f.contact({ email: null });
  assert.ok(t.requesterEmail);
  assert.equal(w.call("M47.A09", { ticketId: t.id, contactId: c.id }).requesterEmail, t.requesterEmail);
});
test("SLA is elapsed first response, before/at/after deadlines for every priority", async () => {
  const w = await testWorld(),
    reg = await registry();
  const created = "2026-10-31T15:00:00.000Z";
  for (const [priority, hours] of Object.entries({
    urgent: 1,
    high: 4,
    normal: 24,
    low: 72,
  })) {
    const t = w.f.ticket({ createdAt: created, priority: priority as any });
    const due = Date.parse(created) + hours * 3_600_000;
    for (const delta of [-1, 0, 1]) {
      const ctx = {
        ...w,
        clock: frozenClock(new Date(due + delta).toISOString()),
      };
      const s = call(reg, ctx, "M47.A10", { ticketId: t.id }) as any;
      assert.equal(s.status, delta > 0 ? "breached" : "pending");
      assert.equal(s.policy, "first_response");
      assert.equal(s.targetHours, hours);
    }
    const s = call(
      reg,
      { ...w, clock: frozenClock(new Date(due).toISOString()) },
      "M47.A08",
      { ticketId: t.id, body: "At the deadline" },
    ) as any;
    assert.equal(s.firstResponseAt, new Date(due).toISOString());
    assert.equal(w.call("M47.A10", { ticketId: t.id }).status, "met");
  }
});
test("SLA covers late reply, priority recalculation, reopening, closing without response and DST", async () => {
  const w = await testWorld(),
    t = w.f.ticket({ createdAt: w.f.at(-2), priority: "normal" });
  assert.equal(w.call("M47.A10", { ticketId: t.id }).status, "breached");
  w.call("M47.A05", { ticketId: t.id, priority: "low" });
  assert.equal(w.call("M47.A10", { ticketId: t.id }).status, "pending");
  w.call("M47.A06", { ticketId: t.id, status: "closed" });
  assert.equal(w.call("M47.A10", { ticketId: t.id }).firstResponseAt, null);
  w.call("M47.A06", { ticketId: t.id, status: "open" });
  assert.equal(
    w.call("M47.A10", { ticketId: t.id }).dueAt,
    new Date(Date.parse(t.createdAt) + 72 * 3_600_000).toISOString(),
  );
  const late = w.f.ticket({ createdAt: w.f.at(-2), priority: "urgent" });
  w.call("M47.A08", { ticketId: late.id, body: "Late response" });
  assert.equal(w.call("M47.A10", { ticketId: late.id }).status, "breached");
  const dst = w.f.ticket({
    createdAt: "2026-10-31T15:00:00.000Z",
    priority: "normal",
  });
  assert.equal(
    w.call("M47.A10", { ticketId: dst.id }).dueAt,
    "2026-11-01T15:00:00.000Z",
  );
});
test("ticket send roles, invalid actors and fixture faults share the normal invocation path", async () => {
  for (const role of [
    "admin",
    "manager",
    "support",
    "marketing",
    "sales",
    "billing",
  ] as const) {
    const w = await testWorld(),
      u = w.f.user({ roles: [role] }),
      t = w.f.ticket();
    if (["admin", "manager", "support"].includes(role))
      w.call("M47.A08", { ticketId: t.id, body: "Hello" }, u.id);
    else
      assert.equal(
        failure(() =>
          w.call("M47.A08", { ticketId: t.id, body: "Hello" }, u.id),
        ).code,
        "PERMISSION",
      );
  }
  const w = await testWorld(),
    u = w.f.user({ roles: ["support"], status: "deactivated" }),
    t = w.f.ticket();
  assert.equal(
    failure(() => w.call("M47.A08", { ticketId: t.id, body: "Hello" }, u.id))
      .code,
    "PERMISSION",
  );
  w.f.fault("M47.A08", { code: "UNAVAILABLE", times: 1 });
  assert.equal(
    failure(() => w.call("M47.A08", { ticketId: t.id, body: "Hello" })).code,
    "UNAVAILABLE",
  );
  assert.equal(
    w.call("M47.A08", { ticketId: t.id, body: "Hello" }).status,
    "in_progress",
  );
});
test("name resolution keeps contact-only names out of ticket mentions and asks on duplicate titles", async () => {
  const w = await testWorld(),
    reg = await registry();
  assert.deepEqual(
    mentions("Show Elodie Mercer's email", reg, w.store).map((x) => x.entity),
    ["contact"],
  );
  w.f.ticket({ title: "Duplicate issue" });
  w.f.ticket({ title: "Duplicate issue" });
  assert.equal(reg.resolver("ticket")!(w.store, "Duplicate issue").length, 2);
  assert.equal(
    reg.resolver("ticket")!(w.store, "Receipt download").length,
    1,
    "resolved tickets are still addressable for reopening",
  );
});
