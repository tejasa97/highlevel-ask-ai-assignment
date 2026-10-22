import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { cents, inDateRange, Limit, listOf, page, requirePermission, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Fixtures } from "../../store/fixtures.js";
import type { Contact } from "../m01-contacts/schema.js";
import { Price } from "../m26-prices/schema.js";
import { Product } from "../m25-products/schema.js";
import { addInterval, isAfter, shiftPaused } from "./clock-local.js";
import { SUBSCRIPTION_STATUSES, Subscription } from "./schema.js";

import "./fixtures.js";

// Recurring billing agreements. A one-time price cannot back one. Pausing freezes the period;
// resuming pushes both period bounds forward by the time spent paused.

const SubscriptionId = z.string().describe("subscription id (sub_…)");
const OPEN = ["active", "trialing", "paused"] as const;

function customer(store: Store, id: string): Contact {
  const c = mustGet<Contact>(store, "contacts", id, "contact");
  requireState(c.name, c.status, ["active"], "hold a subscription");
  return c;
}

function recurring(store: Store, priceId: string): { price: Price; product: Product; interval: "day" | "week" | "month" | "year" } {
  const price = mustGet<Price>(store, "prices", priceId, "price");
  if (price.interval === "one_time") throw new ActionError("CONFLICT", "Choose a recurring price");
  if (price.status !== "active") throw new ActionError("CONFLICT", `Price ${price.label} is archived; choose an active price`);
  const product = mustGet<Product>(store, "products", price.productId, "product");
  if (product.status !== "active") throw new ActionError("CONFLICT", `Product ${product.name} is archived; choose an active product`);
  return { price, product, interval: price.interval };
}

function load(store: Store, id: string): Subscription {
  return mustGet<Subscription>(store, "subscriptions", id, "subscription");
}

function openSub(store: Store, id: string, doing: string): Subscription {
  const sub = load(store, id);
  requireState(`Subscription ${sub.id}`, sub.status, OPEN, doing);
  return sub;
}

