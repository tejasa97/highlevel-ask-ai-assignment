import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("guards: archived product, no-op edits, trial on one_time, default archive, unknown field", async () => {
  const w = await testWorld();
  const archived = w.f.product({ status: "archived" });
  assert.equal(failure(() => w.call("M26.A01", { productId: archived.id, label: "X", amount: 1 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M26.A01", { productId: w.f.product().id, label: "X", amount: 1, madeUp: 1 })).code, "INVALID");
  const price = w.f.price({ label: "Same", amount: 10, currency: "USD", interval: "one_time", intervalCount: 1 });
  assert.equal(failure(() => w.call("M26.A04", { priceId: price.id, label: "Same" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M26.A05", { priceId: price.id, amount: 10 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M26.A06", { priceId: price.id, currency: "USD" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M26.A07", { priceId: price.id, interval: "one_time" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M26.A08", { priceId: price.id, trialDays: 14 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M26.A09", { priceId: price.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M26.A10", { priceId: price.id })).code, "CONFLICT");
});

test("the first price is the only default; a second default unsets it and updates the product", async () => {
  const w = await testWorld();
  const product = w.f.product();
  const first = w.call("M26.A01", { productId: product.id, label: "Standard", amount: 20 });
  const second = w.call("M26.A01", { productId: product.id, label: "Wholesale", amount: 15, currency: "EUR" });
  assert.equal(second.currency, "EUR");
  assert.deepEqual([first.isDefault, second.isDefault], [true, false]);
  assert.equal(w.call("M25.A02", { productId: product.id }).defaultPriceId, first.id);
  const chosen = w.call("M26.A09", { priceId: second.id });
  assert.equal(chosen.isDefault, true);
  assert.equal(w.call("M26.A02", { priceId: first.id }).isDefault, false);
  assert.equal(w.call("M25.A02", { productId: product.id }).defaultPriceId, second.id);
  assert.equal(failure(() => w.call("M26.A10", { priceId: second.id })).code, "CONFLICT");
  const archived = w.call("M26.A10", { priceId: first.id });
  assert.equal(archived.status, "archived");
  const labels = (w.call("M26.A03", { productId: product.id }).items as { label: string }[]).map((p) => p.label);
  assert.deepEqual(labels, ["Standard", "Wholesale"]);
});

test("amount rounds to cents; one_time can't keep a trial; recurring trial can be set", async () => {
  const w = await testWorld();
  const product = w.f.product();
  const price = w.call("M26.A01", { productId: product.id, label: "Monthly", amount: 10.005, interval: "month", intervalCount: 2 });
  assert.equal(price.amount, 10.01);
  assert.deepEqual([price.interval, price.intervalCount, price.trialDays], ["month", 2, 0]);
  const trialed = w.call("M26.A08", { priceId: price.id, trialDays: 14 });
  assert.equal(trialed.trialDays, 14);
  assert.equal(failure(() => w.call("M26.A07", { priceId: price.id, interval: "one_time" })).code, "CONFLICT");
  w.call("M26.A08", { priceId: price.id, trialDays: 0 });
  const once = w.call("M26.A07", { priceId: price.id, interval: "one_time" });
  assert.deepEqual([once.interval, once.intervalCount], ["one_time", 1]);
  assert.equal(w.call("M26.A04", { priceId: price.id, label: "Once" }).label, "Once");
  assert.equal(w.call("M26.A06", { priceId: price.id, currency: "GBP" }).currency, "GBP");
});
