import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("module-owned email preview/send/schedule agree: use owning action; refusal has no side effects", async () => {
  for (const kind of ["review_request", "ticket_reply"] as const) {
    const w = await testWorld(),
      c = w.f.contact(),
      e = w.f.email({
        contactId: c.id,
        to: c.email!,
        kind,
        status: "draft",
        sentAt: null,
        deliveredAt: null,
      });
    const route = kind === "review_request" ? "M45.A02" : "M47.A08";
    const preview = w.call("M13.A02", { emailId: e.id });
    assert.equal(preview.canSend, false);
    assert.ok(preview.blockers.some((x: string) => x.includes(route)));
    const before = w.store.audit(),
      convs = w.store.all("conversations"),
      tickets = w.store.all("tickets"),
      requests = w.store.all("review_requests");
    for (const [id, args] of [
      ["M13.A03", {}],
      ["M13.A04", { sendAt: w.f.at(1) }],
    ] as const) {
      const err = failure(() => w.call(id, { emailId: e.id, ...args }));
      assert.equal(err.code, "CONFLICT");
      assert.ok(err.message.includes(route));
    }
    assert.deepEqual(w.store.get("emails", e.id), e);
    assert.deepEqual(w.store.audit(), before);
    assert.deepEqual(w.store.all("conversations"), convs);
    assert.deepEqual(w.store.all("tickets"), tickets);
    assert.deepEqual(w.store.all("review_requests"), requests);
  }
});
