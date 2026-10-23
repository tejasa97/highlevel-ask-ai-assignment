import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

// A shirt with 4 on hand, then a "Medium" variant (takes the 4) and a "Large" variant with 3.
async function shirtWithVariants() {
  const w = await testWorld();
  const created = w.call("M25.A01", { name: "Shirt", inventory: 4 });
  const withVariant = w.call("M25.A06", { productId: created.id, name: "Medium" });
  const both = w.call("M25.A06", { productId: created.id, name: "Large", inventory: 3 });
  return { w, created, withVariant, both };
}

test("M25.A01 create refuses a duplicate SKU", async () => {
  const w = await testWorld();
  w.f.product({ sku: "SKU-1" });
  assert.equal(failure(() => w.call("M25.A01", { name: "Other", sku: "SKU-1" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M25.A01", { name: "Other", sku: "sku-1" })).code, "DUPLICATE", "SKUs compare case-insensitively");
});

test("M25.A01 unknown input field is INVALID", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M25.A01", { name: "Other", madeUp: 1 })).code, "INVALID");
});

test("M25.A04 edit refuses a no-op", async () => {
  const w = await testWorld();
  const sku = w.f.product({ sku: "SKU-1" });
  assert.equal(failure(() => w.call("M25.A04", { productId: sku.id, name: sku.name })).code, "CONFLICT");
});

test("M25.A05 archive refuses an archived product", async () => {
  const w = await testWorld();
  const archived = w.f.product({ status: "archived" });
  assert.equal(failure(() => w.call("M25.A05", { productId: archived.id })).code, "CONFLICT");
});

test("M25.A06 add variant refuses an archived product", async () => {
  const w = await testWorld();
  const archived = w.f.product({ status: "archived" });
  assert.equal(failure(() => w.call("M25.A06", { productId: archived.id, name: "Large" })).code, "CONFLICT");
});

test("M25.A07 rename variant refuses a no-op", async () => {
  const w = await testWorld();
  const variant = w.f.product({ variants: [{ id: "vr_9", name: "Large", sku: null, inventory: 1 }] });
  assert.equal(failure(() => w.call("M25.A07", { productId: variant.id, variantId: "vr_9", name: "Large" })).code, "CONFLICT");
});

test("M25.A08 SKU refuses a no-op", async () => {
  const w = await testWorld();
  const sku = w.f.product({ sku: "SKU-1" });
  assert.equal(failure(() => w.call("M25.A08", { productId: sku.id, sku: "SKU-1" })).code, "CONFLICT");
});

test("M25.A09 inventory refuses making an untracked product untracked again", async () => {
  const w = await testWorld();
  const sku = w.f.product({ sku: "SKU-1" });
  assert.equal(failure(() => w.call("M25.A09", { productId: sku.id, quantity: null })).code, "CONFLICT");
});

test("M25.A08 SKU is unique across other products' variants", async () => {
  const w = await testWorld();
  const a = w.call("M25.A01", { name: "Zebra", sku: "ZEB" });
  const b = w.call("M25.A01", { name: "Alpha" });
  w.call("M25.A06", { productId: b.id, name: "Small", sku: "ALP-S" });
  assert.equal(failure(() => w.call("M25.A08", { productId: a.id, sku: "ALP-S" })).code, "DUPLICATE");
});

test("M25.A06 a variant's SKU cannot repeat another product's SKU", async () => {
  const w = await testWorld();
  const a = w.call("M25.A01", { name: "Zebra", sku: "ZEB" });
  assert.equal(failure(() => w.call("M25.A06", { productId: a.id, name: "Other", sku: "ZEB" })).code, "DUPLICATE");
});

test("M25.A03 search sorts by name then id", async () => {
  const w = await testWorld();
  const a = w.call("M25.A01", { name: "Zebra", sku: "ZEB" });
  w.call("M25.A01", { name: "Alpha" });
  const ids = (w.call("M25.A03", { query: "a" }).items as { id: string; name: string }[]).map((p) => p.name);
  assert.deepEqual(ids.filter((name) => name === "Alpha" || name === "Zebra"), ["Alpha", "Zebra"]);
  assert.equal(w.call("M25.A02", { productId: a.id }).sku, "ZEB");
});

test("M25.A06 the first variant takes over the product's inventory", async () => {
  const { withVariant } = await shirtWithVariants();
  assert.equal(withVariant.inventory, null);
  assert.equal(withVariant.variants[0].inventory, 4);
});

test("M25.A10 availability sums the variants", async () => {
  const { w, created } = await shirtWithVariants();
  const avail = w.call("M25.A10", { productId: created.id });
  assert.deepEqual([avail.tracked, avail.available, avail.onHand], [true, 7, 7]);
});

test("M25.A09 a variant set to null is not tracked, so availability is open", async () => {
  const { w, created, both } = await shirtWithVariants();
  w.call("M25.A09", { productId: created.id, variantId: both.variants[1].id, quantity: null });
  const open = w.call("M25.A10", { productId: created.id });
  assert.deepEqual([open.tracked, open.available, open.onHand], [false, null, 4]);
});

test("M25.A09 product-level inventory is refused once there are variants", async () => {
  const { w, created } = await shirtWithVariants();
  assert.equal(failure(() => w.call("M25.A09", { productId: created.id, quantity: 9 })).code, "CONFLICT");
});

test("M25.A04 edit sets the tax category", async () => {
  const { w, created } = await shirtWithVariants();
  assert.equal(w.call("M25.A04", { productId: created.id, taxCategory: "apparel" }).taxCategory, "apparel");
});

test("M25.A05 archive marks the product archived", async () => {
  const { w, created } = await shirtWithVariants();
  w.call("M25.A05", { productId: created.id });
  assert.equal(w.call("M25.A02", { productId: created.id }).status, "archived");
});
