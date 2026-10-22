import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { cents, contains, Limit, listOf, notPast, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import { localDate } from "../../store/clock.js";
import type { Store } from "../../store/db.js";
import type { Contact } from "../m01-contacts/schema.js";
import type { Product } from "../m25-products/schema.js";
import { TaxExemption, TaxRule } from "./schema.js";

export { TaxRule, TaxExemption } from "./schema.js";
import "./fixtures.js";

// Tax on a line is computed after discount. A longer region (US-CA) beats the country (US).
// Inside that region, a matching product category beats a rule with no category.
// Inclusive tax is carved out of the amount; exclusive tax is added. A live exemption zeros the line.

const RuleId = z.string().describe("tax rule id (tx_…)");
const Region = z.string().regex(/^[A-Za-z]{2}(-[A-Za-z0-9]{1,8})?$/, "use a country (US) or country-region (US-CA)");

const norm = (s: string) => s.trim().toUpperCase();

export interface TaxLineIn {
  productId: string;
  amount: number;
  taxCategory: string | null;
}

export interface TaxLineOut {
  productId: string;
  amount: number;
  tax: number;
  rate: number;
  inclusive: boolean;
  ruleId: string | null;
}

export interface TaxResult {
  exempt: boolean;
  lines: TaxLineOut[];
  taxTotal: number;
  exclusiveTax: number;
  subtotal: number;
  discountTotal: number;
  total: number;
}

function lineTax(amount: number, rule: TaxRule): number {
  if (rule.inclusive) return cents(amount - amount / (1 + rule.rate / 100));
  return cents(amount * rule.rate / 100);
}

function pickRule(rules: TaxRule[], country: string, specific: string, category: string | null): TaxRule | undefined {
  const active = rules.filter((rule) => rule.status === "active");
  const fits = (rule: TaxRule) => rule.productCategory === null || rule.productCategory === category;
  const inSpecific = specific ? active.filter((rule) => norm(rule.region) === specific && fits(rule)) : [];
  const pool = inSpecific.length > 0 ? inSpecific : active.filter((rule) => norm(rule.region) === country && fits(rule));
  const exact = category !== null ? pool.filter((rule) => rule.productCategory === category) : [];
  const chosen = exact.length > 0 ? exact : pool.filter((rule) => rule.productCategory === null);
  return chosen.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
}

function exemptionCovers(ex: TaxExemption, country: string, specific: string, today: string): boolean {
  if (ex.expiresAt && ex.expiresAt.slice(0, 10) < today) return false;
  if (ex.regions.length === 0) return true;
  const keys = new Set(ex.regions.map(norm));
  return keys.has(country) || (specific !== "" && keys.has(specific));
}

/**
 * Tax for lines whose amounts are already after discount.
 * Order total = subtotal - discountTotal + exclusive tax only. Inclusive tax is not added.
 * When two rules tie on region and category, the lowest id wins.
 */
export function calculateTax(input: {
  rules: TaxRule[];
  exemptions: TaxExemption[];
  country: string;
  region?: string | null;
  today: string;
  lines: TaxLineIn[];
  subtotal?: number;
  discountTotal?: number;
}): TaxResult {
  const country = norm(input.country);
  const area = input.region ? norm(input.region) : "";
  const specific = area ? `${country}-${area}` : "";
  const exempt = input.exemptions.some((ex) => exemptionCovers(ex, country, specific, input.today));
  const lines = input.lines.map((line) => {
    const rule = exempt ? undefined : pickRule(input.rules, country, specific, line.taxCategory);
    const tax = rule ? lineTax(line.amount, rule) : 0;
    return {
      productId: line.productId,
      amount: cents(line.amount),
      tax,
      rate: rule?.rate ?? 0,
      inclusive: rule?.inclusive ?? false,
      ruleId: rule?.id ?? null,
    };
  });
  const taxTotal = cents(lines.reduce((sum, line) => sum + line.tax, 0));
  const exclusiveTax = cents(lines.reduce((sum, line) => sum + (line.inclusive ? 0 : line.tax), 0));
  const lineSum = cents(lines.reduce((sum, line) => sum + line.amount, 0));
  const subtotal = input.subtotal ?? lineSum;
  const discountTotal = input.discountTotal ?? 0;
  return { exempt, lines, taxTotal, exclusiveTax, subtotal, discountTotal, total: cents(subtotal - discountTotal + exclusiveTax) };
}

function clash(store: Store, region: string, productCategory: string | null, exceptId?: string): TaxRule | undefined {
  const key = norm(region);
  return store.find<TaxRule>(
    "tax_rules",
    (rule) => rule.status === "active" && rule.id !== exceptId && norm(rule.region) === key && rule.productCategory === productCategory,
  )[0];
}

function nameTaken(store: Store, name: string): TaxRule | undefined {
  const key = name.trim().toLowerCase();
  return store.find<TaxRule>("tax_rules", (rule) => rule.name.trim().toLowerCase() === key)[0];
}

function activeRule(store: Store, id: string): TaxRule {
  const rule = mustGet<TaxRule>(store, "tax_rules", id, "tax rule");
  requireState(`Tax rule ${rule.name}`, rule.status, ["active"], "be changed");
  return rule;
}

const createRule = defineAction({
  id: "M34.A01",
  description: "Create a tax rule: a percent rate for a country or country-region, optionally only one product category, inclusive or added on top. To compute what an order would owe, use M34.A09.",
  risk: "write",
  input: z.strictObject({
    name: z.string().min(1),
    rate: z.number().min(0).max(100),
    region: Region,
    productCategory: z.string().min(1).nullable().optional().describe("null = every category"),
    inclusive: z.boolean().optional().describe("default false: tax is added on top"),
  }),
  output: TaxRule,
  entities: { produces: "tax_rule" },
  example: () => ({ name: "CA sales", rate: 8.25, region: "US-CA" }),
  handler: (a, { store, clock }) => {
    const name = a.name.trim();
    const dupName = nameTaken(store, name);
    if (dupName) throw new ActionError("DUPLICATE", `A tax rule named "${dupName.name}" already exists (${dupName.id})`, { existingId: dupName.id });
    const region = norm(a.region);
    const productCategory = a.productCategory ?? null;
    const dup = clash(store, region, productCategory);
    if (dup) throw new ActionError("DUPLICATE", `An active tax rule for ${region}${productCategory ? ` / ${productCategory}` : " (every category)"} already exists (${dup.id})`, { existingId: dup.id });
    const now = clock.now().toISOString();
    return store.insert("tax_rules", "tx", {
      name,
      rate: a.rate,
      region,
      productCategory,
      inclusive: a.inclusive ?? false,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getRule = defineAction({
  id: "M34.A02",
  description: "Get one tax rule: rate, region, product category, whether the price already includes tax, and whether it is active. To list them, use M34.A03.",
  risk: "read",
  input: z.strictObject({ taxRuleId: RuleId }),
  output: TaxRule,
  entities: { consumes: ["tax_rule"] },
  example: (f) => ({ taxRuleId: f.taxRule().id }),
  handler: ({ taxRuleId }, { store }) => mustGet<TaxRule>(store, "tax_rules", taxRuleId, "tax rule"),
});

const listRules = defineAction({
  id: "M34.A03",
  description: "List tax rules, sorted by name, then id. Filter by region, product category or status. To open one, use M34.A02 Get tax rule.",
  risk: "read",
  input: z.strictObject({
    region: Region.optional(),
    productCategory: z.string().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    query: z.string().optional(),
    limit: Limit,
  }),
  output: listOf(TaxRule),
  entities: { produces: "tax_rule" },
  example: () => ({}),
  handler: (a, { store }) => {
    const region = a.region ? norm(a.region) : undefined;
    const items = store.find<TaxRule>(
      "tax_rules",
      (rule) =>
        (!region || norm(rule.region) === region) &&
        (!a.productCategory || rule.productCategory === a.productCategory) &&
        (!a.status || rule.status === a.status) &&
        (!a.query || contains(rule.name, a.query)),
    );
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const setRate = defineAction({
  id: "M34.A04",
  description: "Change a tax rule's percent rate (0–100). The region and category stay the same. To see the money this produces, use M34.A09 Calculate tax.",
  risk: "write",
  input: z.strictObject({ taxRuleId: RuleId, rate: z.number().min(0).max(100) }),
  output: TaxRule,
  entities: { consumes: ["tax_rule"] },
  example: (f) => ({ taxRuleId: f.taxRule({ rate: 5 }).id, rate: 8 }),
  handler: ({ taxRuleId, rate }, { store, clock }) => {
    const rule = activeRule(store, taxRuleId);
    if (rule.rate === rate) throw new ActionError("CONFLICT", `The rate is already ${rate}`);
    return store.update<TaxRule>("tax_rules", rule.id, { rate, updatedAt: clock.now().toISOString() });
  },
});

const setRegion = defineAction({
  id: "M34.A05",
  description: "Set the country (US) or country-region (US-CA) a tax rule applies to. A more specific region wins when tax is calculated. This does not change the rate.",
  risk: "write",
  input: z.strictObject({ taxRuleId: RuleId, region: Region }),
  output: TaxRule,
  entities: { consumes: ["tax_rule"] },
  example: (f) => ({ taxRuleId: f.taxRule({ region: "US" }).id, region: "US-NY" }),
  handler: ({ taxRuleId, region }, { store, clock }) => {
    const rule = activeRule(store, taxRuleId);
    const next = norm(region);
    if (rule.region === next) throw new ActionError("CONFLICT", `The region is already ${next}`);
    const dup = clash(store, next, rule.productCategory, rule.id);
    if (dup) throw new ActionError("DUPLICATE", `An active tax rule for ${next} already exists (${dup.id})`, { existingId: dup.id });
    return store.update<TaxRule>("tax_rules", rule.id, { region: next, updatedAt: clock.now().toISOString() });
  },
});

const setCategory = defineAction({
  id: "M34.A06",
  description: "Set which product tax category this rule applies to, or null for every category. This does not change a product's tax category; M25.A04 does that. A category match beats a rule with no category.",
  risk: "write",
  input: z.strictObject({ taxRuleId: RuleId, productCategory: z.string().min(1).nullable() }),
  output: TaxRule,
  entities: { consumes: ["tax_rule"] },
  example: (f) => ({ taxRuleId: f.taxRule().id, productCategory: "food" }),
  handler: ({ taxRuleId, productCategory }, { store, clock }) => {
    const rule = activeRule(store, taxRuleId);
    if (rule.productCategory === productCategory) {
      throw new ActionError("CONFLICT", productCategory ? `The category is already ${productCategory}` : "The rule already applies to every category");
    }
    const dup = clash(store, rule.region, productCategory, rule.id);
    if (dup) throw new ActionError("DUPLICATE", `An active tax rule for ${rule.region} and that category already exists (${dup.id})`, { existingId: dup.id });
    return store.update<TaxRule>("tax_rules", rule.id, { productCategory, updatedAt: clock.now().toISOString() });
  },
});

const setInclusive = defineAction({
  id: "M34.A07",
  description: "Choose whether prices already include this tax (carved out of the line) or the tax is added on top. This does not change the rate or the region.",
  risk: "write",
  input: z.strictObject({ taxRuleId: RuleId, inclusive: z.boolean() }),
  output: TaxRule,
  entities: { consumes: ["tax_rule"] },
  example: (f) => ({ taxRuleId: f.taxRule({ inclusive: false }).id, inclusive: true }),
  handler: ({ taxRuleId, inclusive }, { store, clock }) => {
    const rule = activeRule(store, taxRuleId);
    if (rule.inclusive === inclusive) {
      throw new ActionError("CONFLICT", inclusive ? "Prices are already tax-inclusive for this rule" : "This rule is already added on top of the price");
    }
    return store.update<TaxRule>("tax_rules", rule.id, { inclusive, updatedAt: clock.now().toISOString() });
  },
});

const recordExemption = defineAction({
  id: "M34.A08",
  description: "Record a customer's tax exemption certificate. Empty regions means exempt everywhere; otherwise list countries or country-regions. An expiry before today is refused. Calculation (M34.A09) honors a live exemption.",
  risk: "write",
  input: z.strictObject({
    contactId: z.string().describe("contact id (ct_…)"),
    certificateNumber: z.string().min(1),
    reason: z.string().optional(),
    regions: z.array(Region).optional().describe("empty = exempt everywhere"),
    expiresAt: z.iso.date().nullable().optional().describe("YYYY-MM-DD; null = no expiry"),
  }),
  output: TaxExemption,
  entities: { produces: "contact", consumes: ["contact"] },
  example: (f) => ({ contactId: f.contact().id, certificateNumber: "EX-100" }),
  handler: (a, { store, clock, actorId }) => {
    const contact = mustGet<Contact>(store, "contacts", a.contactId, "contact");
    const certificateNumber = a.certificateNumber.trim();
    if (!certificateNumber) throw new ActionError("INVALID", "Certificate number can't be blank");
    const dup = store.find<TaxExemption>("tax_exemptions", (ex) => ex.contactId === contact.id && ex.certificateNumber.toLowerCase() === certificateNumber.toLowerCase())[0];
    if (dup) throw new ActionError("DUPLICATE", `Certificate ${certificateNumber} is already on file for ${contact.name} (${dup.id})`, { existingId: dup.id });
    const today = localDate(clock.now());
    if (a.expiresAt) notPast(a.expiresAt, today, "expiresAt");
    return store.insert("tax_exemptions", "txe", {
      contactId: contact.id,
      certificateNumber,
      reason: a.reason ?? null,
      regions: (a.regions ?? []).map(norm),
      expiresAt: a.expiresAt ?? null,
      recordedBy: actorId ?? "us_1",
      createdAt: clock.now().toISOString(),
    });
  },
});

const TaxOut = z.object({
  exempt: z.boolean(),
  lines: z.array(z.object({
    productId: z.string(),
    amount: z.number(),
    tax: z.number(),
    rate: z.number(),
    inclusive: z.boolean(),
    ruleId: z.string().nullable(),
  })),
  taxTotal: z.number(),
  exclusiveTax: z.number().describe("only tax that is added on top"),
  subtotal: z.number(),
  discountTotal: z.number(),
  total: z.number().describe("subtotal - discountTotal + exclusive tax"),
});

const calculate = defineAction({
  id: "M34.A09",
  description: "Calculate tax for an order without writing anything. Line amounts are after discount. A country-region rule beats a country rule, and a matching product category beats a rule with no category. Inclusive tax is carved out and not added; exclusive tax is added. A live exemption zeros the tax. Submitting the order is M32.A08.",
  risk: "read",
  input: z.strictObject({
    contactId: z.string().describe("contact id (ct_…)"),
    country: z.string().regex(/^[A-Za-z]{2}$/),
    region: z.string().regex(/^[A-Za-z0-9]{1,8}$/).optional().describe("state or province, e.g. CA → US-CA"),
    lines: z.array(z.strictObject({
      productId: z.string(),
      amount: z.number().min(0).describe("USD, after discount"),
    })),
    subtotal: z.number().min(0).optional().describe("before discount; defaults to the sum of line amounts"),
    discountTotal: z.number().min(0).optional().describe("defaults to 0"),
  }),
  output: TaxOut,
  siblings: ["M32.A08"],
  entities: { consumes: ["tax_rule", "product"] },
  example: (f) => {
    const product = f.product({ taxCategory: "food" });
    f.taxRule({ region: "US", rate: 10, productCategory: "food" });
    return { contactId: f.contact().id, country: "US", lines: [{ productId: product.id, amount: 50 }] };
  },
  handler: (a, { store, clock }) => {
    mustGet<Contact>(store, "contacts", a.contactId, "contact");
    const lines = a.lines.map((line) => {
      const product = mustGet<Product>(store, "products", line.productId, "product");
      return { productId: product.id, amount: cents(line.amount), taxCategory: product.taxCategory };
    });
    return calculateTax({
      rules: store.all<TaxRule>("tax_rules"),
      exemptions: store.find<TaxExemption>("tax_exemptions", (ex) => ex.contactId === a.contactId),
      country: a.country,
      region: a.region ?? null,
      today: localDate(clock.now()),
      lines,
      subtotal: a.subtotal,
      discountTotal: a.discountTotal,
    });
  },
});

const deactivateRule = defineAction({
  id: "M34.A10",
  description: "Deactivate a tax rule so calculation ignores it. The record is kept and can still be read. Get and list still return it.",
  risk: "destructive",
  input: z.strictObject({ taxRuleId: RuleId }),
  output: TaxRule,
  entities: { consumes: ["tax_rule"] },
  example: (f) => ({ taxRuleId: f.taxRule().id }),
  handler: ({ taxRuleId }, { store, clock }) => {
    const rule = mustGet<TaxRule>(store, "tax_rules", taxRuleId, "tax rule");
    requireState(`Tax rule ${rule.name}`, rule.status, ["active"], "be deactivated");
    return store.update<TaxRule>("tax_rules", rule.id, { status: "inactive", updatedAt: clock.now().toISOString() });
  },
});

export default {
  actions: [createRule, getRule, listRules, setRate, setRegion, setCategory, setInclusive, recordExemption, calculate, deactivateRule],
} satisfies ModuleExports;