function productOf(f: Fixtures, name = "Plan"): Product {
  const now = f.now();
  return f.make("products", "prd", Product, {
    name,
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
}

function priceOf(f: Fixtures, productId: string, over: Partial<Omit<Price, "id" | "productId">> = {}): Price {
  const now = f.now();
  return f.make("prices", "prc", Price, {
    productId,
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
}

const createSubscription = defineAction({
  id: "M30.A01",
  description:
    "Start a recurring subscription for a contact on a price. The period starts now and ends one interval later. A trial (from the price's trial days, or a trial end you pass) makes it trialing. Unlike M26.A07 Set billing interval, this does not edit the price.",
  risk: "write",
  input: z.strictObject({
    contactId: z.string().describe("contact id (ct_…)"),
    priceId: z.string().describe("recurring price id (prc_…)"),
    quantity: z.number().int().min(1).optional().describe("units billed each period; default 1"),
    trialEnd: z.iso.datetime({ offset: true }).optional().describe("when the trial ends; overrides the price's trial days"),
  }),
  output: Subscription,
  siblings: ["M26.A07"],
  entities: { produces: "subscription" },
  example: (f) => {
    const product = productOf(f);
    return { contactId: f.contact().id, priceId: priceOf(f, product.id).id };
  },
  handler: (a, { store, clock }) => {
    customer(store, a.contactId);
    const { price, product, interval } = recurring(store, a.priceId);
    const now = clock.now().toISOString();
    let trialEnd: string | null = null;
    if (a.trialEnd) {
      if (!isAfter(a.trialEnd, now)) throw new ActionError("CONFLICT", "Choose a trial end in the future");
      trialEnd = a.trialEnd;
    } else if (price.trialDays > 0) trialEnd = addInterval(now, "day", price.trialDays);
    const status = trialEnd ? "trialing" : "active";
    return store.insert<Omit<Subscription, "id">>("subscriptions", "sub", {
      contactId: a.contactId,
      priceId: price.id,
      productId: product.id,
      quantity: a.quantity ?? 1,
      status,
      trialEnd,
      currentPeriodStart: now,
      currentPeriodEnd: addInterval(now, interval, price.intervalCount),
      pausedAt: null,
      canceledAt: null,
      cancelReason: null,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getSubscription = defineAction({
  id: "M30.A02",
  description: "Get one subscription: its contact, price, quantity, status, trial and current period. To find several, use M30.A03 Search subscriptions.",
  risk: "read",
  input: z.strictObject({ subscriptionId: SubscriptionId }),
  output: Subscription,
  entities: { consumes: ["subscription"] },
  example: (f) => ({ subscriptionId: f.subscription().id }),
  handler: ({ subscriptionId }, { store }) => load(store, subscriptionId),
});

const searchSubscriptions = defineAction({
  id: "M30.A03",
  description:
    "Find subscriptions by contact, price, product or status. Newest first, then by id. Unlike M30.A02 Get subscription, this returns a page of matches rather than one record.",
  risk: "read",
  input: z.strictObject({
    contactId: z.string().optional(),
    priceId: z.string().optional(),
    productId: z.string().optional(),
    status: z.enum(SUBSCRIPTION_STATUSES).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: Limit,
  }),
  output: listOf(Subscription),
  entities: { produces: "subscription" },
  example: () => ({ status: "active" as const }),
  handler: (a, { store }) => {
    const items = store.find<Subscription>(
      "subscriptions",
      (s) =>
        (!a.contactId || s.contactId === a.contactId) &&
        (!a.priceId || s.priceId === a.priceId) &&
        (!a.productId || s.productId === a.productId) &&
        (!a.status || s.status === a.status) &&
        inDateRange(s.createdAt, a.from, a.to),
    );
    items.sort((x, y) => y.createdAt.localeCompare(x.createdAt) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const changePlan = defineAction({
  id: "M30.A04",
  description:
    "Point a subscription at a different recurring price, and at that price's product. The current period is kept (no proration). Unlike M26.A07 Set billing interval, the price record itself is not edited. A one-time price is refused.",
  risk: "write",
  input: z.strictObject({ subscriptionId: SubscriptionId, priceId: z.string().describe("the new recurring price") }),
  output: Subscription,
  entities: { consumes: ["subscription"] },
  example: (f) => {
    const product = productOf(f);
    const current = priceOf(f, product.id, { label: "Monthly", amount: 10 });
    const next = priceOf(f, product.id, { label: "Yearly", amount: 100, interval: "year" });
    const sub = f.subscription({ contactId: f.contact().id, priceId: current.id, productId: product.id });
    return { subscriptionId: sub.id, priceId: next.id };
  },
  handler: ({ subscriptionId, priceId }, { store, clock }) => {
    const sub = openSub(store, subscriptionId, "change plan");
    if (sub.priceId === priceId) throw new ActionError("CONFLICT", `Subscription ${sub.id} already has that value`);
    const { price, product } = recurring(store, priceId);
    return store.update<Subscription>("subscriptions", sub.id, { priceId: price.id, productId: product.id, updatedAt: clock.now().toISOString() });
  },
});

const updateQuantity = defineAction({
  id: "M30.A05",
  description:
    "Change how many units a subscription bills each period. The price stays the same. Unlike M30.A04 Change subscription plan, this does not switch the price or the product.",
  risk: "write",
  input: z.strictObject({ subscriptionId: SubscriptionId, quantity: z.number().int().min(1) }),
  output: Subscription,
  entities: { consumes: ["subscription"] },
  example: (f) => ({ subscriptionId: f.subscription({ quantity: 1 }).id, quantity: 3 }),
  handler: ({ subscriptionId, quantity }, { store, clock }) => {
    const sub = openSub(store, subscriptionId, "change quantity");
    if (sub.quantity === quantity) throw new ActionError("CONFLICT", `Subscription ${sub.id} already has that value`);
    return store.update<Subscription>("subscriptions", sub.id, { quantity, updatedAt: clock.now().toISOString() });
  },
});

const setTrialEnd = defineAction({
  id: "M30.A06",
  description:
    "Set when a subscription's trial ends. A future end makes an active subscription trialing; an end that has passed ends a trial and makes it active. A paused subscription stays paused. Unlike M30.A01 Create subscription, this changes a subscription that already exists.",
  risk: "write",
  input: z.strictObject({ subscriptionId: SubscriptionId, trialEnd: z.iso.datetime({ offset: true }) }),
  output: Subscription,
  entities: { consumes: ["subscription"] },
  example: (f) => ({ subscriptionId: f.subscription({ trialEnd: null }).id, trialEnd: f.at(14) }),
  handler: ({ subscriptionId, trialEnd }, { store, clock }) => {
    const sub = openSub(store, subscriptionId, "set the trial end");
    if (sub.trialEnd === trialEnd) throw new ActionError("CONFLICT", `Subscription ${sub.id} already has that value`);
    const now = clock.now().toISOString();
    const future = isAfter(trialEnd, now);
    let status = sub.status;
    if (sub.status === "active" && future) status = "trialing";
    else if (sub.status === "trialing" && !future) status = "active";
    return store.update<Subscription>("subscriptions", sub.id, { trialEnd, status, updatedAt: now });
  },
});

const pauseSubscription = defineAction({
  id: "M30.A07",
  description:
    "Pause an active or trialing subscription so it stops billing. The period dates stay put until M30.A08 Resume subscription, which shifts them forward by the time spent paused. Cancel (M30.A09) ends it instead.",
  risk: "write",
  input: z.strictObject({ subscriptionId: SubscriptionId }),
  output: Subscription,
  entities: { consumes: ["subscription"] },
  example: (f) => ({ subscriptionId: f.subscription({ status: "active" }).id }),
  handler: ({ subscriptionId }, { store, clock }) => {
    const sub = load(store, subscriptionId);
    requireState(`Subscription ${sub.id}`, sub.status, ["active", "trialing"], "be paused");
    const now = clock.now().toISOString();
    return store.update<Subscription>("subscriptions", sub.id, { status: "paused", pausedAt: now, updatedAt: now });
  },
});

const resumeSubscription = defineAction({
  id: "M30.A08",
  description:
    "Resume a paused subscription and push currentPeriodStart and currentPeriodEnd forward by the paused duration (now minus pausedAt). It returns to trialing when the trial end is still in the future, otherwise active. Unlike M30.A07 Pause, this clears pausedAt.",
  risk: "write",
  input: z.strictObject({ subscriptionId: SubscriptionId }),
  output: Subscription,
  entities: { consumes: ["subscription"] },
  example: (f) => ({
    subscriptionId: f.subscription({ status: "paused", pausedAt: f.at(-2), currentPeriodStart: f.at(-10), currentPeriodEnd: f.at(20) }).id,
  }),
  handler: ({ subscriptionId }, { store, clock }) => {
    const sub = load(store, subscriptionId);
    requireState(`Subscription ${sub.id}`, sub.status, ["paused"], "be resumed");
    if (!sub.pausedAt) throw new ActionError("CONFLICT", `Subscription ${sub.id} is paused but has no pausedAt; cancel it and start again`);
    const now = clock.now().toISOString();
    const status = sub.trialEnd && isAfter(sub.trialEnd, now) ? "trialing" : "active";
    return store.update<Subscription>("subscriptions", sub.id, {
      status,
      pausedAt: null,
      currentPeriodStart: shiftPaused(sub.currentPeriodStart, sub.pausedAt, now),
      currentPeriodEnd: shiftPaused(sub.currentPeriodEnd, sub.pausedAt, now),
      updatedAt: now,
    });
  },
});

const cancelSubscription = defineAction({
  id: "M30.A09",
  description:
    "Cancel a subscription for good and record why. It can be active, trialing or paused. A second cancel is refused. Unlike M30.A07 Pause subscription, it does not resume. Requires billing.manage.",
  risk: "destructive",
  input: z.strictObject({ subscriptionId: SubscriptionId, reason: z.string().min(1) }),
  output: Subscription,
  entities: { consumes: ["subscription"] },
  example: (f) => ({ subscriptionId: f.subscription().id, reason: "Too expensive" }),
  handler: ({ subscriptionId, reason }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "billing.manage");
    const sub = load(store, subscriptionId);
    requireState(`Subscription ${sub.id}`, sub.status, OPEN, "be canceled");
    const now = clock.now().toISOString();
    return store.update<Subscription>("subscriptions", sub.id, { status: "canceled", canceledAt: now, cancelReason: reason, updatedAt: now });
  },
});

const previewInvoice = defineAction({
  id: "M30.A10",
  description:
    "Preview the next invoice for a subscription: quantity times the price, and the current period, without writing an invoice. A canceled subscription has nothing to preview. Unlike M32.A08 Submit order, this does not bill anyone.",
  risk: "read",
  input: z.strictObject({ subscriptionId: SubscriptionId }),
  output: z.object({
    subscriptionId: z.string(),
    status: z.enum(SUBSCRIPTION_STATUSES),
    priceId: z.string(),
    productId: z.string(),
    quantity: z.number(),
    currency: z.string(),
    unitAmount: z.number(),
    amount: z.number(),
    currentPeriodStart: z.string(),
    currentPeriodEnd: z.string(),
  }),
  entities: { consumes: ["subscription"] },
  example: (f) => {
    const product = productOf(f, "Preview plan");
    const price = priceOf(f, product.id, { amount: 15 });
    return { subscriptionId: f.subscription({ priceId: price.id, productId: product.id, quantity: 2 }).id };
  },
  handler: ({ subscriptionId }, { store }) => {
    const sub = load(store, subscriptionId);
    if (sub.status === "canceled") throw new ActionError("CONFLICT", `Subscription ${sub.id} is canceled; there is no next invoice`);
    const price = mustGet<Price>(store, "prices", sub.priceId, "price");
    if (price.interval === "one_time") throw new ActionError("CONFLICT", "Choose a recurring price");
    return {
      subscriptionId: sub.id,
      status: sub.status,
      priceId: price.id,
      productId: sub.productId,
      quantity: sub.quantity,
      currency: price.currency,
      unitAmount: cents(price.amount),
      amount: cents(price.amount * sub.quantity),
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
    };
  },
});

export default {
  actions: [createSubscription, getSubscription, searchSubscriptions, changePlan, updateQuantity, setTrialEnd, pauseSubscription, resumeSubscription, cancelSubscription, previewInvoice],
} satisfies ModuleExports;
