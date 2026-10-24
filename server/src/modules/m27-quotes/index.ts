import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { atLeastOne, cents, contains, inDateRange, Limit, listOf, page, requirePermission, requireState } from "../../registry/helpers.js";
import { ownedResolver } from "../../registry/lookup.js";
import type { ModuleExports } from "../../registry/registry.js";
import { localDate } from "../../store/clock.js";
import type { Store } from "../../store/db.js";
import type { Contact } from "../m01-contacts/schema.js";
import { requireReachable } from "../m11-conversations/messaging.js";
import type { Opportunity } from "../m04-opportunities/schema.js";
import type { Price } from "../m26-prices/schema.js";
import type { Product } from "../m25-products/schema.js";
import { nextInvoiceNumber } from "../m28-invoices/billing.js";
import { Invoice, type LineItem } from "../m28-invoices/schema.js";
import { discountAmount } from "../m31-coupons/index.js";
import { Discount } from "../m31-coupons/schema.js";
import { Quote, type QuoteLine } from "./schema.js";

export { Quote } from "./schema.js";
import "./fixtures.js";

// Quotes are USD only. A non-USD price can't be added. Sending does not write an emails row.
// Converting an accepted quote opens an invoice for the discounted total and marks the quote converted.

const QuoteId = z.string().describe("quote id (qt_…)");
const When = z.iso.datetime({ offset: true });

function checkDiscount(d: Discount): void {
  if (d.type === "percent" && d.value > 100) throw new ActionError("INVALID", "A percent discount can't be more than 100");
}

function totals(lines: QuoteLine[], discount: Discount | null): { subtotal: number; total: number } {
  const subtotal = cents(lines.reduce((sum, line) => sum + line.amount, 0));
  return { subtotal, total: cents(subtotal - (discount ? discountAmount(subtotal, discount) : 0)) };
}

function sameDiscount(a: Discount | null, b: Discount | null): boolean {
  if (a === null || b === null) return a === b;
  return a.type === b.type && a.value === b.value;
}

function activeContact(store: Store, id: string, doing: string): Contact {
  const c = mustGet<Contact>(store, "contacts", id, "contact");
  if (c.status === "merged") throw new ActionError("CONFLICT", `${c.name} was merged into ${c.mergedInto}; use that contact instead`, { mergedInto: c.mergedInto });
  requireState(c.name, c.status, ["active"], doing);
  return c;
}

function opportunityFor(store: Store, contactId: string, opportunityId?: string | null): string | null {
  if (!opportunityId) return null;
  const o = mustGet<Opportunity>(store, "opportunities", opportunityId, "opportunity");
  if (o.contactId !== contactId) throw new ActionError("CONFLICT", `Opportunity ${o.name} belongs to a different contact`);
  return o.id;
}

function nextQuoteNumber(store: Store): string {
  return `QT-${1001 + store.all("quotes").length}`;
}

const LineDraft = z.strictObject({
  priceId: z.string().optional().describe("price id (prc_…); USD only"),
  productId: z.string().optional().describe("product id; uses its default price when priceId is omitted"),
  description: z.string().min(1).optional(),
  quantity: z.number().positive().optional().describe("default 1"),
  unitPrice: z.number().min(0).optional().describe("USD, for a custom line with no price"),
});

function buildLine(store: Store, draft: z.infer<typeof LineDraft>): QuoteLine {
  const quantity = draft.quantity ?? 1;
  let priceId = draft.priceId ?? null;
  let productId = draft.productId ?? null;
  let unitPrice: number;
  let description: string;
  if (priceId || productId) {
    if (!priceId && productId) {
      const named = mustGet<Product>(store, "products", productId, "product");
      if (!named.defaultPriceId) throw new ActionError("CONFLICT", `Set a default price for ${named.name} first`);
      priceId = named.defaultPriceId;
    }
    const price = mustGet<Price>(store, "prices", priceId!, "price");
    if (price.currency !== "USD") throw new ActionError("CONFLICT", `Price ${price.label} is ${price.currency}; quotes are USD only`, { currency: price.currency });
    if (price.status !== "active") throw new ActionError("CONFLICT", `Price ${price.label} is archived; choose an active price`);
    const product = mustGet<Product>(store, "products", price.productId, "product");
    if (productId && productId !== product.id) throw new ActionError("CONFLICT", `Price ${price.label} belongs to ${product.name}, not product ${draft.productId}`);
    if (product.status !== "active") throw new ActionError("CONFLICT", `${product.name} is archived; choose an active product`);
    productId = product.id;
    unitPrice = price.amount;
    description = draft.description ?? `${product.name} — ${price.label}`;
  } else {
    if (!draft.description || draft.unitPrice === undefined) throw new ActionError("INVALID", "Give a priceId, or a description and unitPrice for a custom line");
    unitPrice = draft.unitPrice;
    description = draft.description;
  }
  const unit = cents(unitPrice);
  return { id: store.nextId("_nested", "ql"), description, productId, priceId, quantity, unitPrice: unit, amount: cents(quantity * unit) };
}

