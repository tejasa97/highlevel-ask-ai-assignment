import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { cents, contains, inDateRange, Limit, listOf, page, requirePermission, requireState } from "../../registry/helpers.js";
import { ownedResolver } from "../../registry/lookup.js";
import type { ModuleExports } from "../../registry/registry.js";
import { localDate } from "../../store/clock.js";
import type { Store } from "../../store/db.js";
import type { Fixtures } from "../../store/fixtures.js";
import type { Contact } from "../m01-contacts/schema.js";
import { Product } from "../m25-products/schema.js";
import { Price } from "../m26-prices/schema.js";
import { line, nextInvoiceNumber } from "../m28-invoices/billing.js";
import type { Invoice } from "../m28-invoices/schema.js";
import { couponBlocker, couponShares } from "../m31-coupons/index.js";
import { Coupon } from "../m31-coupons/schema.js";
import type { TaxExemption, TaxRule } from "../m34-tax-rules/schema.js";
import { Address, ORDER_STATUSES, Order, type OrderLine } from "./schema.js";

import "./fixtures.js";

// Draft orders become an open invoice on submit. Tax matches M34: region specificity, then category, then inclusive vs exclusive.
// Tracked inventory is checked before any write so a shortfall leaves the draft untouched.

const OrderId = z.string().describe("order id (ord_…)");

const SHIP_TO = { line1: "1 Main", city: "Oakland", region: "CA", postalCode: "94612", country: "US" };

function customer(store: Store, id: string): Contact {
  const c = mustGet<Contact>(store, "contacts", id, "contact");
  requireState(c.name, c.status, ["active"], "place an order");
  return c;
}

function load(store: Store, id: string): Order {
  return mustGet<Order>(store, "orders", id, "order");
}

function draft(store: Store, id: string, doing: string): Order {
  const order = load(store, id);
  requireState(`Order ${order.number}`, order.status, ["draft"], doing);
  return order;
}

function regionKeys(address: Address | null): { country: string | null; specific: string | null } {
  if (!address?.country) return { country: null, specific: null };
  return { country: address.country, specific: address.region ? `${address.country}-${address.region}` : null };
}

/** Percent or amount off, spread across the lines the coupon covers, by M31's rules so both modules agree. */
function discountFor(lines: OrderLine[], coupon: Coupon | null): { discountTotal: number; net: number[] } {
  if (!coupon) return { discountTotal: 0, net: lines.map((l) => l.amount) };
  if (coupon.productIds.length > 0 && !lines.some((l) => coupon.productIds.includes(l.productId))) {
    throw new ActionError("CONFLICT", "This coupon doesn't apply to any of these products");
  }
  const { amount, shares } = couponShares(coupon, lines);
  return { discountTotal: amount, net: lines.map((l, i) => cents(l.amount - (shares[i] ?? 0))) };
}

function pickRule(rules: TaxRule[], address: Address | null, taxCategory: string | null): TaxRule | null {
  const { country, specific } = regionKeys(address);
  const active = rules.filter((r) => r.status === "active" && (r.region === specific || r.region === country));
  if (!active.length) return null;
  const longer = specific && active.some((r) => r.region === specific) ? specific : country;
  const pool = active.filter((r) => r.region === longer);
  return pool.find((r) => r.productCategory !== null && r.productCategory === taxCategory) ?? pool.find((r) => r.productCategory === null) ?? null;
}

function taxOn(amount: number, rule: TaxRule | null): { tax: number; exclusive: number } {
  if (!rule || amount <= 0 || rule.rate === 0) return { tax: 0, exclusive: 0 };
  if (rule.inclusive) return { tax: cents(amount - amount / (1 + rule.rate / 100)), exclusive: 0 };
  const tax = cents((amount * rule.rate) / 100);
  return { tax, exclusive: tax };
}

function exempt(store: Store, contactId: string, address: Address | null, today: string): boolean {
  const { country, specific } = regionKeys(address);
  return store.find<TaxExemption>("tax_exemptions", (e) => e.contactId === contactId).some((e) => {
    const current = e.expiresAt === null || e.expiresAt.slice(0, 10) >= today;
    const regions = e.regions.length === 0 || (country !== null && e.regions.includes(country)) || (specific !== null && e.regions.includes(specific));
    return current && regions;
  });
}

