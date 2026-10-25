import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, registry, testWorld } from "../../testkit.js";

async function samePrice() {
  const w = await testWorld();
  const price = w.f.price({ label: "Same", amount: 10, currency: "USD", interval: "one_time", intervalCount: 1 });
  return { w, price };
}

// A product with a "Standard" default price and a second "Wholesale" price.
async function twoPrices() {
  const w = await testWorld();
  const product = w.f.product();
  const first = w.call("M26.A01", { productId: product.id, label: "Standard", amount: 20 });
  const second = w.call("M26.A01", { productId: product.id, label: "Wholesale", amount: 15, currency: "EUR" });
  return { w, product, first, second };
}

async function monthlyPrice() {
  const w = await testWorld();
  const product = w.f.product();
  const price = w.call("M26.A01", { productId: product.id, label: "Monthly", amount: 10.005, interval: "month", intervalCount: 2 });
  return { w, price };
}

test("M26.A01 create refuses an archived product", async () => {
  const w = await testWorld();
  const archived = w.f.product({ status: "archived" });
  assert.equal(failure(() => w.call("M26.A01", { productId: archived.id, label: "X", amount: 1 })).code, "CONFLICT");
});

test("M26.A01 unknown input field is INVALID", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M26.A01", { productId: w.f.product().id, label: "X", amount: 1, madeUp: 1 })).code, "INVALID");
});

test("M26.A04 label refuses a no-op", async () => {
  const { w, price } = await samePrice();
  assert.equal(failure(() => w.call("M26.A04", { priceId: price.id, label: "Same" })).code, "CONFLICT");
});

test("M26.A05 amount refuses a no-op", async () => {
  const { w, price } = await samePrice();
  assert.equal(failure(() => w.call("M26.A05", { priceId: price.id, amount: 10 })).code, "CONFLICT");
});

test("M26.A06 currency refuses a no-op", async () => {
  const { w, price } = await samePrice();
  assert.equal(failure(() => w.call("M26.A06", { priceId: price.id, currency: "USD" })).code, "CONFLICT");
});

test("M26.A07 interval refuses a no-op", async () => {
  const { w, price } = await samePrice();
  assert.equal(failure(() => w.call("M26.A07", { priceId: price.id, interval: "one_time" })).code, "CONFLICT");
});

test("M26.A08 a trial on a one_time price conflicts", async () => {
  const { w, price } = await samePrice();
  assert.equal(failure(() => w.call("M26.A08", { priceId: price.id, trialDays: 14 })).code, "CONFLICT");
});

test("M26.A09 making the default price the default again conflicts", async () => {
  const { w, price } = await samePrice();
  assert.equal(failure(() => w.call("M26.A09", { priceId: price.id })).code, "CONFLICT");
});

test("M26.A10 archiving the default price conflicts", async () => {
  const { w, price } = await samePrice();
  assert.equal(failure(() => w.call("M26.A10", { priceId: price.id })).code, "CONFLICT");
});

test("M26.A01 the first price is the only default and sets the product's default", async () => {
  const { w, product, first, second } = await twoPrices();
  assert.equal(second.currency, "EUR");
  assert.deepEqual([first.isDefault, second.isDefault], [true, false]);
  assert.equal(w.call("M25.A02", { productId: product.id }).defaultPriceId, first.id);
});

test("M26.A09 a second default unsets the first and updates the product", async () => {
  const { w, product, first, second } = await twoPrices();
  const chosen = w.call("M26.A09", { priceId: second.id });
  assert.equal(chosen.isDefault, true);
  assert.equal(w.call("M26.A02", { priceId: first.id }).isDefault, false);
  assert.equal(w.call("M25.A02", { productId: product.id }).defaultPriceId, second.id);
});

test("M26.A10 only a price that is not the default can be archived", async () => {
  const { w, product, first, second } = await twoPrices();
  w.call("M26.A09", { priceId: second.id });
  assert.equal(failure(() => w.call("M26.A10", { priceId: second.id })).code, "CONFLICT");
  const archived = w.call("M26.A10", { priceId: first.id });
  assert.equal(archived.status, "archived");
  const labels = (w.call("M26.A03", { productId: product.id }).items as { label: string }[]).map((p) => p.label);
  assert.deepEqual(labels, ["Standard", "Wholesale"]);
});

test("M26.A01 amount rounds to cents", async () => {
  const { price } = await monthlyPrice();
  assert.equal(price.amount, 10.01);
  assert.deepEqual([price.interval, price.intervalCount, price.trialDays], ["month", 2, 0]);
});

test("M26.A08 a recurring price can take a trial", async () => {
  const { w, price } = await monthlyPrice();
  const trialed = w.call("M26.A08", { priceId: price.id, trialDays: 14 });
  assert.equal(trialed.trialDays, 14);
});

test("M26.A07 a price with a trial can't become one_time", async () => {
  const { w, price } = await monthlyPrice();
  w.call("M26.A08", { priceId: price.id, trialDays: 14 });
  assert.equal(failure(() => w.call("M26.A07", { priceId: price.id, interval: "one_time" })).code, "CONFLICT");
});

test("M26.A07 once the trial is cleared the price can become one_time", async () => {
  const { w, price } = await monthlyPrice();
  w.call("M26.A08", { priceId: price.id, trialDays: 14 });
  w.call("M26.A08", { priceId: price.id, trialDays: 0 });
  const once = w.call("M26.A07", { priceId: price.id, interval: "one_time" });
  assert.deepEqual([once.interval, once.intervalCount], ["one_time", 1]);
});

test("M26.A04 label is changed", async () => {
  const { w, price } = await monthlyPrice();
  assert.equal(w.call("M26.A04", { priceId: price.id, label: "Once" }).label, "Once");
});

test("M26.A06 currency is changed", async () => {
  const { w, price } = await monthlyPrice();
  assert.equal(w.call("M26.A06", { priceId: price.id, currency: "GBP" }).currency, "GBP");
});

test("a price is found by its product's name: the product alone picks its default, a shared label is ambiguous", async () => {
  const w = await testWorld();
  const resolve = (await registry()).resolver("price")!;
  const pro = w.f.product({ name: "Pro Plan" });
  const monthly = w.f.price({ productId: pro.id, label: "Monthly", interval: "month" });
  const yearly = w.f.price({ productId: pro.id, label: "Yearly", interval: "year", isDefault: false });
  w.f.price({ productId: w.f.product({ name: "Team" }).id, label: "Monthly", interval: "month" });
  assert.deepEqual(resolve(w.store, "Pro Plan").map((c) => c.id), [monthly.id]);
  assert.deepEqual(resolve(w.store, "Pro Plan Yearly").map((c) => c.id), [yearly.id]);
  assert.equal(resolve(w.store, "Monthly").length, 2);
});

test("a product named in the plural (\"2 Ceramic Mugs\") still finds its price", async () => {
  const w = await testWorld();
  const resolve = (await registry()).resolver("price")!;
  const mug = w.f.product({ name: "Ceramic Mug" });
  const standard = w.f.price({ productId: mug.id, label: "Standard", amount: 40 });
  assert.deepEqual(resolve(w.store, "Ceramic Mugs").map((c) => c.id), [standard.id]);
  const wholesale = w.f.price({ productId: mug.id, label: "Wholesale", amount: 30, isDefault: false });
  assert.deepEqual(resolve(w.store, "Ceramic Mugs").map((c) => c.id), [standard.id], "the product alone picks its default");
  assert.deepEqual(resolve(w.store, "ceramic mugs wholesale").map((c) => c.id), [wholesale.id]);
  assert.deepEqual(resolve(w.store, "Ceramic Bowls"), []);
});
