import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { atLeastOne, cents, contains, Limit, listOf, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Product } from "../m25-products/schema.js";
import { Coupon, Discount } from "./schema.js";

export { Coupon } from "./schema.js";
import "./fixtures.js";

// Coupons. Validate (M31.A09) never throws for a bad window, limit, product list or inactive coupon;
// it returns valid: false. A bad coupon id is the only NOT_FOUND. Applying one on an order is M32.A07.

const CouponId = z.string().describe("coupon id (cou_…)");
const When = z.iso.datetime({ offset: true });
const DiscountInput = z.strictObject({
  type: z.enum(["percent", "amount"]),
  value: z.number().positive(),
});

export interface OrderLine {
  productId: string;
  amount: number;
}

export interface AssessedLine {
  productId: string;
  amount: number;
  discount: number;
}

export interface Assessment {
  valid: boolean;
  reason: string | null;
  discount: Discount | null;
  amount: number | null;
  lines: AssessedLine[] | null;
}

/** Percent of base, or a fixed amount capped at the base. Both rounded to cents. */
export function discountAmount(base: number, discount: Discount): number {
  if (base <= 0) return 0;
  const raw = discount.type === "percent" ? cents(base * discount.value / 100) : cents(Math.min(discount.value, base));
  return Math.min(cents(base), raw);
}

/**
 * Spread `discount` across matching lines by their share of that base.
 * Earlier lines take a floored share; the last matching line absorbs the remainder.
 */
export function spreadDiscount(amounts: number[], matching: boolean[], discount: number): number[] {
  const out = amounts.map(() => 0);
  const idx = amounts.map((_, i) => i).filter((i) => matching[i]);
  if (idx.length === 0 || discount <= 0) return out;
  const baseCents = idx.reduce((sum, i) => sum + Math.round((amounts[i] ?? 0) * 100), 0);
  const discountCents = Math.round(discount * 100);
  if (baseCents <= 0) return out;
  let used = 0;
  idx.forEach((i, n) => {
    if (n === idx.length - 1) {
      out[i] = (discountCents - used) / 100;
      return;
    }
    const share = Math.floor((discountCents * Math.round((amounts[i] ?? 0) * 100)) / baseCents);
    out[i] = share / 100;
    used += share;
  });
  return out;
}

function checkDiscount(d: { type: "percent" | "amount"; value: number }): void {
  if (d.type === "percent" && d.value > 100) throw new ActionError("INVALID", "A percent discount can't be more than 100");
}

function instant(iso: string, what: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new ActionError("INVALID", `${what} ${iso} isn't a time`);
  return t;
}

/** Why a coupon can't be used right now, or null when it can. Does not throw. */
export function couponBlocker(coupon: Coupon, lines: OrderLine[] | undefined, nowMs: number): string | null {
  if (coupon.status !== "active") return "This coupon is inactive";
  if (coupon.validFrom && instant(coupon.validFrom, "validFrom") > nowMs) return `This coupon isn't valid until ${coupon.validFrom}`;
  if (coupon.validUntil && instant(coupon.validUntil, "validUntil") < nowMs) return `This coupon expired at ${coupon.validUntil}`;
  if (coupon.maxRedemptions !== null && coupon.redemptions >= coupon.maxRedemptions) {
    return `This coupon has already been used ${coupon.redemptions} times (limit ${coupon.maxRedemptions})`;
  }
  if (coupon.productIds.length > 0) {
    const allowed = new Set(coupon.productIds);
    const hit = (lines ?? []).some((line) => allowed.has(line.productId));
    if (!hit) return "This coupon doesn't apply to any of these products";
  }
  return null;
}

/** What the coupon takes off `lines`, in total and per line. Says nothing about whether the coupon may be used. */
export function couponShares(coupon: Coupon, lines: OrderLine[]): { amount: number; shares: number[] } {
  const allowed = new Set(coupon.productIds);
  const matching = lines.map((line) => coupon.productIds.length === 0 || allowed.has(line.productId));
  const base = cents(lines.reduce((sum, line, i) => sum + (matching[i] ? line.amount : 0), 0));
  const amount = discountAmount(base, coupon.discount);
  return { amount, shares: spreadDiscount(lines.map((line) => line.amount), matching, amount) };
}

