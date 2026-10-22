import assert from "node:assert/strict";
import { test } from "node:test";
import { Price } from "../m26-prices/schema.js";
import { Product } from "../m25-products/schema.js";
import { failure, testWorld, type TestWorld } from "../../testkit.js";

function catalog(w: TestWorld, over: Partial<Omit<Price, "id" | "productId">> = {}) {
  const now = w.f.now();
  const product = w.f.make("products", "prd", Product, {
    name: "Plan",
    description: null,
    sku: null,
    inventory: null,
    variants: [],
    taxCategory: null,
    defaultPriceId: null,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const price = w.f.make("prices", "prc", Price, {
    productId: product.id,
    label: "Monthly",
    amount: 25,
    currency: "USD",
    interval: "month",
    intervalCount: 1,
    trialDays: 0,
    isDefault: false,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...over,
  });
  return { product, price };
}

async function liveSubscription() {
  const w = await testWorld();
  const { price } = catalog(w);
  const sub = w.call("M30.A01", { contactId: w.f.contact().id, priceId: price.id });
  return { w, price, sub };
}

// A canceled subscription: 2 x $15, previewed before it was canceled.
async function canceledSubscription() {
  const w = await testWorld();
  const { price, product } = catalog(w, { amount: 15 });
  const sub = w.call("M30.A01", { contactId: w.f.contact().id, priceId: price.id, quantity: 2 });
  return { w, product, sub };
}

test("M30.A01 create refuses an unknown contact", async () => {
  const { w, price } = await liveSubscription();
  assert.equal(failure(() => w.call("M30.A01", { contactId: "ct_99999", priceId: price.id })).code, "NOT_FOUND");
});

test("M30.A04 change price refuses the price it already has", async () => {
  const { w, price, sub } = await liveSubscription();
  assert.equal(failure(() => w.call("M30.A04", { subscriptionId: sub.id, priceId: price.id })).code, "CONFLICT");
});

test("M30.A05 quantity refuses a no-op", async () => {
  const { w, sub } = await liveSubscription();
  assert.equal(failure(() => w.call("M30.A05", { subscriptionId: sub.id, quantity: sub.quantity })).code, "CONFLICT");
});

test("M30.A06 trial end refuses a no-op", async () => {
  const { w, sub } = await liveSubscription();
  const trialEnd = w.f.at(3);
  w.call("M30.A06", { subscriptionId: sub.id, trialEnd });
  assert.equal(failure(() => w.call("M30.A06", { subscriptionId: sub.id, trialEnd })).code, "CONFLICT");
});

test("M30.A07 pause refuses a subscription that is already paused", async () => {
  const { w, sub } = await liveSubscription();
  w.call("M30.A07", { subscriptionId: sub.id });
  assert.equal(failure(() => w.call("M30.A07", { subscriptionId: sub.id })).code, "CONFLICT");
});

test("M30.A08 resume refuses a subscription that is not paused", async () => {
  const { w, sub } = await liveSubscription();
  w.call("M30.A07", { subscriptionId: sub.id });
  w.call("M30.A08", { subscriptionId: sub.id });
  assert.equal(failure(() => w.call("M30.A08", { subscriptionId: sub.id })).code, "CONFLICT");
});

test("M30.A09 cancel needs billing.manage", async () => {
  const { w, sub } = await liveSubscription();
  const sales = w.f.user({ roles: ["sales"] });
  assert.equal(failure(() => w.call("M30.A09", { subscriptionId: sub.id, reason: "no" }, sales.id)).code, "PERMISSION");
});

test("M30.A02 unknown input field is INVALID", async () => {
  const { w, sub } = await liveSubscription();
  assert.equal(failure(() => w.call("M30.A02", { subscriptionId: sub.id, madeUp: 1 })).code, "INVALID");
});

test("M30.A01 a one-time price is refused", async () => {
  const w = await testWorld();
  const once = catalog(w, { interval: "one_time", intervalCount: 1, label: "Once" });
  const refused = failure(() => w.call("M30.A01", { contactId: w.f.contact().id, priceId: once.price.id }));
  assert.equal(refused.code, "CONFLICT");
  assert.match(refused.message, /Choose a recurring price/);
});

test("M30.A01 a price with trial days starts trialing", async () => {
  const w = await testWorld();
  const monthly = catalog(w, { trialDays: 14, label: "Trial monthly" });
  const sub = w.call("M30.A01", { contactId: w.f.contact().id, priceId: monthly.price.id, quantity: 2 });
  assert.equal(sub.status, "trialing");
  assert.equal(sub.trialEnd, "2026-11-04T14:00:00.000Z");
  assert.equal(sub.currentPeriodStart, "2026-10-21T14:00:00.000Z");
  assert.equal(sub.currentPeriodEnd, "2026-11-21T14:00:00.000Z");
  assert.equal(sub.productId, monthly.product.id);
});

test("M30.A01 an explicit trial end overrides the price's trial days", async () => {
  const w = await testWorld();
  const explicit = catalog(w, { trialDays: 14, label: "Override" });
  const chosen = w.call("M30.A01", { contactId: w.f.contact().id, priceId: explicit.price.id, trialEnd: w.f.at(30) });
  assert.equal(chosen.status, "trialing");
  assert.equal(chosen.trialEnd, w.f.at(30));
});

test("M30.A04 change price moves to a recurring price and refuses a one-time one", async () => {
  const w = await testWorld();
  const monthly = catalog(w, { trialDays: 14, label: "Trial monthly" });
  const sub = w.call("M30.A01", { contactId: w.f.contact().id, priceId: monthly.price.id, quantity: 2 });
  const yearly = catalog(w, { interval: "year", intervalCount: 1, label: "Yearly" });
  const other = w.f.make("prices", "prc", Price, {
    productId: yearly.product.id,
    label: "Once more",
    amount: 5,
    currency: "USD",
    interval: "one_time",
    intervalCount: 1,
    trialDays: 0,
    isDefault: false,
    status: "active",
    createdAt: w.f.now(),
    updatedAt: w.f.now(),
  });
  const moved = w.call("M30.A04", { subscriptionId: sub.id, priceId: yearly.price.id });
  assert.equal(moved.priceId, yearly.price.id);
  assert.equal(failure(() => w.call("M30.A04", { subscriptionId: sub.id, priceId: other.id })).code, "CONFLICT");
});

test("M30.A08 resume while the trial is still running shifts both period bounds by the paused duration", async () => {
  const w = await testWorld();
  const trialing = w.f.subscription({
    status: "paused",
    pausedAt: "2026-10-19T14:00:00.000Z",
    currentPeriodStart: "2026-10-01T14:00:00.000Z",
    currentPeriodEnd: "2026-11-01T14:00:00.000Z",
    trialEnd: "2026-11-15T14:00:00.000Z",
  });
  const resumed = w.call("M30.A08", { subscriptionId: trialing.id });
  assert.equal(resumed.currentPeriodStart, "2026-10-03T14:00:00.000Z");
  assert.equal(resumed.currentPeriodEnd, "2026-11-03T14:00:00.000Z");
  assert.equal(resumed.pausedAt, null);
  assert.equal(resumed.status, "trialing");
});

test("M30.A08 resume after the trial has ended goes back to active", async () => {
  const w = await testWorld();
  const done = w.f.subscription({
    status: "paused",
    pausedAt: "2026-10-19T14:00:00.000Z",
    currentPeriodStart: "2026-10-01T14:00:00.000Z",
    currentPeriodEnd: "2026-11-01T14:00:00.000Z",
    trialEnd: "2026-10-20T14:00:00.000Z",
  });
  assert.equal(w.call("M30.A08", { subscriptionId: done.id }).status, "active");
});

test("M30.A07 pause stamps the time and keeps the period", async () => {
  const { w, sub: live } = await liveSubscription();
  const paused = w.call("M30.A07", { subscriptionId: live.id });
  assert.equal(paused.status, "paused");
  assert.equal(paused.pausedAt, "2026-10-21T14:00:00.000Z");
  assert.equal(paused.currentPeriodEnd, live.currentPeriodEnd);
});

test("M30.A01 a biweekly price ends the first period two weeks out", async () => {
  const w = await testWorld();
  const week = catalog(w, { interval: "week", intervalCount: 2, label: "Biweekly" });
  const bi = w.call("M30.A01", { contactId: w.f.contact().id, priceId: week.price.id });
  assert.equal(bi.currentPeriodEnd, "2026-11-04T14:00:00.000Z");
  assert.equal(bi.productId, week.product.id);
});

test("M30.A10 preview bills quantity times the price", async () => {
  const { w, product, sub } = await canceledSubscription();
  const preview = w.call("M30.A10", { subscriptionId: sub.id });
  assert.equal(preview.amount, 30);
  assert.equal(preview.currency, "USD");
  assert.equal(preview.productId, product.id);
});

test("M30.A09 cancel is terminal", async () => {
  const { w, sub } = await canceledSubscription();
  const canceled = w.call("M30.A09", { subscriptionId: sub.id, reason: "Done" });
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.cancelReason, "Done");
  assert.equal(failure(() => w.call("M30.A09", { subscriptionId: sub.id, reason: "Again" })).code, "CONFLICT");
});

test("M30.A05 and M30.A10 refuse a canceled subscription", async () => {
  const { w, sub } = await canceledSubscription();
  w.call("M30.A09", { subscriptionId: sub.id, reason: "Done" });
  assert.equal(failure(() => w.call("M30.A05", { subscriptionId: sub.id, quantity: 4 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M30.A10", { subscriptionId: sub.id })).code, "CONFLICT");
});

test("M30.A03 list still finds a canceled subscription", async () => {
  const { w, sub } = await canceledSubscription();
  w.call("M30.A09", { subscriptionId: sub.id, reason: "Done" });
  const listed = w.call("M30.A03", { contactId: sub.contactId });
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0]?.id, sub.id);
  assert.equal(w.call("M30.A02", { subscriptionId: sub.id }).status, "canceled");
});