const createQuote = defineAction({
  id: "M27.A01",
  description: "Start a draft quote for a contact, optionally tied to an opportunity. Lines can be added now or with M27.A04. To bill them without a quote, use M28.A01 Create invoice.",
  risk: "write",
  input: z.strictObject({
    contactId: z.string().describe("contact id (ct_…)"),
    opportunityId: z.string().nullable().optional(),
    expiresAt: When.nullable().optional(),
    lines: z.array(LineDraft).optional(),
  }),
  output: Quote,
  siblings: ["M28.A01"],
  entities: { produces: "quote", consumes: ["contact"] },
  example: (f) => ({ contactId: f.contact().id }),
  handler: (a, { store, clock, actorId }) => {
    const contact = activeContact(store, a.contactId, "be quoted");
    const opportunityId = opportunityFor(store, contact.id, a.opportunityId);
    if (a.expiresAt && Date.parse(a.expiresAt) < clock.now().getTime()) throw new ActionError("INVALID", `expiresAt ${a.expiresAt} is in the past`);
    const lines = (a.lines ?? []).map((line) => buildLine(store, line));
    const now = clock.now().toISOString();
    return store.insert("quotes", "qt", {
      number: nextQuoteNumber(store),
      contactId: contact.id,
      opportunityId,
      status: "draft" as const,
      lines,
      discount: null,
      ...totals(lines, null),
      currency: "USD" as const,
      expiresAt: a.expiresAt ?? null,
      sentAt: null,
      decidedAt: null,
      invoiceId: null,
      createdBy: actorId ?? "us_1",
      createdAt: now,
      updatedAt: now,
    });
  },
});

const Detail = Quote.extend({ contactName: z.string() });

function contactName(store: Store, contactId: string): string {
  return store.get<Contact>("contacts", contactId)?.name ?? contactId;
}

const getQuote = defineAction({
  id: "M27.A02",
  description: "Get one quote: its lines, discount, subtotal, total, expiry, status and the invoice it became, if any. To find several, use M27.A03 Search quotes.",
  risk: "read",
  input: z.strictObject({ quoteId: QuoteId }),
  output: Detail,
  entities: { consumes: ["quote"] },
  example: (f) => ({ quoteId: f.quote().id }),
  handler: ({ quoteId }, { store }) => {
    const q = mustGet<Quote>(store, "quotes", quoteId, "quote");
    return { ...q, contactName: contactName(store, q.contactId) };
  },
});

