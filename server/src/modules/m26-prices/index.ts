import { namedResolver } from "../../registry/lookup.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { cents, Limit, listOf, Name, norm, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports, Resolver } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Product } from "../m25-products/schema.js";
import { BILLING_INTERVALS, CURRENCIES, Price } from "./schema.js";

export { Price } from "./schema.js";
import "./fixtures.js";

// One product has many prices. Exactly one active price is the default, and that id is also
// products.defaultPriceId. Quotes and orders reject anything that isn't USD; a price may still be EUR.

const PriceId = z.string().describe("price id (prc_…)");
const ProductId = z.string().describe("product id (prd_…)");

function activeProduct(store: Store, id: string): Product {
  const p = mustGet<Product>(store, "products", id, "product");
  requireState(p.name, p.status, ["active"], "be priced");
  return p;
}

function activePrice(store: Store, id: string, doing: string): Price {
  const price = mustGet<Price>(store, "prices", id, "price");
  requireState(`Price ${price.label}`, price.status, ["active"], doing);
  return price;
}

function makeDefault(store: Store, price: Price, at: string): void {
  for (const other of store.find<Price>("prices", (p) => p.productId === price.productId && p.id !== price.id && p.isDefault)) {
    store.update("prices", other.id, { isDefault: false, updatedAt: at });
  }
  store.update<Product>("products", price.productId, { defaultPriceId: price.id, updatedAt: at });
}