function moneyOf(store: Store, order: Order, coupon: Coupon | null, today: string): { subtotal: number; discountTotal: number; taxTotal: number; total: number } {
  const subtotal = cents(order.lines.reduce((n, l) => n + l.amount, 0));
  const { discountTotal, net } = discountFor(order.lines, coupon);
  const skip = exempt(store, order.contactId, order.shippingAddress, today);
  const rules = store.all<TaxRule>("tax_rules");
  let taxSum = 0;
  let exclusive = 0;
  order.lines.forEach((row, i) => {
    const product = mustGet<Product>(store, "products", row.productId, "product");
    const part = taxOn(net[i] ?? 0, skip ? null : pickRule(rules, order.shippingAddress, product.taxCategory));
    taxSum += part.tax;
    exclusive += part.exclusive;
  });
  return { subtotal, discountTotal, taxTotal: cents(taxSum), total: cents(subtotal - discountTotal + exclusive) };
}

function draftPatch(lines: OrderLine[], coupon: Coupon | null) {
  const subtotal = cents(lines.reduce((n, l) => n + l.amount, 0));
  const { discountTotal } = discountFor(lines, coupon);
  return { lines, subtotal, discountTotal, taxTotal: 0, total: cents(subtotal - discountTotal) };
}

type StockRow = { product: Product; variantId: string | null; qty: number; label: string; tracked: boolean; have: number };

function stockRows(store: Store, lines: OrderLine[]): StockRow[] {
  const grouped = new Map<string, { productId: string; variantId: string | null; qty: number }>();
  for (const row of lines) {
    const key = `${row.productId}\u0000${row.variantId ?? ""}`;
    const prev = grouped.get(key);
    grouped.set(key, { productId: row.productId, variantId: row.variantId, qty: (prev?.qty ?? 0) + row.quantity });
  }
  const out: StockRow[] = [];
  for (const g of grouped.values()) {
    const product = mustGet<Product>(store, "products", g.productId, "product");
    if (product.variants.length > 0) {
      if (!g.variantId) throw new ActionError("CONFLICT", `Name a variant of ${product.name}`);
      const variant = product.variants.find((v) => v.id === g.variantId);
      if (!variant) throw new ActionError("NOT_FOUND", `No variant ${g.variantId} on ${product.name}`);
      out.push({ product, variantId: variant.id, qty: g.qty, label: `${product.name} (${variant.name})`, tracked: variant.inventory !== null, have: variant.inventory ?? 0 });
    } else {
      if (g.variantId) throw new ActionError("CONFLICT", `${product.name} has no variants`);
      out.push({ product, variantId: null, qty: g.qty, label: product.name, tracked: product.inventory !== null, have: product.inventory ?? 0 });
    }
  }
  return out;
}

function assertInStock(rows: StockRow[]): void {
  for (const row of rows) {
    if (row.tracked && row.have < row.qty) throw new ActionError("CONFLICT", `Only ${row.have} of ${row.label} left; the order needs ${row.qty}`);
  }
}

function writeStock(store: Store, rows: StockRow[], sign: 1 | -1, now: string): void {
  const byProduct = new Map<string, StockRow[]>();
  for (const row of rows) {
    const list = byProduct.get(row.product.id) ?? [];
    list.push(row);
    byProduct.set(row.product.id, list);
  }
  for (const [productId, list] of byProduct) {
    const product = mustGet<Product>(store, "products", productId, "product");
    const variants = product.variants.map((v) => ({ ...v }));
    let inventory = product.inventory;
    let changed = false;
    for (const row of list) {
      if (!row.tracked) continue;
      if (variants.length > 0) {
        const variant = variants.find((v) => v.id === row.variantId);
        if (!variant || variant.inventory === null) continue;
        variant.inventory += sign * row.qty;
        changed = true;
      } else if (inventory !== null) {
        inventory += sign * row.qty;
        changed = true;
      }
    }
    if (changed) store.update<Product>("products", product.id, { variants, inventory, updatedAt: now });
  }
}

