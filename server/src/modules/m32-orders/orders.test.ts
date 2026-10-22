import assert from "node:assert/strict";
import { test } from "node:test";
import type { Invoice } from "../m28-invoices/schema.js";
import { Coupon } from "../m31-coupons/schema.js";
import { Price } from "../m26-prices/schema.js";
import { Product, type ProductVariant } from "../m25-products/schema.js";
import { TaxExemption, TaxRule } from "../m34-tax-rules/schema.js";
import { failure, testWorld, type TestWorld } from "../../testkit.js";
import type { Address } from "./schema.js";

const ADDR: Address = { line1: "1 Main", city: "Oakland", region: "CA", postalCode: "94612", country: "US" };

function product(w: TestWorld, over: Partial<Omit<Product, "id">> = {}): Product {
  const now = w.f.now();
  return w.f.make("products", "prd", Product, {
    name: "Widget",
    description: null,
    sku: null,
    inventory: null,
    variants: [],
    taxCategory: null,
    defaultPriceId: null,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

function price(w: TestWorld, productId: string, over: Partial<Omit<Price, "id" | "productId">> = {}): Price {
  const now = w.f.now();
  return w.f.make("prices", "prc", Price, {
    productId,
    label: "Each",
    amount: 100,
    currency: "USD",
    interval: "one_time",
    intervalCount: 1,
    trialDays: 0,
    isDefault: false,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

function coupon(w: TestWorld, over: Partial<Omit<Coupon, "id">> = {}): Coupon {
  const now = w.f.now();
  return w.f.make("coupons", "cou", Coupon, {
    code: `C${w.f.seq()}`,
    description: null,
    discount: { type: "percent", value: 10 },
    validFrom: null,
    validUntil: null,
    maxRedemptions: null,
    redemptions: 0,
    productIds: [],
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

function rule(w: TestWorld, over: Partial<Omit<TaxRule, "id">> = {}): TaxRule {
  const now = w.f.now();
  return w.f.make("tax_rules", "tx", TaxRule, {
    name: "Tax",
    rate: 10,
    region: "US-CA",
    productCategory: null,
    inclusive: false,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

function exemption(w: TestWorld, contactId: string, over: Partial<Omit<TaxExemption, "id" | "contactId">> = {}): TaxExemption {
  return w.f.make("tax_exemptions", "txe", TaxExemption, {
    contactId,
    certificateNumber: `EX-${w.f.seq()}`,
    reason: null,
    regions: [],
    expiresAt: null,
    recordedBy: "us_1",
    createdAt: w.f.now(),
    ...over,
  });
}

test("guards: wrong status, permission, bad ids, and unknown fields", async () => {
  const w = await testWorld();
  const sales = w.f.user({ roles: ["sales"] });
  const p = product(w);
  const pr = price(w, p.id, { amount: 10 });
  const contact = w.f.contact();
  assert.equal(failure(() => w.call("M32.A01", { contactId: "ct_99999" })).code, "NOT_FOUND");
  const draft = w.call("M32.A01", { contactId: contact.id });
  const submitted = w.f.order({ contactId: contact.id, status: "submitted", submittedAt: w.f.now() });
  assert.equal(failure(() => w.call("M32.A04", { orderId: submitted.id, productId: p.id, priceId: pr.id, quantity: 1 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M32.A05", { orderId: submitted.id, lineId: "li_1", quantity: 2 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M32.A06", { orderId: submitted.id, address: ADDR })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M32.A07", { orderId: submitted.id, couponId: coupon(w).id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M32.A08", { orderId: draft.id }, sales.id)).code, "PERMISSION");
  assert.equal(failure(() => w.call("M32.A09", { orderId: draft.id, reason: "no" }, sales.id)).code, "PERMISSION");
  assert.equal(failure(() => w.call("M32.A10", { orderId: draft.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M32.A02", { orderId: draft.id, madeUp: 1 })).code, "INVALID");
});

test("submit computes tax, redeems the coupon, takes inventory, and issues an open invoice", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const p = product(w, { inventory: 5, taxCategory: "saas" });
  const pr = price(w, p.id, { amount: 100 });
  rule(w, { name: "US", region: "US", rate: 5 });
  rule(w, { name: "CA generic", region: "US-CA", rate: 8 });
  rule(w, { name: "CA saas", region: "US-CA", rate: 2, productCategory: "saas" });
  const coup = coupon(w, { discount: { type: "percent", value: 10 } });
  const order = w.call("M32.A01", { contactId: contact.id });
  const withLine = w.call("M32.A04", { orderId: order.id, productId: p.id, priceId: pr.id, quantity: 1 });
  assert.equal(withLine.lines[0]?.amount, 100);
  w.call("M32.A06", { orderId: order.id, address: ADDR });
  const discounted = w.call("M32.A07", { orderId: order.id, couponId: coup.id });
  assert.equal(discounted.discountTotal, 10);
  assert.equal(discounted.total, 90);
  const invoicesBefore = w.store.all("invoices").length;
  const submitted = w.call("M32.A08", { orderId: order.id });
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.taxTotal, 1.8);
  assert.equal(submitted.total, 91.8);
  assert.equal(w.store.get<Product>("products", p.id)?.inventory, 4);
  assert.equal(w.store.get<Coupon>("coupons", coup.id)?.redemptions, 1);
  const inv = w.store.get<Invoice>("invoices", submitted.invoiceId ?? "");
  assert.equal(inv?.status, "open");
  assert.equal(inv?.amountPaid, 0);
  assert.equal(inv?.amountDue, 91.8);
  assert.equal(inv?.total, 91.8);
  assert.equal(inv?.contactId, contact.id);
  assert.equal(w.store.all("invoices").length, invoicesBefore + 1);

  const again = failure(() => w.call("M32.A08", { orderId: order.id }));
  assert.equal(again.code, "CONFLICT");
});

test("a valid exemption zeros the tax; a more specific region and category win, and inclusive tax is not added", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const p = product(w, { taxCategory: "saas" });
  const pr = price(w, p.id, { amount: 100 });
  rule(w, { region: "US", rate: 5, name: "Country" });
  rule(w, { region: "US-CA", rate: 8, name: "State" });
  const order = w.call("M32.A01", { contactId: contact.id });
  w.call("M32.A04", { orderId: order.id, productId: p.id, priceId: pr.id, quantity: 1 });
  w.call("M32.A06", { orderId: order.id, address: ADDR });
  exemption(w, contact.id, { regions: ["US"], expiresAt: "2026-10-21" });
  const free = w.call("M32.A08", { orderId: order.id });
  assert.equal(free.taxTotal, 0);
  assert.equal(free.total, 100);

  const other = w.f.contact();
  const clothingOnly = product(w, { name: "Shirt", taxCategory: "saas" });
  const clothingPrice = price(w, clothingOnly.id, { amount: 50 });
  rule(w, { region: "US-TX", rate: 20, productCategory: "clothing", name: "Clothes" });
  const missed = w.call("M32.A01", { contactId: other.id });
  w.call("M32.A04", { orderId: missed.id, productId: clothingOnly.id, priceId: clothingPrice.id, quantity: 1 });
  w.call("M32.A06", { orderId: missed.id, address: { ...ADDR, region: "TX", city: "Austin" } });
  const noFallback = w.call("M32.A08", { orderId: missed.id });
  assert.equal(noFallback.taxTotal, 0);
  assert.equal(noFallback.total, 50);

  const buyer = w.f.contact();
  const widget = product(w, { name: "Inclusive", taxCategory: null });
  const each = price(w, widget.id, { amount: 100 });
  rule(w, { region: "US-NY", rate: 10, inclusive: true, name: "NY included" });
  const ny = w.call("M32.A01", { contactId: buyer.id });
  w.call("M32.A04", { orderId: ny.id, productId: widget.id, priceId: each.id, quantity: 1 });
  w.call("M32.A06", { orderId: ny.id, address: { ...ADDR, region: "NY", city: "New York" } });
  const included = w.call("M32.A08", { orderId: ny.id });
  assert.equal(included.taxTotal, 9.09);
  assert.equal(included.total, 100);

  const expiredBuyer = w.f.contact();
  exemption(w, expiredBuyer.id, { regions: [], expiresAt: "2026-10-20" });
  const late = w.call("M32.A01", { contactId: expiredBuyer.id });
  w.call("M32.A04", { orderId: late.id, productId: widget.id, priceId: each.id, quantity: 1 });
  w.call("M32.A06", { orderId: late.id, address: { ...ADDR, region: "NY", city: "New York" } });
  assert.equal(w.call("M32.A08", { orderId: late.id }).taxTotal, 9.09);
});

test("discount rounding lands on the last eligible line, and a coupon that misses every line is refused", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const a = product(w, { name: "A" });
  const b = product(w, { name: "B" });
  const pa = price(w, a.id, { amount: 10 });
  const pb = price(w, b.id, { amount: 10 });
  rule(w, { region: "US-CA", rate: 10, name: "Ten" });
  const order = w.call("M32.A01", { contactId: contact.id });
  w.call("M32.A04", { orderId: order.id, productId: a.id, priceId: pa.id, quantity: 1 });
  w.call("M32.A04", { orderId: order.id, productId: a.id, priceId: pa.id, quantity: 1 });
  w.call("M32.A04", { orderId: order.id, productId: a.id, priceId: pa.id, quantity: 1 });
  w.call("M32.A06", { orderId: order.id, address: ADDR });
  const off = coupon(w, { discount: { type: "amount", value: 1 }, productIds: [a.id] });
  w.call("M32.A07", { orderId: order.id, couponId: off.id });
  const submitted = w.call("M32.A08", { orderId: order.id });
  assert.equal(submitted.discountTotal, 1);
  assert.equal(submitted.subtotal, 30);
  assert.equal(submitted.taxTotal, 2.91);
  assert.equal(submitted.total, 31.91);

  const other = w.call("M32.A01", { contactId: contact.id });
  w.call("M32.A04", { orderId: other.id, productId: b.id, priceId: pb.id, quantity: 1 });
  const missed = failure(() => w.call("M32.A07", { orderId: other.id, couponId: off.id }));
  assert.equal(missed.code, "CONFLICT");
  assert.match(missed.message, /does not apply/);
  const inactive = coupon(w, { status: "inactive" });
  assert.match(failure(() => w.call("M32.A07", { orderId: other.id, couponId: inactive.id })).message, /inactive/);
  const early = coupon(w, { validFrom: w.f.at(2) });
  assert.match(failure(() => w.call("M32.A07", { orderId: other.id, couponId: early.id })).message, /not valid yet/);
  const old = coupon(w, { validUntil: w.f.at(-1) });
  assert.match(failure(() => w.call("M32.A07", { orderId: other.id, couponId: old.id })).message, /expired/);
  const maxed = coupon(w, { maxRedemptions: 1, redemptions: 1 });
  assert.match(failure(() => w.call("M32.A07", { orderId: other.id, couponId: maxed.id })).message, /redemption limit/);
});

test("inventory shortfall and a non-USD price are CONFLICT and leave no partial writes", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const enough = product(w, { name: "Enough", inventory: 5 });
  const short = product(w, { name: "Short", inventory: 1 });
  const pe = price(w, enough.id, { amount: 10 });
  const ps = price(w, short.id, { amount: 10 });
  const coup = coupon(w);
  const order = w.call("M32.A01", { contactId: contact.id });
  w.call("M32.A04", { orderId: order.id, productId: enough.id, priceId: pe.id, quantity: 2 });
  w.call("M32.A04", { orderId: order.id, productId: short.id, priceId: ps.id, quantity: 2 });
  w.call("M32.A07", { orderId: order.id, couponId: coup.id });
  const before = w.store.all("invoices").length;
  const refused = failure(() => w.call("M32.A08", { orderId: order.id }));
  assert.equal(refused.code, "CONFLICT");
  assert.match(refused.message, /Only 1 of Short left/);
  assert.equal(w.store.get<Product>("products", enough.id)?.inventory, 5);
  assert.equal(w.store.get<Product>("products", short.id)?.inventory, 1);
  assert.equal(w.store.get<Coupon>("coupons", coup.id)?.redemptions, 0);
  assert.equal(w.store.get<OrderStatus>("orders", order.id)?.status, "draft");
  assert.equal(w.store.all("invoices").length, before);

  const variant = product(w, {
    name: "Shirt",
    inventory: null,
    variants: [{ id: "va_1", name: "Small", sku: null, inventory: 2 } satisfies ProductVariant],
  });
  const pv = price(w, variant.id, { amount: 15 });
  const sized = w.call("M32.A01", { contactId: contact.id });
  assert.equal(failure(() => w.call("M32.A04", { orderId: sized.id, productId: variant.id, priceId: pv.id, quantity: 1 })).code, "CONFLICT");
  w.call("M32.A04", { orderId: sized.id, productId: variant.id, priceId: pv.id, quantity: 2, variantId: "va_1" });
  w.call("M32.A08", { orderId: sized.id });
  assert.equal(w.store.get<Product>("products", variant.id)?.variants[0]?.inventory, 0);

  const eur = price(w, enough.id, { currency: "EUR", label: "Euro" });
  assert.match(failure(() => w.call("M32.A04", { orderId: w.call("M32.A01", { contactId: contact.id }).id, productId: enough.id, priceId: eur.id, quantity: 1 })).message, /USD only/);
  const sneaky = w.f.order({
    contactId: contact.id,
    lines: [{ id: "li_eur", productId: enough.id, variantId: null, priceId: eur.id, description: "Euro", quantity: 1, unitPrice: 10, amount: 10 }],
    subtotal: 10,
    total: 10,
  });
  assert.equal(failure(() => w.call("M32.A08", { orderId: sneaky.id })).code, "CONFLICT");
});

test("cancel voids an unpaid invoice and restores inventory; a paid invoice is refused", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const p = product(w, { inventory: 5 });
  const pr = price(w, p.id, { amount: 10 });
  const order = w.call("M32.A01", { contactId: contact.id });
  const lined = w.call("M32.A04", { orderId: order.id, productId: p.id, priceId: pr.id, quantity: 2 });
  const lineId = lined.lines[0]?.id ?? "";
  const sameQty = failure(() => w.call("M32.A05", { orderId: order.id, lineId, quantity: 2 }));
  assert.equal(sameQty.code, "CONFLICT");
  assert.match(sameQty.message, /already has that value/);
  w.call("M32.A05", { orderId: order.id, lineId, quantity: 3 });
  const submitted = w.call("M32.A08", { orderId: order.id });
  assert.equal(w.store.get<Product>("products", p.id)?.inventory, 2);
  const cancelled = w.call("M32.A09", { orderId: order.id, reason: "Changed mind" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(w.store.get<Product>("products", p.id)?.inventory, 5);
  const voided = w.store.get<Invoice>("invoices", submitted.invoiceId ?? "");
  assert.equal(voided?.status, "void");
  assert.equal(voided?.amountDue, 0);
  assert.equal(voided?.voidReason, "Changed mind");

  const second = w.call("M32.A01", { contactId: contact.id });
  w.call("M32.A04", { orderId: second.id, productId: p.id, priceId: pr.id, quantity: 1 });
  const paidOrder = w.call("M32.A08", { orderId: second.id });
  w.store.update("invoices", paidOrder.invoiceId ?? "", { status: "paid", amountPaid: paidOrder.total, amountDue: 0, paidAt: w.f.now() });
  const blocked = failure(() => w.call("M32.A09", { orderId: second.id, reason: "too late" }));
  assert.equal(blocked.code, "CONFLICT");
  assert.match(blocked.message, /refund the payment first/);
  assert.equal(w.store.get<Product>("products", p.id)?.inventory, 4);
  assert.equal(w.store.get<Invoice>("invoices", paidOrder.invoiceId ?? "")?.status, "paid");

  const draft = w.call("M32.A01", { contactId: contact.id });
  assert.equal(w.call("M32.A09", { orderId: draft.id, reason: "empty" }).status, "cancelled");
  const found = w.call("M32.A03", { contactId: contact.id, status: "cancelled" });
  assert.equal(found.total >= 2, true);
  const fulfilled = w.call("M32.A10", { orderId: w.f.order({ status: "submitted", submittedAt: w.f.now() }).id });
  assert.equal(fulfilled.status, "fulfilled");
  assert.equal(failure(() => w.call("M32.A09", { orderId: fulfilled.id, reason: "no" })).code, "CONFLICT");
});

type OrderStatus = { status: string };