const createPrice = defineAction({
  id: "M26.A01",
  description: "Create a price for a product: amount, currency, and how often it bills. The first active price becomes the default. To create the product itself, use M25.A01 Create product.",
  risk: "write",
  input: z.strictObject({
    productId: ProductId,
    label: Name,
    amount: z.number().min(0).describe("in the price's currency"),
    currency: z.enum(CURRENCIES).optional().describe("default USD; quotes and orders still only accept USD"),
    interval: z.enum(BILLING_INTERVALS).optional().describe("default one_time"),
    intervalCount: z.number().int().min(1).optional().describe("every N intervals; 1 for one_time"),
    trialDays: z.number().int().min(0).optional(),
  }),
  output: Price,
  siblings: ["M25.A01"],
  entities: { produces: "price", consumes: ["product"] },
  example: (f) => ({ productId: f.product().id, label: "Standard", amount: 20 }),
  handler: (a, { store, clock }) => {
    const product = activeProduct(store, a.productId);
    const interval = a.interval ?? "one_time";
    const intervalCount = interval === "one_time" ? 1 : (a.intervalCount ?? 1);
    if (interval === "one_time" && a.intervalCount !== undefined && a.intervalCount !== 1) {
      throw new ActionError("INVALID", "A one_time price bills once; intervalCount must be 1");
    }
    const trialDays = a.trialDays ?? 0;
    if (interval === "one_time" && trialDays > 0) throw new ActionError("CONFLICT", "Choose a recurring price");
    const now = clock.now().toISOString();
    const hasDefault = store.find<Price>("prices", (p) => p.productId === product.id && p.status === "active" && p.isDefault).length > 0;
    const row = store.insert("prices", "prc", {
      productId: product.id,
      label: a.label,
      amount: cents(a.amount),
      currency: a.currency ?? "USD",
      interval,
      intervalCount,
      trialDays,
      isDefault: !hasDefault,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    if (row.isDefault) makeDefault(store, row, now);
    return row;
  },
});

const getPrice = defineAction({
  id: "M26.A02",
  description: "Get one price: amount, currency, billing interval, trial and whether it is the product's default. To see every price on a product, use M26.A03.",
  risk: "read",
  input: z.strictObject({ priceId: PriceId }),
  output: Price,
  entities: { consumes: ["price"] },
  example: (f) => ({ priceId: f.price().id }),
  handler: ({ priceId }, { store }) => mustGet<Price>(store, "prices", priceId, "price"),
});

const listPrices = defineAction({
  id: "M26.A03",
  description: "List the prices on one product, sorted by label, then id. Filter by status or currency. To open a single price, use M26.A02 Get price details.",
  risk: "read",
  input: z.strictObject({
    productId: ProductId,
    status: z.enum(["active", "archived"]).optional(),
    currency: z.enum(CURRENCIES).optional(),
    limit: Limit,
  }),
  output: listOf(Price),
  entities: { produces: "price", consumes: ["product"] },
  example: (f) => ({ productId: f.product().id }),
  handler: (a, { store }) => {
    mustGet<Product>(store, "products", a.productId, "product");
    const items = store.find<Price>(
      "prices",
      (p) => p.productId === a.productId && (!a.status || p.status === a.status) && (!a.currency || p.currency === a.currency),
    );
    items.sort((x, y) => x.label.localeCompare(y.label) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const updateLabel = defineAction({
  id: "M26.A04",
  description: "Rename a price's label. The amount, currency and billing interval stay as they are; those have their own actions.",
  risk: "write",
  input: z.strictObject({ priceId: PriceId, label: Name }),
  output: Price,
  entities: { consumes: ["price"] },
  example: (f) => ({ priceId: f.price({ label: "Monthly" }).id, label: "Annual" }),
  handler: ({ priceId, label }, { store, clock }) => {
    const price = activePrice(store, priceId, "be renamed");
    if (price.label === label) throw new ActionError("CONFLICT", `The price is already called "${price.label}"`);
    return store.update<Price>("prices", price.id, { label, updatedAt: clock.now().toISOString() });
  },
});

const setAmount = defineAction({
  id: "M26.A05",
  description: "Change how much an existing price charges. Rounded to cents. To create the product this price belongs to, use M25.A01 Create product.",
  risk: "write",
  input: z.strictObject({ priceId: PriceId, amount: z.number().min(0) }),
  output: Price,
  siblings: ["M25.A01"],
  entities: { consumes: ["price"] },
  example: (f) => ({ priceId: f.price().id, amount: 25 }),
  handler: ({ priceId, amount }, { store, clock }) => {
    const price = activePrice(store, priceId, "change amount");
    const next = cents(amount);
    if (price.amount === next) throw new ActionError("CONFLICT", `The price is already ${price.amount}`);
    return store.update<Price>("prices", price.id, { amount: next, updatedAt: clock.now().toISOString() });
  },
});

const setCurrency = defineAction({
  id: "M26.A06",
  description: "Set a price's currency (USD, EUR, GBP, CAD or AUD). This does not convert the amount. Quotes and orders still reject anything other than USD.",
  risk: "write",
  input: z.strictObject({ priceId: PriceId, currency: z.enum(CURRENCIES) }),
  output: Price,
  entities: { consumes: ["price"] },
  example: (f) => ({ priceId: f.price().id, currency: "EUR" }),
  handler: ({ priceId, currency }, { store, clock }) => {
    const price = activePrice(store, priceId, "change currency");
    if (price.currency === currency) throw new ActionError("CONFLICT", `The price is already ${currency}`);
    return store.update<Price>("prices", price.id, { currency, updatedAt: clock.now().toISOString() });
  },
});

const setInterval = defineAction({
  id: "M26.A07",
  description: "Set how often a price bills (one_time, day, week, month or year) and the interval count. A one_time price bills once. To change the amount, use M26.A05.",
  risk: "write",
  input: z.strictObject({
    priceId: PriceId,
    interval: z.enum(BILLING_INTERVALS),
    intervalCount: z.number().int().min(1).optional().describe("default keeps the current count, or 1 for one_time"),
  }),
  output: Price,
  entities: { consumes: ["price"] },
  example: (f) => ({ priceId: f.price().id, interval: "month" }),
  handler: (a, { store, clock }) => {
    const price = activePrice(store, a.priceId, "change billing interval");
    const intervalCount = a.interval === "one_time" ? 1 : (a.intervalCount ?? (price.interval === "one_time" ? 1 : price.intervalCount));
    if (a.interval === "one_time" && a.intervalCount !== undefined && a.intervalCount !== 1) {
      throw new ActionError("INVALID", "A one_time price bills once; intervalCount must be 1");
    }
    if (a.interval === "one_time" && price.trialDays > 0) {
      throw new ActionError("CONFLICT", "Clear the trial before making this price one_time");
    }
    if (price.interval === a.interval && price.intervalCount === intervalCount) {
      throw new ActionError("CONFLICT", `The price already bills every ${intervalCount} ${a.interval}`);
    }
    return store.update<Price>("prices", price.id, { interval: a.interval, intervalCount, updatedAt: clock.now().toISOString() });
  },
});

const setTrial = defineAction({
  id: "M26.A08",
  description: "Set how many days a recurring price is free before the first bill. Pass 0 to clear it. A one_time price can't have a trial; choose a recurring price first.",
  risk: "write",
  input: z.strictObject({ priceId: PriceId, trialDays: z.number().int().min(0) }),
  output: Price,
  entities: { consumes: ["price"] },
  example: (f) => ({ priceId: f.price({ interval: "month" }).id, trialDays: 14 }),
  handler: ({ priceId, trialDays }, { store, clock }) => {
    const price = activePrice(store, priceId, "change its trial");
    if (price.interval === "one_time" && trialDays > 0) throw new ActionError("CONFLICT", "Choose a recurring price");
    if (price.trialDays === trialDays) throw new ActionError("CONFLICT", `The trial is already ${trialDays} days`);
    return store.update<Price>("prices", price.id, { trialDays, updatedAt: clock.now().toISOString() });
  },
});

const setDefault = defineAction({
  id: "M26.A09",
  description: "Make this the product's default price. Any other default on that product is unset, and products.defaultPriceId is updated. Exactly one active default remains.",
  risk: "write",
  input: z.strictObject({ priceId: PriceId }),
  output: Price,
  entities: { consumes: ["price", "product"] },
  example: (f) => {
    const product = f.product();
    f.price({ productId: product.id, isDefault: true, label: "Standard" });
    return { priceId: f.price({ productId: product.id, isDefault: false, label: "Alt" }).id };
  },
  handler: ({ priceId }, { store, clock }) => {
    const price = activePrice(store, priceId, "be the default");
    const product = mustGet<Product>(store, "products", price.productId, "product");
    if (price.isDefault && product.defaultPriceId === price.id) {
      throw new ActionError("CONFLICT", `${price.label} is already the default price for ${product.name}`);
    }
    const now = clock.now().toISOString();
    makeDefault(store, price, now);
    return store.update<Price>("prices", price.id, { isDefault: true, updatedAt: now });
  },
});

const archivePrice = defineAction({
  id: "M26.A10",
  description: "Archive a price so it can't be sold. Archiving the default is refused until another default is chosen with M26.A09. Get and list still return it.",
  risk: "destructive",
  input: z.strictObject({ priceId: PriceId }),
  output: Price,
  entities: { consumes: ["price"] },
  example: (f) => {
    const product = f.product();
    f.price({ productId: product.id, isDefault: true, label: "Standard" });
    return { priceId: f.price({ productId: product.id, isDefault: false, label: "Wholesale" }).id };
  },
  handler: ({ priceId }, { store, clock }) => {
    const price = mustGet<Price>(store, "prices", priceId, "price");
    requireState(`Price ${price.label}`, price.status, ["active"], "be archived");
    const product = store.get<Product>("products", price.productId);
    if (price.isDefault || product?.defaultPriceId === price.id) {
      throw new ActionError("CONFLICT", `${price.label} is the default for ${product?.name ?? "this product"}; choose another default price first`);
    }
    return store.update<Price>("prices", price.id, { status: "archived", isDefault: false, updatedAt: clock.now().toISOString() });
  },
});

/** A price is named by its product as much as its label: "Pro", "Pro Monthly" and "Monthly" all find Pro's monthly price.
 *  Naming only the product picks its default price, since that is the one used when none is chosen. */
function priceResolver(): Resolver {
  type Named = Price & { product: Product | undefined };
  const base = namedResolver<Named>({
    exactMention: true,
    records: (store) => store.all<Price>("prices").map((p) => ({ ...p, product: store.get<Product>("products", p.productId) })),
    name: (p) => [p.product?.name, p.label].filter(Boolean).join(" "),
    detail: (p) => `${p.currency} ${p.amount}${p.interval === "one_time" ? "" : ` per ${p.interval}`}`,
    inactive: (p) => (p.status === "archived" ? "archived" : undefined),
    qualifiers: { productId: (p) => p.productId, currency: (p) => p.currency, interval: (p) => p.interval },
  });
  return Object.assign((store: Store, name: string, where?: Record<string, string>) => {
    const found = base(store, name, where);
    const prices = found.map((c) => store.get<Price>("prices", c.id)!);
    const product = prices[0] && store.get<Product>("products", prices[0].productId);
    const def = prices.find((p) => p.isDefault);
    const onlyProduct = product && norm(product.name) === norm(name) && prices.every((p) => p.productId === product.id);
    return found.length > 1 && onlyProduct && def ? found.filter((c) => c.id === def.id) : found;
  }, { qualifiers: base.qualifiers, exactMention: base.exactMention });
}

export default {
  resolvers: {
    price: priceResolver(),
  },
  actions: [createPrice, getPrice, listPrices, updateLabel, setAmount, setCurrency, setInterval, setTrial, setDefault, archivePrice],
} satisfies ModuleExports;
