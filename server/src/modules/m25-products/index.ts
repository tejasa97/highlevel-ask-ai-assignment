import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { atLeastOne, contains, Limit, listOf, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import { Product, type ProductVariant } from "./schema.js";

export { Product } from "./schema.js";
import "./fixtures.js";

// Products for sale. Prices live in M26; this module owns the item, its SKU, variants and on-hand counts.
// inventory null means the item is not tracked and is always available. With variants, availability is theirs.

const ProductId = z.string().describe("product id (prd_…)");

function editable(p: Product): void {
  requireState(p.name, p.status, ["active"], "be changed");
}

function skuOwner(store: Store, sku: string, except?: { productId: string; variantId?: string }): string | undefined {
  const key = sku.trim().toLowerCase();
  const same = (other: string | null) => other?.toLowerCase() === key;
  for (const p of store.all<Product>("products")) {
    const skipProduct = except && except.productId === p.id && !except.variantId;
    if (same(p.sku) && !skipProduct) return `product ${p.name} (${p.id})`;
    for (const v of p.variants) {
      const skipVariant = except && except.productId === p.id && except.variantId === v.id;
      if (same(v.sku) && !skipVariant) return `variant ${v.name} on ${p.name} (${v.id})`;
    }
  }
  return undefined;
}

function claimSku(store: Store, sku: string, except?: { productId: string; variantId?: string }): string {
  const key = sku.trim();
  if (!key) throw new ActionError("INVALID", "SKU can't be blank");
  const owner = skuOwner(store, key, except);
  if (owner) throw new ActionError("DUPLICATE", `SKU ${key} is already used by ${owner}`, { sku: key });
  return key;
}

const createProduct = defineAction({
  id: "M25.A01",
  description: "Create a product (name, optional SKU, description and tax category) that can be priced and sold. This records the item itself; M26.A01 Create product price is what sets the amount and currency.",
  risk: "write",
  input: z.strictObject({
    name: z.string().min(1),
    description: z.string().optional(),
    sku: z.string().min(1).optional(),
    taxCategory: z.string().min(1).optional().describe("matches a tax rule's product category"),
    inventory: z.number().int().min(0).nullable().optional().describe("units on hand; null or omitted = not tracked"),
  }),
  output: Product,
  siblings: ["M26.A01"],
  entities: { produces: "product" },
  example: () => ({ name: "Widget", sku: "WDG-1" }),
  handler: (a, { store, clock }) => {
    const sku = a.sku === undefined ? null : claimSku(store, a.sku);
    const now = clock.now().toISOString();
    return store.insert("products", "prd", {
      name: a.name.trim(),
      description: a.description ?? null,
      sku,
      inventory: a.inventory === undefined ? null : a.inventory,
      variants: [],
      taxCategory: a.taxCategory ?? null,
      defaultPriceId: null,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getProduct = defineAction({
  id: "M25.A02",
  description: "Get one product: description, SKU, tax category, default price, variants and on-hand counts. To find several, use M25.A03 Search products.",
  risk: "read",
  input: z.strictObject({ productId: ProductId }),
  output: Product,
  entities: { consumes: ["product"] },
  example: (f) => ({ productId: f.product().id }),
  handler: ({ productId }, { store }) => mustGet<Product>(store, "products", productId, "product"),
});

const searchProducts = defineAction({
  id: "M25.A03",
  description: "Find products by name, SKU, tax category or status (active or archived). Sorted by name, then id. To open one record, use M25.A02 Get product details.",
  risk: "read",
  input: z.strictObject({
    query: z.string().optional().describe("words in the name, SKU or description"),
    status: z.enum(["active", "archived"]).optional(),
    taxCategory: z.string().optional(),
    limit: Limit,
  }),
  output: listOf(Product),
  entities: { produces: "product" },
  example: () => ({ query: "Widget" }),
  handler: (a, { store }) => {
    const query = a.query;
    const items = store.find<Product>(
      "products",
      (p) =>
        (!a.status || p.status === a.status) &&
        (!a.taxCategory || p.taxCategory === a.taxCategory) &&
        (!query || contains(p.name, query) || contains(p.sku, query) || contains(p.description, query) || p.variants.some((v) => contains(v.sku, query) || contains(v.name, query))),
    );
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const updateProduct = defineAction({
  id: "M25.A04",
  description: "Change a product's name, description or tax category. SKU, inventory and variants have their own actions (M25.A08, M25.A09, M25.A06).",
  risk: "write",
  input: z.strictObject({
    productId: ProductId,
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional().describe("null clears it"),
    taxCategory: z.string().min(1).nullable().optional().describe("null clears it; matched by tax rules"),
  }),
  output: Product,
  entities: { consumes: ["product"] },
  example: (f) => ({ productId: f.product({ name: "Widget" }).id, name: "Widget Pro" }),
  handler: (a, { store, clock }) => {
    const p = mustGet<Product>(store, "products", a.productId, "product");
    editable(p);
    atLeastOne(a, ["name", "description", "taxCategory"]);
    const name = a.name === undefined ? p.name : a.name.trim();
    if (!name) throw new ActionError("INVALID", "Name can't be blank");
    const description = a.description === undefined ? p.description : a.description;
    const taxCategory = a.taxCategory === undefined ? p.taxCategory : a.taxCategory;
    if (name === p.name && description === p.description && taxCategory === p.taxCategory) {
      throw new ActionError("CONFLICT", "The product already has those details");
    }
    return store.update<Product>("products", p.id, { name, description, taxCategory, updatedAt: clock.now().toISOString() });
  },
});

const archiveProduct = defineAction({
  id: "M25.A05",
  description: "Archive a product so it can't be edited or added to new quotes. The record is kept; get and search still return it.",
  risk: "destructive",
  input: z.strictObject({ productId: ProductId }),
  output: Product,
  entities: { consumes: ["product"] },
  example: (f) => ({ productId: f.product().id }),
  handler: ({ productId }, { store, clock }) => {
    const p = mustGet<Product>(store, "products", productId, "product");
    requireState(p.name, p.status, ["active"], "be archived");
    return store.update<Product>("products", p.id, { status: "archived", updatedAt: clock.now().toISOString() });
  },
});

const addVariant = defineAction({
  id: "M25.A06",
  description: "Add a variant (its own name, SKU and inventory) under a product. The first variant takes over tracking from the product. To change one later, use M25.A07.",
  risk: "write",
  input: z.strictObject({
    productId: ProductId,
    name: z.string().min(1),
    sku: z.string().min(1).optional(),
    inventory: z.number().int().min(0).nullable().optional().describe("units on hand; omitted on the first variant copies the product count"),
  }),
  output: Product,
  entities: { consumes: ["product"] },
  example: (f) => ({ productId: f.product().id, name: "Large" }),
  handler: (a, { store, clock }) => {
    const p = mustGet<Product>(store, "products", a.productId, "product");
    editable(p);
    const sku = a.sku === undefined ? null : claimSku(store, a.sku);
    const inventory = a.inventory !== undefined ? a.inventory : p.variants.length === 0 ? p.inventory : null;
    const variant: ProductVariant = { id: store.nextId("_nested", "vr"), name: a.name.trim(), sku, inventory };
    return store.update<Product>("products", p.id, {
      variants: [...p.variants, variant],
      inventory: null,
      updatedAt: clock.now().toISOString(),
    });
  },
});

const updateVariant = defineAction({
  id: "M25.A07",
  description: "Change a variant's name, SKU or on-hand count. To add a new variant, use M25.A06; to set the product's own SKU, use M25.A08.",
  risk: "write",
  input: z.strictObject({
    productId: ProductId,
    variantId: z.string().describe("variant id"),
    name: z.string().min(1).optional(),
    sku: z.string().min(1).nullable().optional().describe("null clears it"),
    inventory: z.number().int().min(0).nullable().optional().describe("null stops tracking"),
  }),
  output: Product,
  entities: { consumes: ["product"] },
  example: (f) => {
    const p = f.product({ variants: [{ id: "vr_1", name: "Large", sku: null, inventory: null }] });
    return { productId: p.id, variantId: "vr_1", name: "Large (updated)" };
  },
  handler: (a, { store, clock }) => {
    const p = mustGet<Product>(store, "products", a.productId, "product");
    editable(p);
    atLeastOne(a, ["name", "sku", "inventory"]);
    const current = p.variants.find((v) => v.id === a.variantId);
    if (!current) throw new ActionError("NOT_FOUND", `No variant with id ${a.variantId} on ${p.name}`, { id: a.variantId });
    const name = a.name === undefined ? current.name : a.name.trim();
    const sku = a.sku === undefined ? current.sku : a.sku === null ? null : claimSku(store, a.sku, { productId: p.id, variantId: current.id });
    const inventory = a.inventory === undefined ? current.inventory : a.inventory;
    if (name === current.name && sku === current.sku && inventory === current.inventory) {
      throw new ActionError("CONFLICT", "The variant already has those values");
    }
    const variants = p.variants.map((v) => (v.id === current.id ? { ...v, name, sku, inventory } : v));
    return store.update<Product>("products", p.id, { variants, updatedAt: clock.now().toISOString() });
  },
});

const setSku = defineAction({
  id: "M25.A08",
  description: "Set the product's own SKU. It must be unique across products and variants. To set a variant's SKU, use M25.A07 Update product variant.",
  risk: "write",
  input: z.strictObject({ productId: ProductId, sku: z.string().min(1) }),
  output: Product,
  entities: { consumes: ["product"] },
  example: (f) => ({ productId: f.product().id, sku: "WDG-1" }),
  handler: ({ productId, sku }, { store, clock }) => {
    const p = mustGet<Product>(store, "products", productId, "product");
    editable(p);
    const key = claimSku(store, sku, { productId: p.id });
    if (p.sku === key) throw new ActionError("CONFLICT", `The product already has SKU ${key}`);
    return store.update<Product>("products", p.id, { sku: key, updatedAt: clock.now().toISOString() });
  },
});

const setInventory = defineAction({
  id: "M25.A09",
  description: "Set how many units are on hand, or null to stop tracking. With variants, pass variantId; the product total is the sum of theirs. To read the count, use M25.A10.",
  risk: "write",
  input: z.strictObject({
    productId: ProductId,
    quantity: z.number().int().min(0).nullable().describe("units on hand; null stops tracking"),
    variantId: z.string().optional().describe("required when the product has variants"),
  }),
  output: Product,
  entities: { consumes: ["product"] },
  example: (f) => ({ productId: f.product().id, quantity: 12 }),
  handler: (a, { store, clock }) => {
    const p = mustGet<Product>(store, "products", a.productId, "product");
    editable(p);
    const now = clock.now().toISOString();
    if (a.variantId) {
      const current = p.variants.find((v) => v.id === a.variantId);
      if (!current) throw new ActionError("NOT_FOUND", `No variant with id ${a.variantId} on ${p.name}`, { id: a.variantId });
      if (current.inventory === a.quantity) {
        throw new ActionError("CONFLICT", a.quantity === null ? "That variant's inventory is already not tracked" : `That variant already has ${a.quantity} on hand`);
      }
      const variants = p.variants.map((v) => (v.id === current.id ? { ...v, inventory: a.quantity } : v));
      return store.update<Product>("products", p.id, { variants, updatedAt: now });
    }
    if (p.variants.length > 0) throw new ActionError("CONFLICT", `${p.name} has variants; set the quantity on a variant`);
    if (p.inventory === a.quantity) {
      throw new ActionError("CONFLICT", a.quantity === null ? "Inventory is already not tracked" : `The product already has ${a.quantity} on hand`);
    }
    return store.update<Product>("products", p.id, { inventory: a.quantity, updatedAt: now });
  },
});

const Availability = z.object({
  productId: z.string(),
  name: z.string(),
  /** False when the product (or any variant) is not tracked and therefore always available. */
  tracked: z.boolean(),
  /** Null when not tracked. With variants, the sum of theirs; null if any variant is untracked. */
  available: z.number().int().nullable(),
  onHand: z.number().int().describe("sum of tracked units; untracked variants count as 0 here"),
  variants: z.array(z.object({ id: z.string(), name: z.string(), sku: z.string().nullable(), tracked: z.boolean(), available: z.number().int().nullable() })),
});

const getInventory = defineAction({
  id: "M25.A10",
  description: "Read how many units can be sold. Null inventory is not tracked (always available). With variants, availability is the sum of theirs and is null if any variant is untracked. This does not change the count; M25.A09 does.",
  risk: "read",
  input: z.strictObject({ productId: ProductId }),
  output: Availability,
  entities: { consumes: ["product"] },
  example: (f) => ({ productId: f.product({ inventory: 4 }).id }),
  handler: ({ productId }, { store }) => {
    const p = mustGet<Product>(store, "products", productId, "product");
    const variants = p.variants.map((v) => ({ id: v.id, name: v.name, sku: v.sku, tracked: v.inventory !== null, available: v.inventory }));
    if (variants.length === 0) {
      return { productId: p.id, name: p.name, tracked: p.inventory !== null, available: p.inventory, onHand: p.inventory ?? 0, variants };
    }
    const onHand = variants.reduce((sum, v) => sum + (v.available ?? 0), 0);
    const tracked = variants.every((v) => v.tracked);
    return { productId: p.id, name: p.name, tracked, available: tracked ? onHand : null, onHand, variants };
  },
});

export default {
  actions: [createProduct, getProduct, searchProducts, updateProduct, archiveProduct, addVariant, updateVariant, setSku, setInventory, getInventory],
} satisfies ModuleExports;
