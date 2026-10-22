import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("guards: duplicate SKU, no-op edits, archived product, unknown field", async () => {
  const w = await testWorld();
  const sku = w.f.product({ sku: "SKU-1" });
  assert.equal(failure(() => w.call("M25.A01", { name: "Other", sku: "SKU-1" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M25.A01", { name: "Other", madeUp: 1 })).code, "INVALID");
  assert.equal(failure(() => w.call("M25.A04", { productId: sku.id, name: sku.name })).code, "CONFLICT");
  const archived = w.f.product({ status: "archived" });
  assert.equal(failure(() => w.call("M25.A05", { productId: archived.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M25.A06", { productId: archived.id, name: "Large" })).code, "CONFLICT");
  const variant = w.f.product({ variants: [{ id: "vr_9", name: "Large", sku: null, inventory: 1 }] });
  assert.equal(failure(() => w.call("M25.A07", { productId: variant.id, variantId: "vr_9", name: "Large" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M25.A08", { productId: sku.id, sku: "SKU-1" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M25.A09", { productId: sku.id, quantity: null })).code, "CONFLICT");
});

test("SKU is unique across a product and its variants; search sorts by name then id", async () => {
  const w = await testWorld();
  const a = w.call("M25.A01", { name: "Zebra", sku: "ZEB" });
  const b = w.call("M25.A01", { name: "Alpha" });
  w.call("M25.A06", { productId: b.id, name: "Small", sku: "ALP-S" });
  assert.equal(failure(() => w.call("M25.A08", { productId: a.id, sku: "ALP-S" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M25.A06", { productId: a.id, name: "Other", sku: "ZEB" })).code, "DUPLICATE");
  const ids = (w.call("M25.A03", { query: "a" }).items as { id: string; name: string }[]).map((p) => p.name);
  assert.deepEqual(ids.filter((name) => name === "Alpha" || name === "Zebra"), ["Alpha", "Zebra"]);
  assert.equal(w.call("M25.A02", { productId: a.id }).sku, "ZEB");
});

test("variants take over inventory; null is not tracked; availability sums the rest", async () => {
  const w = await testWorld();
  const created = w.call("M25.A01", { name: "Shirt", inventory: 4 });
  const withVariant = w.call("M25.A06", { productId: created.id, name: "Medium" });
  assert.equal(withVariant.inventory, null);
  assert.equal(withVariant.variants[0].inventory, 4);
  const both = w.call("M25.A06", { productId: created.id, name: "Large", inventory: 3 });
  const avail = w.call("M25.A10", { productId: created.id });
  assert.deepEqual([avail.tracked, avail.available, avail.onHand], [true, 7, 7]);
  w.call("M25.A09", { productId: created.id, variantId: both.variants[1].id, quantity: null });
  const open = w.call("M25.A10", { productId: created.id });
  assert.deepEqual([open.tracked, open.available, open.onHand], [false, null, 4]);
  assert.equal(failure(() => w.call("M25.A09", { productId: created.id, quantity: 9 })).code, "CONFLICT");
  assert.equal(w.call("M25.A04", { productId: created.id, taxCategory: "apparel" }).taxCategory, "apparel");
  w.call("M25.A05", { productId: created.id });
  assert.equal(w.call("M25.A02", { productId: created.id }).status, "archived");
});