/** Read-only coupon check. `lines` omitted means the discount amount isn't computed (unless a product restriction then fails). */
export function assessCoupon(coupon: Coupon, lines: OrderLine[] | undefined, nowMs: number): Assessment {
  const reason = couponBlocker(coupon, lines, nowMs);
  if (reason) return { valid: false, reason, discount: null, amount: null, lines: null };
  if (!lines) return { valid: true, reason: null, discount: coupon.discount, amount: null, lines: null };
  const { amount, shares } = couponShares(coupon, lines);
  return {
    valid: true,
    reason: null,
    discount: coupon.discount,
    amount,
    lines: lines.map((line, i) => ({ productId: line.productId, amount: line.amount, discount: shares[i] ?? 0 })),
  };
}

function existingProducts(store: Store, ids: string[]): string[] {
  const unique = [...new Set(ids)];
  for (const id of unique) mustGet<Product>(store, "products", id, "product");
  return unique;
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const other = new Set(b);
  return a.every((id) => other.has(id));
}

function codeTaken(store: Store, code: string, exceptId?: string): Coupon | undefined {
  const key = code.trim().toUpperCase();
  return store.find<Coupon>("coupons", (c) => c.id !== exceptId && c.code.toUpperCase() === key)[0];
}

const LineIn = z.strictObject({ productId: z.string(), amount: z.number().min(0).describe("USD, line amount") });

