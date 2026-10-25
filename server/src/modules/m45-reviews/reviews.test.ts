import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("requests: create draft, send once, audit/email/conversation agree, sent requests cannot cancel", async () => {
  const w = await testWorld();
  const c = w.f.contact();
  const r = w.call("M45.A01", {
    contactId: c.id,
    subject: "Feedback",
    body: "How was it?",
  });
  assert.equal(r.status, "draft");
  assert.equal(r.emailId, null);
  const sent = w.call("M45.A02", { requestId: r.id });
  assert.equal(sent.status, "sent");
  const e = w.call("M13.A06", { emailId: sent.emailId });
  assert.equal(e.kind, "review_request");
  assert.equal(e.status, "delivered");
  assert.ok(e.conversationId);
  assert.equal(
    failure(() => w.call("M45.A02", { requestId: r.id })).code,
    "CONFLICT",
  );
  assert.equal(
    failure(() => w.call("M45.A03", { requestId: r.id })).code,
    "CONFLICT",
  );
  assert.equal(w.store.audit().filter((x) => x.action === "M45.A02").length, 1);
});
test("draft cancellation is persistent and cannot be repeated", async () => {
  const w = await testWorld(),
    r = w.f.reviewRequest();
  assert.equal(w.call("M45.A03", { requestId: r.id }).status, "cancelled");
  assert.equal(
    failure(() => w.call("M45.A03", { requestId: r.id })).code,
    "CONFLICT",
  );
  assert.equal(
    failure(() => w.call("M45.A02", { requestId: r.id })).code,
    "CONFLICT",
  );
});
test("review requests respect marketing consent and reachability; failures roll back", async () => {
  for (const patch of [
    { email: null },
    { preferences: { email: false, sms: true, call: true, dnd: false } },
    { preferences: { email: true, sms: true, call: true, dnd: true } },
  ]) {
    const w = await testWorld(),
      c = w.f.contact(patch),
      r = w.f.reviewRequest({ contactId: c.id });
    const n = w.store.all("emails").length,
      a = w.store.audit().length;
    assert.ok(failure(() => w.call("M45.A02", { requestId: r.id })));
    assert.equal(w.store.all("emails").length, n);
    assert.equal(w.store.audit().length, a);
    assert.equal(w.store.get<any>("review_requests", r.id).status, "draft");
  }
  const w = await testWorld(),
    c = w.f.contact();
  w.call("M13.A10", { contactId: c.id });
  const r = w.f.reviewRequest({ contactId: c.id });
  assert.match(
    failure(() => w.call("M45.A02", { requestId: r.id })).message,
    /unsubscribed/,
  );
});
test("a bounced review request is kept as failed with its email, is not sent, and can be sent again", async () => {
  const w = await testWorld(),
    c = w.f.contact({ email: "bad@bounce.example" }),
    r = w.f.reviewRequest({ contactId: c.id });
  const failed = w.call("M45.A02", { requestId: r.id });
  assert.equal(failed.status, "failed");
  assert.equal(failed.sentAt, null);
  assert.match(failed.failureReason, /hard bounce/);
  assert.equal(w.call("M13.A06", { emailId: failed.emailId }).status, "bounced");
  assert.equal(w.call("M45.A04", { status: "failed" }).items.length, 1);
  assert.equal(
    failure(() => w.call("M45.A05", { requestId: r.id, rating: 5, body: "Great" })).code,
    "CONFLICT",
    "a request that never reached the customer cannot be fulfilled",
  );
  // The address is fixed: the same request goes out, clears the failure and gets a new email.
  w.store.update("contacts", c.id, { email: "good@example.com" });
  const sent = w.call("M45.A02", { requestId: r.id });
  assert.equal(sent.status, "sent");
  assert.equal(sent.failureReason, null);
  assert.notEqual(sent.emailId, failed.emailId);
  assert.ok(sent.sentAt);
  // A failed request can also be given up on.
  const g = w.f.reviewRequest({ contactId: w.f.contact({ email: "x@bounce.example" }).id });
  w.call("M45.A02", { requestId: g.id });
  assert.equal(w.call("M45.A03", { requestId: g.id }).status, "cancelled");
});
test("record review fulfills a sent request once, validates contact, rating and content", async () => {
  const w = await testWorld(),
    r = w.f.reviewRequest({ status: "sent", sentAt: w.f.at(-1) });
  assert.equal(
    failure(() =>
      w.call("M45.A05", {
        requestId: r.id,
        contactId: w.f.contact().id,
        rating: 5,
        body: "Good",
      }),
    ).code,
    "INVALID",
  );
  const v = w.call("M45.A05", { requestId: r.id, rating: 4, body: "Helpful" });
  assert.equal(v.contactId, r.contactId);
  assert.equal(w.store.get<any>("review_requests", r.id).reviewId, v.id);
  assert.equal(
    failure(() =>
      w.call("M45.A05", { requestId: r.id, rating: 4, body: "Again" }),
    ).code,
    "CONFLICT",
  );
  for (const rating of [0, 6, 2.5])
    assert.equal(
      failure(() =>
        w.call("M45.A05", { contactId: r.contactId, rating, body: "Good" }),
      ).code,
      "INVALID",
    );
  assert.equal(
    failure(() =>
      w.call("M45.A05", { contactId: r.contactId, rating: 4, body: "  " }),
    ).code,
    "INVALID",
  );
  assert.equal(
    failure(() => w.call("M45.A05", { rating: 4, body: "x" })).code,
    "INVALID",
  );
  assert.equal(
    failure(() =>
      w.call("M45.A05", {
        requestId: w.f.reviewRequest().id,
        rating: 4,
        body: "x",
      }),
    ).code,
    "CONFLICT",
  );
});
test("list/search/get honor filters, totals and repeat reviewers without assuming unique names", async () => {
  const w = await testWorld(),
    c = w.f.contact();
  for (const rating of [1, 2, 5])
    w.f.review({ contactId: c.id, rating, body: "Specific feedback" });
  const found = w.call("M45.A06", {
    contactId: c.id,
    maxRating: 2,
    query: "specific",
    limit: 1,
  });
  assert.equal(found.total, 2);
  assert.equal(found.items.length, 1);
  assert.equal(
    w.call("M45.A07", { reviewId: found.items[0].id }).reviewerName,
    c.name,
  );
  w.f.reviewRequest({ contactId: c.id });
  w.f.reviewRequest({ contactId: c.id, status: "sent" });
  assert.equal(
    w.call("M45.A04", { contactId: c.id, status: "draft" }).total,
    1,
  );
  assert.equal(
    failure(() => w.call("M45.A06", { minRating: 5, maxRating: 1 })).code,
    "INVALID",
  );
  assert.equal(w.call("M45.A06", { query: "no-such-review" }).total, 0);
});
test("draft and publish are distinct; publication needs text and cannot repeat", async () => {
  const w = await testWorld(),
    r = w.f.review();
  assert.equal(
    failure(() => w.call("M45.A09", { reviewId: r.id })).code,
    "INVALID",
  );
  const d = w.call("M45.A08", { reviewId: r.id, body: "Thank you" });
  assert.equal(d.publishedAt, null);
  assert.equal(
    failure(() => w.call("M45.A08", { reviewId: r.id, body: "Thank you" }))
      .code,
    "CONFLICT",
  );
  assert.equal(
    w.call("M45.A09", { reviewId: r.id }).publishedResponse,
    "Thank you",
  );
  assert.equal(
    failure(() => w.call("M45.A09", { reviewId: r.id, body: "Again" })).code,
    "CONFLICT",
  );
  assert.equal(
    failure(() => w.call("M45.A08", { reviewId: r.id, body: "Again" })).code,
    "CONFLICT",
  );
});
test("rating summary calculates distribution; no reviews gives null mean", async () => {
  const w = await testWorld(),
    c = w.f.contact();
  assert.equal(w.call("M45.A10", { contactId: c.id }).averageRating, null);
  for (const rating of [2, 3, 5]) w.f.review({ contactId: c.id, rating });
  const s = w.call("M45.A10", { contactId: c.id });
  assert.equal(s.count, 3);
  assert.equal(s.averageRating, 3.33);
  assert.equal(
    s.distribution.reduce((n: any, x: any) => n + x.count, 0),
    3,
  );
});
test("reputation external/destructive permissions are selective; reads and drafts stay usable", async () => {
  for (const roles of [
    ["admin"],
    ["manager"],
    ["marketing"],
    ["support"],
    ["sales"],
    ["billing"],
  ] as const) {
    const w = await testWorld(),
      u = w.f.user({ roles: [...roles] }),
      r = w.f.reviewRequest(),
      v = w.f.review({ responseDraft: "Thanks" });
    const allowed = roles.some((x) =>
      ["admin", "manager", "marketing"].includes(x),
    );
    for (const [id, args] of [
      ["M45.A02", { requestId: r.id }],
      ["M45.A09", { reviewId: v.id }],
    ] as const) {
      if (allowed) w.call(id, args, u.id);
      else
        assert.equal(failure(() => w.call(id, args, u.id)).code, "PERMISSION");
    }
    w.call("M45.A07", { reviewId: v.id }, u.id);
  }
  const w = await testWorld(),
    u = w.f.user({ roles: ["marketing"], status: "deactivated" }),
    r = w.f.reviewRequest();
  assert.equal(
    failure(() => w.call("M45.A02", { requestId: r.id }, u.id)).code,
    "PERMISSION",
  );
});