function pricedProduct(store: Store, productId: string, priceId: string | undefined, variantId: string | undefined): { product: Product; price: Price; variantId: string | null; description: string } {
  const product = mustGet<Product>(store, "products", productId, "product");
  if (product.status !== "active") throw new ActionError("CONFLICT", `Product ${product.name} is archived; choose an active product`);
  if (!priceId && !product.defaultPriceId) throw new ActionError("CONFLICT", `${product.name} has no default price; name one of its prices`);
  const price = mustGet<Price>(store, "prices", priceId ?? product.defaultPriceId!, "price");
  if (price.productId !== product.id) throw new ActionError("CONFLICT", `Price ${price.label} belongs to a different product`);
  if (price.currency !== "USD") throw new ActionError("CONFLICT", `Price ${price.label} is ${price.currency}; orders are USD only`);
  if (price.status !== "active") throw new ActionError("CONFLICT", `Price ${price.label} is archived; choose an active price`);
  if (product.variants.length > 0) {
    if (!variantId) throw new ActionError("CONFLICT", `Name a variant of ${product.name}`);
    const variant = product.variants.find((v) => v.id === variantId);
    if (!variant) throw new ActionError("NOT_FOUND", `No variant ${variantId} on ${product.name}`);
    return { product, price, variantId: variant.id, description: `${product.name} (${variant.name})` };
  }
  if (variantId) throw new ActionError("CONFLICT", `${product.name} has no variants`);
  return { product, price, variantId: null, description: product.name };
}