const searchQuotes = defineAction({
  id: "M27.A03",
  description: "Find quotes by contact, status, opportunity, number or created date. Sorted by createdAt descending, then id. Dates are inclusive. To open one, use M27.A02.",
  risk: "read",
  input: z.strictObject({
    contactId: z.string().optional(),
    status: z.enum(["draft", "sent", "accepted", "declined", "expired", "converted"]).optional(),
    opportunityId: z.string().optional(),
    query: z.string().optional().describe("quote number or contact name"),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: Limit,
  }),
  output: listOf(Detail),
  entities: { produces: "quote" },
  example: () => ({}),
  handler: (a, { store }) => {
    const items = store
      .find<Quote>(
        "quotes",
        (q) =>
          (!a.contactId || q.contactId === a.contactId) &&
          (!a.status || q.status === a.status) &&
          (!a.opportunityId || q.opportunityId === a.opportunityId) &&
          inDateRange(q.createdAt, a.from, a.to),
      )
      .map((q) => ({ ...q, contactName: contactName(store, q.contactId) }))
      .filter((q) => !a.query || contains(q.number, a.query) || contains(q.contactName, a.query));
    items.sort((x, y) => y.createdAt.localeCompare(x.createdAt) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

function draftQuote(store: Store, id: string, doing: string): Quote {
  const q = mustGet<Quote>(store, "quotes", id, "quote");
  requireState(`Quote ${q.number}`, q.status, ["draft"], doing);
  return q;
}

const addLine = defineAction({
  id: "M27.A04",
  description: "Add a line to a draft quote from a USD price, the product's default price, or a custom description and unit price. A non-USD price is refused. Totals are recalculated.",
  risk: "write",
  input: z.strictObject({ quoteId: QuoteId, ...LineDraft.shape }),
  output: Quote,
  entities: { consumes: ["quote"] },
  example: (f) => ({ quoteId: f.quote().id, priceId: f.price({ amount: 40 }).id, quantity: 1 }),
  handler: (a, { store, clock }) => {
    const q = draftQuote(store, a.quoteId, "have lines added");
    const { quoteId: _quoteId, ...draft } = a;
    const lines = [...q.lines, buildLine(store, draft)];
    return store.update<Quote>("quotes", q.id, { lines, ...totals(lines, q.discount), updatedAt: clock.now().toISOString() });
  },
});

const updateLine = defineAction({
  id: "M27.A05",
  description: "Change a draft quote line's description, quantity or unit price. The line amount and the quote total are recalculated. To add a line, use M27.A04.",
  risk: "write",
  input: z.strictObject({
    quoteId: QuoteId,
    lineId: z.string().describe("line id"),
    description: z.string().min(1).optional(),
    quantity: z.number().positive().optional(),
    unitPrice: z.number().min(0).optional().describe("USD"),
  }),
  output: Quote,
  entities: { consumes: ["quote"] },
  example: (f) => {
    const q = f.quote({
      lines: [{ id: "ql_1", description: "Work", productId: null, priceId: null, quantity: 1, unitPrice: 10, amount: 10 }],
      subtotal: 10,
      total: 10,
    });
    return { quoteId: q.id, lineId: "ql_1", quantity: 2 };
  },
  handler: (a, { store, clock }) => {
    const q = draftQuote(store, a.quoteId, "have lines edited");
    atLeastOne(a, ["description", "quantity", "unitPrice"]);
    const current = q.lines.find((line) => line.id === a.lineId);
    if (!current) throw new ActionError("NOT_FOUND", `No line with id ${a.lineId} on quote ${q.number}`, { id: a.lineId });
    const description = a.description ?? current.description;
    const quantity = a.quantity ?? current.quantity;
    const unitPrice = cents(a.unitPrice ?? current.unitPrice);
    const amount = cents(quantity * unitPrice);
    if (description === current.description && quantity === current.quantity && unitPrice === current.unitPrice && amount === current.amount) {
      throw new ActionError("CONFLICT", "The line already has those values");
    }
    const lines = q.lines.map((line) => (line.id === current.id ? { ...line, description, quantity, unitPrice, amount } : line));
    return store.update<Quote>("quotes", q.id, { lines, ...totals(lines, q.discount), updatedAt: clock.now().toISOString() });
  },
});

const setExpiry = defineAction({
  id: "M27.A06",
  description: "Set or clear the moment a draft or sent quote stops being acceptable. Null clears it. Acceptance after that moment is refused. This does not send the quote.",
  risk: "write",
  input: z.strictObject({ quoteId: QuoteId, expiresAt: When.nullable() }),
  output: Quote,
  entities: { consumes: ["quote"] },
  example: (f) => ({ quoteId: f.quote().id, expiresAt: f.at(14) }),
  handler: ({ quoteId, expiresAt }, { store, clock }) => {
    const q = mustGet<Quote>(store, "quotes", quoteId, "quote");
    requireState(`Quote ${q.number}`, q.status, ["draft", "sent"], "have its expiry changed");
    if (expiresAt && Date.parse(expiresAt) < clock.now().getTime()) throw new ActionError("INVALID", `expiresAt ${expiresAt} is in the past`);
    if (q.expiresAt === expiresAt) throw new ActionError("CONFLICT", expiresAt ? `The quote already expires at ${expiresAt}` : "The quote already has no expiry");
    return store.update<Quote>("quotes", q.id, { expiresAt, updatedAt: clock.now().toISOString() });
  },
});

const applyDiscount = defineAction({
  id: "M27.A07",
  description: "Set or clear a draft quote's discount (percent of the subtotal, or a USD amount capped at the subtotal). The total is recalculated. This is not a coupon; coupons are M31.",
  risk: "write",
  input: z.strictObject({ quoteId: QuoteId, discount: Discount.nullable().describe("null clears the discount") }),
  output: Quote,
  entities: { consumes: ["quote"] },
  example: (f) => ({ quoteId: f.quote().id, discount: { type: "percent", value: 10 } }),
  handler: ({ quoteId, discount }, { store, clock }) => {
    const q = draftQuote(store, quoteId, "have a discount applied");
    if (discount) checkDiscount(discount);
    if (sameDiscount(q.discount, discount)) {
      throw new ActionError("CONFLICT", discount ? "The quote already has that discount" : "The quote already has no discount");
    }
    return store.update<Quote>("quotes", q.id, { discount, ...totals(q.lines, discount), updatedAt: clock.now().toISOString() });
  },
});

const sendQuote = defineAction({
  id: "M27.A08",
  description: "Send a draft quote to the contact for acceptance and mark it sent. Requires billing.manage and messaging.send. No emails row is stored, because there is no quote email kind; the contact must have an email address. Unlike M28.A07 Issue invoice, this asks the contact to accept an offer and bills nothing.",
  risk: "external",
  input: z.strictObject({ quoteId: QuoteId }),
  output: Quote,
  siblings: ["M28.A07"],
  entities: { consumes: ["quote"] },
  destination: { id: "email", label: "Email" },
  example: (f) => ({ quoteId: f.quote().id }),
  handler: ({ quoteId }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "billing.manage");
    requirePermission(store, actorId, "messaging.send");
    const q = mustGet<Quote>(store, "quotes", quoteId, "quote");
    requireState(`Quote ${q.number}`, q.status, ["draft"], "be sent");
    if (q.expiresAt && Date.parse(q.expiresAt) < clock.now().getTime()) {
      throw new ActionError("CONFLICT", `Quote ${q.number} already expired at ${q.expiresAt}; set a new expiry first`);
    }
    const c = activeContact(store, q.contactId, "be sent a quote");
    requireReachable(store, { type: "contact", id: c.id, name: c.name, email: c.email, phone: c.phone }, "email", true);
    const now = clock.now().toISOString();
    return store.update<Quote>("quotes", q.id, { status: "sent", sentAt: now, updatedAt: now });
  },
});

const acceptQuote = defineAction({
  id: "M27.A09",
  description: "Record that the contact accepted a sent quote. A quote that is past its expiry can't be accepted. To turn it into an invoice after this, use M27.A10.",
  risk: "write",
  input: z.strictObject({ quoteId: QuoteId }),
  output: Quote,
  entities: { consumes: ["quote"] },
  example: (f) => ({ quoteId: f.quote({ status: "sent", sentAt: f.now() }).id }),
  handler: ({ quoteId }, { store, clock }) => {
    const q = mustGet<Quote>(store, "quotes", quoteId, "quote");
    requireState(`Quote ${q.number}`, q.status, ["sent"], "record acceptance");
    if (q.expiresAt && Date.parse(q.expiresAt) < clock.now().getTime()) {
      throw new ActionError("CONFLICT", `Quote ${q.number} expired at ${q.expiresAt}; send a new quote instead`);
    }
    const now = clock.now().toISOString();
    return store.update<Quote>("quotes", q.id, { status: "accepted", decidedAt: now, updatedAt: now });
  },
});

const Converted = z.object({ quote: Quote, invoice: Invoice });

const convertQuote = defineAction({
  id: "M27.A10",
  description: "Turn an accepted quote into an open invoice and mark the quote converted. Lines carry over. The invoice total is the quote total after discount, not the raw subtotal. Unlike M28.A01, this only starts from an accepted quote. Requires billing.manage.",
  risk: "external",
  input: z.strictObject({ quoteId: QuoteId }),
  output: Converted,
  siblings: ["M28.A01"],
  entities: { produces: "invoice", consumes: ["quote"] },
  example: (f) => ({
    quoteId: f.quote({
      status: "accepted",
      decidedAt: f.now(),
      lines: [{ id: "ql_1", description: "Work", productId: null, priceId: null, quantity: 1, unitPrice: 80, amount: 80 }],
      subtotal: 80,
      total: 80,
    }).id,
  }),
  handler: ({ quoteId }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "billing.manage");
    const q = mustGet<Quote>(store, "quotes", quoteId, "quote");
    if (q.status === "converted") throw new ActionError("CONFLICT", `Quote ${q.number} was already converted to ${q.invoiceId}`);
    if (q.status !== "accepted") throw new ActionError("CONFLICT", "Accept the quote first");
    const lineItems: LineItem[] = q.lines.map((line) => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, amount: line.amount }));
    const now = clock.now().toISOString();
    const invoice = store.insert("invoices", "inv", {
      number: nextInvoiceNumber(store),
      contactId: q.contactId,
      status: "open" as const,
      lineItems,
      total: q.total,
      amountPaid: 0,
      amountDue: q.total,
      currency: "USD" as const,
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
    const quote = store.update<Quote>("quotes", q.id, { status: "converted", invoiceId: invoice.id, updatedAt: now });
    return { quote, invoice };
  },
});

export default {
  actions: [createQuote, getQuote, searchQuotes, addLine, updateLine, setExpiry, applyDiscount, sendQuote, acceptQuote, convertQuote],
  resolvers: { quote: ownedResolver<Quote>({ table: "quotes", noun: "quote", label: (_, q) => q.number, detail: (q) => `${q.status}, $${q.total}` }) },
} satisfies ModuleExports;