const createCoupon = defineAction({
  id: "M31.A01",
  description: "Create a coupon code with a percent or USD discount. The code is stored in upper case and must be unique. To check whether an order can use it, use M31.A09 Validate coupon.",
  risk: "write",
  input: z.strictObject({
    code: z.string().min(1).max(40),
    description: z.string().optional(),
    discount: DiscountInput,
    validFrom: When.nullable().optional(),
    validUntil: When.nullable().optional(),
    maxRedemptions: z.number().int().min(1).nullable().optional().describe("null = unlimited"),
    productIds: z.array(z.string()).optional().describe("empty = every product"),
  }),
  output: Coupon,
  entities: { produces: "coupon" },
  example: () => ({ code: "WELCOME10", discount: { type: "percent", value: 10 } }),
  handler: (a, { store, clock }) => {
    checkDiscount(a.discount);
    const code = a.code.trim().toUpperCase();
    if (!code) throw new ActionError("INVALID", "Code can't be blank");
    const dup = codeTaken(store, code);
    if (dup) throw new ActionError("DUPLICATE", `Coupon code ${dup.code} already exists (${dup.id})`, { existingId: dup.id });
    const validFrom = a.validFrom ?? null;
    const validUntil = a.validUntil ?? null;
    if (validFrom && validUntil && instant(validFrom, "validFrom") > instant(validUntil, "validUntil")) {
      throw new ActionError("INVALID", "validFrom is after validUntil");
    }
    const now = clock.now().toISOString();
    return store.insert("coupons", "cou", {
      code,
      description: a.description ?? null,
      discount: a.discount,
      validFrom,
      validUntil,
      maxRedemptions: a.maxRedemptions ?? null,
      redemptions: 0,
      productIds: existingProducts(store, a.productIds ?? []),
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getCoupon = defineAction({
  id: "M31.A02",
  description: "Get one coupon: its code, discount, validity window, redemption count and product limits. To search the list, use M31.A03.",
  risk: "read",
  input: z.strictObject({ couponId: CouponId }),
  output: Coupon,
  entities: { consumes: ["coupon"] },
  example: (f) => ({ couponId: f.coupon().id }),
  handler: ({ couponId }, { store }) => mustGet<Coupon>(store, "coupons", couponId, "coupon"),
});

const searchCoupons = defineAction({
  id: "M31.A03",
  description: "Find coupons by code, description, status or product. Sorted by code, then id. To open one record, use M31.A02 Get coupon details.",
  risk: "read",
  input: z.strictObject({
    query: z.string().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    productId: z.string().optional().describe("coupons restricted to this product, or unrestricted ones"),
    limit: Limit,
  }),
  output: listOf(Coupon),
  entities: { produces: "coupon" },
  example: () => ({ query: "OFF" }),
  handler: (a, { store }) => {
    const items = store.find<Coupon>(
      "coupons",
      (c) =>
        (!a.status || c.status === a.status) &&
        (!a.productId || c.productIds.length === 0 || c.productIds.includes(a.productId)) &&
        (!a.query || contains(c.code, a.query) || contains(c.description, a.query)),
    );
    items.sort((x, y) => x.code.localeCompare(y.code) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const updateDescription = defineAction({
  id: "M31.A04",
  description: "Change a coupon's description, or clear it with null. The code, discount and limits stay put; those have their own actions.",
  risk: "write",
  input: z.strictObject({ couponId: CouponId, description: z.string().nullable() }),
  output: Coupon,
  entities: { consumes: ["coupon"] },
  example: (f) => ({ couponId: f.coupon().id, description: "Spring sale" }),
  handler: ({ couponId, description }, { store, clock }) => {
    const c = mustGet<Coupon>(store, "coupons", couponId, "coupon");
    requireState(`Coupon ${c.code}`, c.status, ["active"], "be edited");
    const next = description?.trim() || null;
    if (c.description === next) throw new ActionError("CONFLICT", next ? `The description is already "${next}"` : "The coupon already has no description");
    return store.update<Coupon>("coupons", c.id, { description: next, updatedAt: clock.now().toISOString() });
  },
});

const setDiscount = defineAction({
  id: "M31.A05",
  description: "Change a coupon's discount to a percent (at most 100) or a USD amount. To check the discount against an order's lines, use M31.A09 Validate coupon.",
  risk: "write",
  input: z.strictObject({ couponId: CouponId, discount: DiscountInput }),
  output: Coupon,
  entities: { consumes: ["coupon"] },
  example: (f) => ({ couponId: f.coupon().id, discount: { type: "amount", value: 5 } }),
  handler: ({ couponId, discount }, { store, clock }) => {
    const c = mustGet<Coupon>(store, "coupons", couponId, "coupon");
    requireState(`Coupon ${c.code}`, c.status, ["active"], "be edited");
    checkDiscount(discount);
    if (c.discount.type === discount.type && c.discount.value === discount.value) {
      throw new ActionError("CONFLICT", "The coupon already has that discount");
    }
    return store.update<Coupon>("coupons", c.id, { discount, updatedAt: clock.now().toISOString() });
  },
});

const setWindow = defineAction({
  id: "M31.A06",
  description: "Set the timestamps a coupon starts and stops being valid. Null clears either side. An order outside this window fails validation (M31.A09) without an error.",
  risk: "write",
  input: z.strictObject({
    couponId: CouponId,
    validFrom: When.nullable().optional(),
    validUntil: When.nullable().optional(),
  }),
  output: Coupon,
  entities: { consumes: ["coupon"] },
  example: (f) => ({ couponId: f.coupon().id, validUntil: f.at(30) }),
  handler: (a, { store, clock }) => {
    const c = mustGet<Coupon>(store, "coupons", a.couponId, "coupon");
    requireState(`Coupon ${c.code}`, c.status, ["active"], "be edited");
    atLeastOne(a, ["validFrom", "validUntil"]);
    const validFrom = a.validFrom === undefined ? c.validFrom : a.validFrom;
    const validUntil = a.validUntil === undefined ? c.validUntil : a.validUntil;
    if (validFrom && validUntil && instant(validFrom, "validFrom") > instant(validUntil, "validUntil")) {
      throw new ActionError("INVALID", "validFrom is after validUntil");
    }
    if (c.validFrom === validFrom && c.validUntil === validUntil) throw new ActionError("CONFLICT", "The coupon already has that validity window");
    return store.update<Coupon>("coupons", c.id, { validFrom, validUntil, updatedAt: clock.now().toISOString() });
  },
});

const setLimit = defineAction({
  id: "M31.A07",
  description: "Set how many times a coupon can be redeemed, or null for unlimited. The limit can't sit below the redemptions already counted. Validation (M31.A09) reports a full coupon as invalid.",
  risk: "write",
  input: z.strictObject({ couponId: CouponId, maxRedemptions: z.number().int().min(1).nullable() }),
  output: Coupon,
  entities: { consumes: ["coupon"] },
  example: (f) => ({ couponId: f.coupon().id, maxRedemptions: 100 }),
  handler: ({ couponId, maxRedemptions }, { store, clock }) => {
    const c = mustGet<Coupon>(store, "coupons", couponId, "coupon");
    requireState(`Coupon ${c.code}`, c.status, ["active"], "be edited");
    if (maxRedemptions !== null && maxRedemptions < c.redemptions) {
      throw new ActionError("CONFLICT", `Already redeemed ${c.redemptions} times; the limit can't be below that`);
    }
    if (c.maxRedemptions === maxRedemptions) {
      throw new ActionError("CONFLICT", maxRedemptions === null ? "The coupon is already unlimited" : `The limit is already ${maxRedemptions}`);
    }
    return store.update<Coupon>("coupons", c.id, { maxRedemptions, updatedAt: clock.now().toISOString() });
  },
});

const restrictProducts = defineAction({
  id: "M31.A08",
  description: "Limit a coupon to specific products. An empty list means it applies to every product. Validation fails (without throwing) when none of the order's lines are in the list.",
  risk: "write",
  input: z.strictObject({ couponId: CouponId, productIds: z.array(z.string()) }),
  output: Coupon,
  entities: { consumes: ["coupon"] },
  example: (f) => ({ couponId: f.coupon().id, productIds: [f.product().id] }),
  handler: ({ couponId, productIds }, { store, clock }) => {
    const c = mustGet<Coupon>(store, "coupons", couponId, "coupon");
    requireState(`Coupon ${c.code}`, c.status, ["active"], "be edited");
    const ids = existingProducts(store, productIds);
    if (sameIds(c.productIds, ids)) {
      throw new ActionError("CONFLICT", ids.length === 0 ? "The coupon already applies to every product" : "The coupon is already limited to those products");
    }
    return store.update<Coupon>("coupons", c.id, { productIds: ids, updatedAt: clock.now().toISOString() });
  },
});

const AssessmentOut = z.object({
  valid: z.boolean(),
  reason: z.string().nullable(),
  discount: Discount.nullable(),
  amount: z.number().nullable().describe("USD off the matching lines; null when lines were omitted"),
  lines: z.array(z.object({ productId: z.string(), amount: z.number(), discount: z.number() })).nullable(),
});

const validateCoupon = defineAction({
  id: "M31.A09",
  description: "Check a coupon against an order without changing anything. Returns valid false (it does not throw) when the coupon is inactive, outside its window, out of redemptions, or limited to products none of the lines use. A bad id is NOT_FOUND. Applying it is M32.A07.",
  risk: "read",
  input: z.strictObject({
    couponId: CouponId,
    lines: z.array(LineIn).optional().describe("order lines; omit only when you are not checking products or the amount"),
  }),
  output: AssessmentOut,
  siblings: ["M32.A07"],
  entities: { consumes: ["coupon"] },
  example: (f) => ({ couponId: f.coupon().id }),
  handler: (a, { store, clock }) => {
    const c = mustGet<Coupon>(store, "coupons", a.couponId, "coupon");
    return assessCoupon(c, a.lines, clock.now().getTime());
  },
});

const deactivateCoupon = defineAction({
  id: "M31.A10",
  description: "Deactivate a coupon so validation reports it as invalid. The code stays reserved. Get and search still return it.",
  risk: "destructive",
  input: z.strictObject({ couponId: CouponId }),
  output: Coupon,
  entities: { consumes: ["coupon"] },
  example: (f) => ({ couponId: f.coupon().id }),
  handler: ({ couponId }, { store, clock }) => {
    const c = mustGet<Coupon>(store, "coupons", couponId, "coupon");
    requireState(`Coupon ${c.code}`, c.status, ["active"], "be deactivated");
    return store.update<Coupon>("coupons", c.id, { status: "inactive", updatedAt: clock.now().toISOString() });
  },
});

export default {
  actions: [createCoupon, getCoupon, searchCoupons, updateDescription, setDiscount, setWindow, setLimit, restrictProducts, validateCoupon, deactivateCoupon],
} satisfies ModuleExports;
