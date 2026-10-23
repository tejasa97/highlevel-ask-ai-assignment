import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

async function save10() {
  const w = await testWorld();
  const coupon = w.f.coupon({ code: "SAVE10" });
  return { w, coupon };
}

async function fall25() {
  const w = await testWorld();
  const product = w.f.product();
  const coupon = w.call("M31.A01", { code: "fall25", description: "Fall", discount: { type: "percent", value: 25 }, productIds: [product.id] });
  return { w, product, coupon };
}

test("M31.A01 create refuses a duplicate code, ignoring case", async () => {
  const { w } = await save10();
  assert.equal(failure(() => w.call("M31.A01", { code: "save10", discount: { type: "percent", value: 5 } })).code, "DUPLICATE");
});

test("M31.A01 unknown input field is INVALID", async () => {
  const { w } = await save10();
  assert.equal(failure(() => w.call("M31.A01", { code: "FRESH", discount: { type: "percent", value: 5 }, madeUp: 1 })).code, "INVALID");
});

test("M31.A04 description refuses a no-op", async () => {
  const { w, coupon } = await save10();
  assert.equal(failure(() => w.call("M31.A04", { couponId: coupon.id, description: null })).code, "CONFLICT");
});

test("M31.A05 discount refuses a no-op", async () => {
  const { w, coupon } = await save10();
  assert.equal(failure(() => w.call("M31.A05", { couponId: coupon.id, discount: { type: "percent", value: 10 } })).code, "CONFLICT");
});

test("M31.A06 validity window refuses a no-op", async () => {
  const { w, coupon } = await save10();
  assert.equal(failure(() => w.call("M31.A06", { couponId: coupon.id, validFrom: null })).code, "CONFLICT");
});

test("M31.A07 redemption limit refuses a no-op", async () => {
  const { w, coupon } = await save10();
  assert.equal(failure(() => w.call("M31.A07", { couponId: coupon.id, maxRedemptions: null })).code, "CONFLICT");
});

test("M31.A08 product restriction refuses a no-op", async () => {
  const { w, coupon } = await save10();
  assert.equal(failure(() => w.call("M31.A08", { couponId: coupon.id, productIds: [] })).code, "CONFLICT");
});

test("M31.A10 deactivating an inactive coupon conflicts", async () => {
  const w = await testWorld();
  const inactive = w.f.coupon({ status: "inactive" });
  assert.equal(failure(() => w.call("M31.A10", { couponId: inactive.id })).code, "CONFLICT");
});

