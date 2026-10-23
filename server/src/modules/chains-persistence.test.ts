import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_NOW, frozenClock } from "../store/clock.js";
import { Store } from "../store/db.js";
import { Fixtures } from "../store/fixtures.js";
import { seed } from "../store/seed.js";
import { call, registry } from "../testkit.js";

// One write from many modules against a real SQLite file: close it, reopen it, and the rows, the audit trail and
// the id counters must all still be there. In-memory tests can't see a table that never made it to disk.

test("writes from 18 modules survive a SQLite close and reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ask-ai-wave1-"));
  let store: Store | undefined;
  try {
    const path = join(dir, "chains.db");
    const clock = frozenClock(DEFAULT_NOW);
    const reg = await registry();
    store = new Store(path);
    seed(store, clock);
    const w = { store, clock, f: new Fixtures(store, clock) };
    const run = (id: string, args: Record<string, unknown>): any => call(reg, w, id, args);
    const contact = w.f.contact();

    const company = run("M02.A01", { name: "Persisted Co" });
    const calendar = run("M20.A01", { name: "Intro calls", timezone: "America/Chicago", visibility: "public" });
    const form = run("M18.A01", { name: "Persisted form" });
    const survey = run("M19.A01", { name: "Persisted survey" });
    const workflow = run("M16.A01", { name: "Persisted workflow" });
    const website = run("M35.A01", { name: "Persisted site" });

    const product = run("M25.A01", { name: "Persisted widget", inventory: 4 });
    const price = run("M26.A01", { productId: product.id, label: "Each", amount: 25 });
    const coupon = run("M31.A01", { code: "KEEP", discount: { type: "percent", value: 10 } });
    run("M34.A01", { name: "Persisted tax", rate: 5, region: "US-CA" });
    const order = run("M32.A01", { contactId: contact.id });
    run("M32.A04", { orderId: order.id, productId: product.id, priceId: price.id, quantity: 2 });
    run("M32.A07", { orderId: order.id, couponId: coupon.id });
    const submitted = run("M32.A08", { orderId: order.id });

    const quote = run("M27.A01", { contactId: contact.id });
    run("M27.A04", { quoteId: quote.id, description: "Work", unitPrice: 80, quantity: 1 });
    const payment = run("M29.A04", { contactId: contact.id, amount: 30, method: "card" });
    const refund = run("M33.A01", { paymentId: payment.id, amount: 10, reason: "Persisted" });

    const event = run("M24.A01", { title: "Persisted event", startsAt: w.f.at(7), endsAt: w.f.at(8), capacity: 5 });
    const registration = run("M24.A06", { eventId: event.id, contactId: contact.id });

    const course = run("M40.A01", { title: "Persisted course" });
    const community = run("M43.A01", { name: "Persisted community" });
    const plan = run("M44.A01", { name: "Persisted plan", entitlements: [{ type: "community", targetId: community.id }] });
    const membership = run("M44.A07", { planId: plan.id, contactId: contact.id });

    const audit = store.audit();
    const expected = store.tables().map((table) => [table, store!.all(table)] as const);
    store.close();
    store = new Store(path);

    for (const [table, rows] of expected) assert.deepEqual(store.all(table), rows, table);
    assert.deepEqual(store.audit(), audit);
    assert.ok(audit.length >= 20, "every write left an audit entry");

    assert.equal(store.get<any>("companies", company.id)?.name, "Persisted Co");
    assert.equal(store.get<any>("calendars", calendar.id)?.timezone, "America/Chicago");
    assert.equal(store.get<any>("forms", form.id)?.status, "draft");
    assert.equal(store.get<any>("surveys", survey.id)?.name, "Persisted survey");
    assert.equal(store.get<any>("workflows", workflow.id)?.status, "draft");
    assert.equal(store.get<any>("websites", website.id)?.name, "Persisted site");
    assert.equal(store.get<any>("products", product.id)?.inventory, 2);
    assert.equal(store.get<any>("coupons", coupon.id)?.redemptions, 1);
    assert.equal(store.get<any>("orders", order.id)?.status, "submitted");
    assert.equal(store.get<any>("invoices", submitted.invoiceId)?.status, "open");
    assert.equal(store.get<any>("quotes", quote.id)?.total, 80);
    assert.equal(store.get<any>("refunds", refund.id)?.status, "requested");
    assert.equal(store.get<any>("event_registrations", registration.id)?.status, "registered");
    assert.equal(store.get<any>("courses", course.id)?.title, "Persisted course");
    assert.equal(store.get<any>("memberships", membership.id)?.status, "active");
    assert.equal(store.find<any>("community_members", (m) => m.communityId === community.id).length, 1);

    // New ids continue after the highest persisted one instead of colliding with it.
    const later = new Fixtures(store, clock).company();
    assert.notEqual(later.id, company.id);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