function productOf(f: Fixtures, over: Partial<Omit<Product, "id">> = {}): Product {
  const now = f.now();
  return f.make("products", "prd", Product, {
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

function priceOf(f: Fixtures, productId: string, amount = 20): Price {
  const now = f.now();
  return f.make("prices", "prc", Price, {
    productId,
    label: "Each",
    amount,
    currency: "USD",
    interval: "one_time",
    intervalCount: 1,
    trialDays: 0,
    isDefault: false,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

const createOrder = defineAction({
  id: "M32.A01",
  description:
    "Open an empty draft order for a contact. Nothing is billed and no invoice exists yet. Unlike M28.A01 Create invoice, lines, tax and the coupon are added before M32.A08 Submit order issues the invoice.",
  risk: "write",
  input: z.strictObject({ contactId: z.string().describe("contact id (ct_…)") }),
  output: Order,
  siblings: ["M28.A01", "M31.A09"],
  entities: { produces: "order" },
  example: (f) => ({ contactId: f.contact().id }),
  handler: ({ contactId }, { store, clock }) => {
    customer(store, contactId);
    const now = clock.now().toISOString();
    return store.insert("orders", "ord", {
      number: `ORD-${1001 + store.all("orders").length}`,
      contactId,
      status: "draft" as const,
      lines: [],
      shippingAddress: null,
      couponId: null,
      subtotal: 0,
      discountTotal: 0,
      taxTotal: 0,
      total: 0,
      invoiceId: null,
      submittedAt: null,
      fulfilledAt: null,
      cancelledAt: null,
      cancelReason: null,
      createdAt: now,
      updatedAt: now,
      currency: "USD" as const,
    });
  },
});

const getOrder = defineAction({
  id: "M32.A02",
  description: "Get one order: its lines, coupon, totals, shipping address and invoice. To find several, use M32.A03 Search orders.",
  risk: "read",
  input: z.strictObject({ orderId: OrderId }),
  output: Order,
  entities: { consumes: ["order"] },
  example: (f) => ({ orderId: f.order().id }),
  handler: ({ orderId }, { store }) => load(store, orderId),
});

const searchOrders = defineAction({
  id: "M32.A03",
  description: "Find orders by contact, status, number or the date created. Newest first, then by id. Unlike M32.A02 Get order, this returns a page rather than one order.",
  risk: "read",
  input: z.strictObject({
    contactId: z.string().optional(),
    status: z.enum(ORDER_STATUSES).optional(),
    query: z.string().optional().describe("words in the order number"),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: Limit,
  }),
  output: listOf(Order),
  entities: { produces: "order" },
  example: () => ({ status: "draft" as const }),
  handler: (a, { store }) => {
    const items = store.find<Order>(
      "orders",
      (o) => (!a.contactId || o.contactId === a.contactId) && (!a.status || o.status === a.status) && (!a.query || contains(o.number, a.query)) && inDateRange(o.createdAt, a.from, a.to),
    );
    items.sort((x, y) => y.createdAt.localeCompare(x.createdAt) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const addLine = defineAction({
  id: "M32.A04",
  description:
    "Add a product line to a draft order, priced from a USD price: the product's default price unless another is named. Variants are required when the product has them. Unlike M32.A05 Update order quantity, this adds a new line instead of changing one that is already there.",
  risk: "write",
  input: z.strictObject({
    orderId: OrderId,
    productId: z.string(),
    priceId: z.string().optional().describe("price id (prc_…); the product's default price when omitted"),
    quantity: z.number().int().min(1),
    variantId: z.string().optional().describe("required when the product has variants"),
  }),
  output: Order,
  entities: { consumes: ["order"] },
  example: (f) => {
    const product = productOf(f);
    const price = priceOf(f, product.id);
    return { orderId: f.order({ contactId: f.contact().id }).id, productId: product.id, priceId: price.id, quantity: 1 };
  },
  handler: (a, { store, clock }) => {
    const order = draft(store, a.orderId, "change its lines");
    const { price, variantId, description } = pricedProduct(store, a.productId, a.priceId, a.variantId);
    const coupon = order.couponId ? mustGet<Coupon>(store, "coupons", order.couponId, "coupon") : null;
    const row: OrderLine = {
      id: store.nextId("_nested", "li"),
      productId: a.productId,
      variantId,
      priceId: price.id,
      description,
      quantity: a.quantity,
      unitPrice: price.amount,
      amount: cents(a.quantity * price.amount),
    };
    return store.update<Order>("orders", order.id, { ...draftPatch([...order.lines, row], coupon), updatedAt: clock.now().toISOString() });
  },
});

const updateQuantity = defineAction({
  id: "M32.A05",
  description:
    "Change the quantity on one line of a draft order and recompute its amount and the order total. Unlike M32.A04 Add order line item, the line must already be on the order.",
  risk: "write",
  input: z.strictObject({ orderId: OrderId, lineId: z.string(), quantity: z.number().int().min(1) }),
  output: Order,
  entities: { consumes: ["order"] },
  example: (f) => {
    const product = productOf(f);
    const price = priceOf(f, product.id, 10);
    const order = f.order({
      contactId: f.contact().id,
      lines: [{ id: "li_9", productId: product.id, variantId: null, priceId: price.id, description: product.name, quantity: 1, unitPrice: 10, amount: 10 }],
      subtotal: 10,
      total: 10,
    });
    return { orderId: order.id, lineId: "li_9", quantity: 2 };
  },
  handler: ({ orderId, lineId, quantity }, { store, clock }) => {
    const order = draft(store, orderId, "change its lines");
    const current = order.lines.find((l) => l.id === lineId);
    if (!current) throw new ActionError("NOT_FOUND", `No order line with id ${lineId}`);
    if (current.quantity === quantity) throw new ActionError("CONFLICT", `Order ${order.number} already has that value`);
    const coupon = order.couponId ? mustGet<Coupon>(store, "coupons", order.couponId, "coupon") : null;
    const lines = order.lines.map((l) => (l.id === lineId ? { ...l, quantity, amount: cents(quantity * l.unitPrice) } : l));
    return store.update<Order>("orders", order.id, { ...draftPatch(lines, coupon), updatedAt: clock.now().toISOString() });
  },
});

const setAddress = defineAction({
  id: "M32.A06",
  description:
    "Set the shipping address on a draft order. Submit uses it to pick a tax region (country-region, then country). Unlike M32.A04 Add order line item, this does not change what was ordered.",
  risk: "write",
  input: z.strictObject({ orderId: OrderId, address: Address }),
  output: Order,
  entities: { consumes: ["order"] },
  example: (f) => ({ orderId: f.order().id, address: SHIP_TO }),
  handler: ({ orderId, address }, { store, clock }) => {
    const order = draft(store, orderId, "change its shipping address");
    const prev = order.shippingAddress;
    if (prev && prev.line1 === address.line1 && prev.city === address.city && prev.region === address.region && prev.postalCode === address.postalCode && prev.country === address.country) {
      throw new ActionError("CONFLICT", `Order ${order.number} already has that value`);
    }
    return store.update<Order>("orders", order.id, { shippingAddress: address, updatedAt: clock.now().toISOString() });
  },
});

const applyCoupon = defineAction({
  id: "M32.A07",
  description:
    "Attach a coupon to a draft order and reduce the total. An inactive, unopened, expired, maxed-out or product-mismatched coupon is a CONFLICT. Unlike M31.A09 Validate coupon for order, this writes the coupon onto the draft instead of only reporting whether it would work.",
  risk: "write",
  input: z.strictObject({ orderId: OrderId, couponId: z.string() }),
  output: Order,
  siblings: ["M31.A09"],
  entities: { consumes: ["order", "coupon"] },
  example: (f) => {
    const now = f.now();
    const product = productOf(f);
    const price = priceOf(f, product.id, 40);
    const coupon = f.make("coupons", "cou", Coupon, {
      code: "SAVE10",
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
    });
    const order = f.order({
      contactId: f.contact().id,
      lines: [{ id: "li_8", productId: product.id, variantId: null, priceId: price.id, description: product.name, quantity: 1, unitPrice: 40, amount: 40 }],
      subtotal: 40,
      total: 40,
    });
    return { orderId: order.id, couponId: coupon.id };
  },
  handler: ({ orderId, couponId }, { store, clock }) => {
    const order = draft(store, orderId, "change its coupon");
    if (order.couponId === couponId) throw new ActionError("CONFLICT", `Order ${order.number} already has that value`);
    const coupon = mustGet<Coupon>(store, "coupons", couponId, "coupon");
    const problem = couponBlocker(coupon, order.lines, clock.now().getTime());
    if (problem) throw new ActionError("CONFLICT", problem);
    return store.update<Order>("orders", order.id, { couponId: coupon.id, ...draftPatch(order.lines, coupon), updatedAt: clock.now().toISOString() });
  },
});

const submitOrder = defineAction({
  id: "M32.A08",
  description:
    "Submit a draft order: compute tax (unless the contact has a valid exemption), redeem the coupon, decrement tracked inventory, and issue an open invoice. A non-USD price or an inventory shortfall is a CONFLICT and writes nothing. Unlike M28.A01 Create invoice, the invoice is produced from the order. Requires billing.manage.",
  risk: "external",
  input: z.strictObject({ orderId: OrderId }),
  output: Order,
  siblings: ["M28.A01", "M31.A09", "M34.A09"],
  entities: { consumes: ["order"], produces: "invoice" },
  example: (f) => {
    const product = productOf(f);
    const price = priceOf(f, product.id, 20);
    const order = f.order({
      contactId: f.contact().id,
      lines: [{ id: "li_7", productId: product.id, variantId: null, priceId: price.id, description: product.name, quantity: 1, unitPrice: 20, amount: 20 }],
      shippingAddress: SHIP_TO,
      subtotal: 20,
      total: 20,
    });
    return { orderId: order.id };
  },
  handler: ({ orderId }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "billing.manage");
    const order = load(store, orderId);
    requireState(`Order ${order.number}`, order.status, ["draft"], "be submitted");
    if (!order.lines.length) throw new ActionError("CONFLICT", `Order ${order.number} has no lines; add one before submitting`);
    customer(store, order.contactId);
    for (const row of order.lines) {
      const price = mustGet<Price>(store, "prices", row.priceId, "price");
      if (price.currency !== "USD") throw new ActionError("CONFLICT", `Price ${price.label} is ${price.currency}; orders are USD only`);
    }
    const rows = stockRows(store, order.lines);
    assertInStock(rows);
    const now = clock.now().toISOString();
    const coupon = order.couponId ? mustGet<Coupon>(store, "coupons", order.couponId, "coupon") : null;
    if (coupon) {
      const problem = couponBlocker(coupon, order.lines, clock.now().getTime());
      if (problem) throw new ActionError("CONFLICT", problem);
    }
    const money = moneyOf(store, order, coupon, localDate(clock.now()));
    writeStock(store, rows, -1, now);
    if (coupon) store.update<Coupon>("coupons", coupon.id, { redemptions: coupon.redemptions + 1, updatedAt: now });
    const inv = store.insert("invoices", "inv", {
      number: nextInvoiceNumber(store),
      contactId: order.contactId,
      status: "open",
      lineItems: order.lines.map((row) => line({ description: row.description, quantity: row.quantity, unitPrice: row.unitPrice })),
      total: money.total,
      amountPaid: 0,
      amountDue: money.total,
      currency: "USD",
      issueDate: localDate(clock.now()),
      dueDate: null,
      paidAt: null,
      voidedAt: null,
      voidReason: null,
      reminders: [],
      lastReminderAt: null,
      memo: null,
      createdAt: now,
    });
    return store.update<Order>("orders", order.id, {
      status: "submitted",
      subtotal: money.subtotal,
      discountTotal: money.discountTotal,
      taxTotal: money.taxTotal,
      total: money.total,
      invoiceId: inv.id,
      submittedAt: now,
      updatedAt: now,
    });
  },
});

const cancelOrder = defineAction({
  id: "M32.A09",
  description:
    "Cancel a draft order, or a submitted order whose invoice is still open and unpaid. The invoice is voided, tracked inventory is put back and the coupon's redemption is released. A paid invoice is a CONFLICT (refund the payment first). Unlike M32.A08 Submit order, this undoes the sale. Unlike M28.A09 Void unpaid invoice, this also cancels the order and restores inventory. Requires billing.manage.",
  risk: "destructive",
  input: z.strictObject({ orderId: OrderId, reason: z.string().min(1) }),
  output: Order,
  siblings: ["M28.A09"],
  entities: { consumes: ["order", "invoice"] },
  example: (f) => ({ orderId: f.order().id, reason: "Customer changed their mind" }),
  handler: ({ orderId, reason }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "billing.manage");
    const order = load(store, orderId);
    const now = clock.now().toISOString();
    if (order.status === "draft") {
      return store.update<Order>("orders", order.id, { status: "cancelled", cancelledAt: now, cancelReason: reason, updatedAt: now });
    }
    if (order.status === "submitted") {
      if (!order.invoiceId) throw new ActionError("CONFLICT", `Order ${order.number} has no invoice to void`);
      const inv = mustGet<Invoice>(store, "invoices", order.invoiceId, "invoice");
      if (inv.status === "paid" || inv.amountPaid !== 0) throw new ActionError("CONFLICT", "refund the payment first");
      if (inv.status !== "open") throw new ActionError("CONFLICT", `Invoice ${inv.number} is ${inv.status}; only an open unpaid invoice can be voided`);
      store.update("invoices", inv.id, { status: "void", voidedAt: now, voidReason: reason, amountDue: 0 });
      writeStock(store, stockRows(store, order.lines), 1, now);
      // The redemption this order used is free again, or a one-use coupon would be spent by a cancelled sale.
      const coupon = order.couponId ? store.get<Coupon>("coupons", order.couponId) : undefined;
      if (coupon) store.update<Coupon>("coupons", coupon.id, { redemptions: Math.max(0, coupon.redemptions - 1), updatedAt: now });
      return store.update<Order>("orders", order.id, { status: "cancelled", cancelledAt: now, cancelReason: reason, updatedAt: now });
    }
    requireState(`Order ${order.number}`, order.status, ["draft", "submitted"], "be cancelled");
    return order;
  },
});

const fulfillOrder = defineAction({
  id: "M32.A10",
  description:
    "Mark a submitted order fulfilled and record when. Unlike M32.A09 Cancel order, the invoice stays open and inventory stays decremented. A draft has to be submitted first.",
  risk: "write",
  input: z.strictObject({ orderId: OrderId }),
  output: Order,
  entities: { consumes: ["order"] },
  example: (f) => ({ orderId: f.order({ status: "submitted", submittedAt: f.now() }).id }),
  handler: ({ orderId }, { store, clock }) => {
    const order = load(store, orderId);
    requireState(`Order ${order.number}`, order.status, ["submitted"], "be marked fulfilled");
    const now = clock.now().toISOString();
    return store.update<Order>("orders", order.id, { status: "fulfilled", fulfilledAt: now, updatedAt: now });
  },
});

export default {
  actions: [createOrder, getOrder, searchOrders, addLine, updateQuantity, setAddress, applyCoupon, submitOrder, cancelOrder, fulfillOrder],
  resolvers: { order: ownedResolver<Order>({ table: "orders", noun: "order", label: (_, o) => o.number, detail: (o) => `${o.status}, $${o.total}`, inactive: (o) => (o.status === "cancelled" ? "cancelled" : undefined) }) },
} satisfies ModuleExports;