test("M31.A09 validate reports why a coupon is invalid without throwing", async () => {
  const w = await testWorld();
  const inactive = w.f.coupon({ status: "inactive" });
  const early = w.f.coupon({ validFrom: w.f.at(2) });
  const late = w.f.coupon({ validUntil: w.f.at(-1) });
  const full = w.f.coupon({ maxRedemptions: 2, redemptions: 2 });
  assert.equal(w.call("M31.A09", { couponId: inactive.id }).valid, false);
  assert.match(w.call("M31.A09", { couponId: inactive.id }).reason, /inactive/);
  assert.match(w.call("M31.A09", { couponId: early.id }).reason, /isn't valid until/);
  assert.match(w.call("M31.A09", { couponId: late.id }).reason, /expired/);
  assert.match(w.call("M31.A09", { couponId: full.id }).reason, /limit 2/);
});

test("M31.A09 validate says a product-limited coupon doesn't apply to other lines", async () => {
  const w = await testWorld();
  const product = w.f.product();
  const other = w.f.product();
  const limited = w.f.coupon({ productIds: [product.id], discount: { type: "amount", value: 1 } });
  const missed = w.call("M31.A09", { couponId: limited.id, lines: [{ productId: other.id, amount: 10 }] });
  assert.deepEqual([missed.valid, missed.discount], [false, null]);
  assert.match(missed.reason, /doesn't apply/);
});

test("M31.A09 validate of an unknown coupon is NOT_FOUND", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M31.A09", { couponId: "cou_99999" })).code, "NOT_FOUND");
});

test("M31.A09 a coupon on the edge of its window and limit is still valid", async () => {
  const w = await testWorld();
  const now = w.clock.now().toISOString();
  const open = w.f.coupon({ validFrom: now, validUntil: now, maxRedemptions: 2, redemptions: 1 });
  const edge = w.call("M31.A09", { couponId: open.id });
  assert.equal(edge.valid, true);
  assert.equal(edge.amount, null);
});

test("M31.A09 a fixed discount spreads onto the matching lines and redeems nothing", async () => {
  const w = await testWorld();
  const product = w.f.product();
  const other = w.f.product();
  const limited = w.f.coupon({ productIds: [product.id], discount: { type: "amount", value: 1 } });
  const spread = w.call("M31.A09", {
    couponId: limited.id,
    lines: [
      { productId: product.id, amount: 1 },
      { productId: other.id, amount: 50 },
      { productId: product.id, amount: 1 },
      { productId: product.id, amount: 1 },
    ],
  });
  assert.equal(spread.valid, true);
  assert.equal(spread.amount, 1);
  assert.deepEqual(spread.lines.map((line: { discount: number }) => line.discount), [0.33, 0, 0.33, 0.34]);
  assert.equal(w.store.get<{ redemptions: number }>("coupons", limited.id)?.redemptions, 0);
});

test("M31.A01 create stores the code upper-cased", async () => {
  const { coupon } = await fall25();
  assert.equal(coupon.code, "FALL25");
});

test("M31.A04 description is changed", async () => {
  const { w, coupon } = await fall25();
  assert.equal(w.call("M31.A04", { couponId: coupon.id, description: "Autumn" }).description, "Autumn");
});

test("M31.A05 discount is changed", async () => {
  const { w, coupon } = await fall25();
  assert.equal(w.call("M31.A05", { couponId: coupon.id, discount: { type: "percent", value: 10 } }).discount.value, 10);
});

test("M31.A06 validity window is changed", async () => {
  const { w, coupon } = await fall25();
  const until = w.f.at(10);
  assert.equal(w.call("M31.A06", { couponId: coupon.id, validUntil: until }).validUntil, until);
});

test("M31.A07 redemption limit is changed, must be positive, and can't drop below the redemptions used", async () => {
  const { w, coupon } = await fall25();
  assert.equal(w.call("M31.A07", { couponId: coupon.id, maxRedemptions: 5 }).maxRedemptions, 5);
  assert.equal(failure(() => w.call("M31.A07", { couponId: coupon.id, maxRedemptions: 0 })).code, "INVALID");
  const used = w.f.coupon({ redemptions: 4, maxRedemptions: 10 });
  assert.equal(failure(() => w.call("M31.A07", { couponId: used.id, maxRedemptions: 3 })).code, "CONFLICT");
});

test("M31.A09 a percent discount is taken off the matching base after the restriction is lifted", async () => {
  const { w, product, coupon } = await fall25();
  w.call("M31.A05", { couponId: coupon.id, discount: { type: "percent", value: 10 } });
  w.call("M31.A08", { couponId: coupon.id, productIds: [] });
  const priced = w.call("M31.A09", { couponId: coupon.id, lines: [{ productId: product.id, amount: 30 }, { productId: product.id, amount: 70 }] });
  assert.equal(priced.amount, 10);
  assert.deepEqual(priced.lines.map((line: { discount: number }) => line.discount), [3, 7]);
});

test("M31.A10 deactivate marks the coupon inactive and search finds it", async () => {
  const { w, coupon } = await fall25();
  w.call("M31.A10", { couponId: coupon.id });
  assert.equal(w.call("M31.A02", { couponId: coupon.id }).status, "inactive");
  const codes = (w.call("M31.A03", { status: "inactive" }).items as { code: string }[]).map((c) => c.code);
  assert.ok(codes.includes("FALL25"));
});
