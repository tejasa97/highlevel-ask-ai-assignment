import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { atLeastOne, contains, inDateRange, Limit, listOf, norm, notPast, page, requirePermission, requireState, singular } from "../../registry/helpers.js";
import { ownedResolver } from "../../registry/lookup.js";
import type { ModuleExports } from "../../registry/registry.js";
import { addDays, localDate } from "../../store/clock.js";
import type { Store } from "../../store/db.js";
import type { Contact } from "../m01-contacts/schema.js";
import { deliverEmail, OUR_EMAIL, requireReachable } from "../m11-conversations/messaging.js";
import type { Email } from "../m13-email/schema.js";
import type { Price } from "../m26-prices/schema.js";
import type { Product } from "../m25-products/schema.js";
import type { Payment } from "../m29-payments/schema.js";
import { daysOverdue, line, nextInvoiceNumber, reminderBlocker, totals } from "./billing.js";
import { Invoice, INVOICE_STATUSES, LineItem } from "./schema.js";

export { Invoice } from "./schema.js";

// Invoices: drafted, issued (emailed, status open), paid by payments (M29), or voided.
// "Overdue" means open with a due date before today; reminders are emails of kind invoice_reminder.

const InvoiceId = z.string().describe("invoice id (inv_…)");
const LineInput = z.strictObject({
  productId: z.string().optional().describe("a catalog product (prd_…): fills the description and unit price from it"),
  description: z.string().min(1).optional().describe("required without productId"),
  quantity: z.number().positive().optional().describe("default 1"),
  unitPrice: z.number().min(0).optional().describe("USD; required without productId, default the product's price"),
});
type LineInput = z.infer<typeof LineInput>;

/** A line as given, or filled from its product: the product's name and its default (or only active) USD price.
 *  An unpriced line whose description is exactly one product's name ("Setup Packages") is that product's line. */
function lineOf(store: Store, i: LineInput): LineItem {
  if (!i.productId && i.description !== undefined && i.unitPrice === undefined) {
    const named = store.find<Product>("products", (p) => singular(norm(p.name)) === singular(norm(i.description!)));
    if (named.length === 1) return lineOf(store, { ...i, productId: named[0]!.id, description: undefined });
  }
  if (!i.productId) {
    if (i.description === undefined || i.unitPrice === undefined) throw new ActionError("INVALID", "A line item needs a description and unitPrice, or a productId");
    return line({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice });
  }
  const product = mustGet<Product>(store, "products", i.productId, "product");
  if (product.status !== "active") throw new ActionError("CONFLICT", `Product ${product.name} is archived; choose an active product`);
  let unitPrice = i.unitPrice;
  if (unitPrice === undefined) {
    const prices = store.find<Price>("prices", (p) => p.productId === product.id && p.status === "active" && p.currency === "USD");
    const price = prices.find((p) => p.id === product.defaultPriceId) ?? (prices.length === 1 ? prices[0] : undefined);
    if (!price) {
      throw new ActionError("CONFLICT", prices.length ? `${product.name} has several prices (${prices.map((p) => `${p.label} $${p.amount}`).join(", ")}) and no default; give unitPrice` : `${product.name} has no active USD price; give unitPrice`);
    }
    unitPrice = price.amount;
  }
  return line({ description: i.description ?? product.name, quantity: i.quantity, unitPrice });
}

function activeContact(store: Store, id: string): Contact {
  const c = mustGet<Contact>(store, "contacts", id, "contact");
  requireState(c.name, c.status, ["active"], "be invoiced");
  return c;
}

function contactName(store: Store, inv: Invoice): string {
  return store.get<Contact>("contacts", inv.contactId)?.name ?? inv.contactId;
}

function draft(store: Store, id: string): Invoice {
  const inv = mustGet<Invoice>(store, "invoices", id, "invoice");
  requireState(`Invoice ${inv.number}`, inv.status, ["draft"], "be edited (only drafts can change)");
  return inv;
}

function withItems(items: LineItem[]) {
  const { total } = totals(items);
  return { lineItems: items, total, amountDue: total };
}

/** Creates and delivers an email about an invoice to its contact. Invoice emails ignore marketing preferences. */
function invoiceEmail(store: Store, inv: Invoice, kind: "invoice" | "invoice_reminder", subject: string, body: string, actorId: string | undefined, at: string): Email {
  const c = store.get<Contact>("contacts", inv.contactId)!;
  requireReachable(store, { type: "contact", id: c.id, name: c.name, email: c.email, phone: c.phone }, "email", true);
  const e = store.insert("emails", "em", {
    conversationId: null,
    contactId: c.id,
    leadId: null,
    to: c.email!,
    from: OUR_EMAIL,
    subject,
    body,
    kind,
    invoiceId: inv.id,
    campaignId: null,
    direction: "outbound" as const,
    status: "draft" as Email["status"],
    scheduledAt: null,
    sentAt: null,
    deliveredAt: null,
    failureReason: null,
    createdBy: actorId ?? "us_1",
    createdAt: at,
  });
  return deliverEmail(store, e, at);
}

const createInvoice = defineAction({
  id: "M28.A01",
  description: "Start a draft invoice for a contact, optionally with line items (a catalog product's line can give just productId and quantity: it is priced from the catalog), a due date and a memo. Nothing is sent until it's issued (M28.A07).",
  risk: "write",
  input: z.strictObject({
    contactId: z.string(),
    lineItems: z.array(LineInput).optional(),
    dueDate: z.iso.date().optional().describe("YYYY-MM-DD; default 30 days after issuing"),
    memo: z.string().optional(),
  }),
  output: Invoice,
  siblings: ["M29.A01"],
  entities: { produces: "invoice", consumes: ["contact"], optionalConsumes: ["product"] },
  example: () => ({ contactId: "ct_31", lineItems: [{ description: "Website audit", unitPrice: 750 }] }),
  handler: (a, { store, clock }) => {
    const c = activeContact(store, a.contactId);
    if (a.dueDate) notPast(a.dueDate, localDate(clock.now()), "dueDate");
    return store.insert("invoices", "inv", {
      number: nextInvoiceNumber(store),
      contactId: c.id,
      status: "draft" as Invoice["status"],
      ...withItems((a.lineItems ?? []).map((i) => lineOf(store, i))),
      amountPaid: 0,
      currency: "USD" as const,
      issueDate: null,
      dueDate: a.dueDate ?? null,
      paidAt: null,
      voidedAt: null,
      voidReason: null,
      reminders: [],
      lastReminderAt: null,
      memo: a.memo ?? null,
      createdAt: clock.now().toISOString(),
    });
  },
});

const Detail = Invoice.extend({
  contactName: z.string(),
  daysOverdue: z.number(),
  payments: z.array(z.object({ paymentId: z.string(), amount: z.number(), at: z.string() })),
});

const getInvoice = defineAction({
  id: "M28.A02",
  description: "Get one invoice: contact, line items, total, amount paid and due, due date, days overdue, reminders sent and the payments applied to it.",
  risk: "read",
  input: z.strictObject({ invoiceId: InvoiceId }),
  output: Detail,
  entities: { consumes: ["invoice"] },
  example: () => ({ invoiceId: "inv_1" }),
  handler: ({ invoiceId }, { store, clock }) => {
    const inv = mustGet<Invoice>(store, "invoices", invoiceId, "invoice");
    const payments = store
      .find<Payment>("payments", (p) => p.allocations.some((x) => x.invoiceId === inv.id))
      .flatMap((p) => p.allocations.filter((x) => x.invoiceId === inv.id).map((x) => ({ paymentId: p.id, amount: x.amount, at: x.at })));
    return { ...inv, contactName: contactName(store, inv), daysOverdue: daysOverdue(inv, localDate(clock.now())), payments };
  },
});

const Row = Invoice.extend({ contactName: z.string(), daysOverdue: z.number() });

const searchInvoices = defineAction({
  id: "M28.A03",
  description:
    "Find invoices by contact, status (draft, open, paid, void), overdue, issue or due date range, minimum amount due, or invoice number / contact name. For a ranked list of overdue invoices, M28.A10 is simpler.",
  risk: "read",
  input: z.strictObject({
    contactId: z.string().optional(),
    status: z.enum(INVOICE_STATUSES).optional(),
    overdue: z.boolean().optional().describe("true: open and past due; false: everything else"),
    issuedFrom: z.iso.date().optional(),
    issuedTo: z.iso.date().optional(),
    dueFrom: z.iso.date().optional(),
    dueTo: z.iso.date().optional(),
    minAmountDue: z.number().optional(),
    query: z.string().optional().describe("invoice number or contact name"),
    limit: Limit,
  }),
  output: listOf(Row),
  siblings: ["M28.A10"],
  entities: { produces: "invoice" },
  example: () => ({ status: "open" }),
  handler: (a, { store, clock }) => {
    const today = localDate(clock.now());
    const items = store
      .find<Invoice>(
        "invoices",
        (i) =>
          (!a.contactId || i.contactId === a.contactId) &&
          (!a.status || i.status === a.status) &&
          (a.overdue === undefined || daysOverdue(i, today) > 0 === a.overdue) &&
          (!(a.issuedFrom || a.issuedTo) || (!!i.issueDate && inDateRange(i.issueDate, a.issuedFrom, a.issuedTo))) &&
          (!(a.dueFrom || a.dueTo) || (!!i.dueDate && inDateRange(i.dueDate, a.dueFrom, a.dueTo))) &&
          (a.minAmountDue === undefined || i.amountDue >= a.minAmountDue),
      )
      .map((i) => ({ ...i, contactName: contactName(store, i), daysOverdue: daysOverdue(i, today) }))
      .filter((i) => !a.query || contains(i.number, a.query) || contains(i.contactName, a.query));
    items.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return page(items, a.limit);
  },
});

const addLineItem = defineAction({
  id: "M28.A04",
  description: "Add a line item (description, quantity, unit price, or a catalog product priced from the catalog) to a draft invoice; the total is recalculated.",
  risk: "write",
  input: z.strictObject({ invoiceId: InvoiceId, ...LineInput.shape }),
  output: Invoice,
  entities: { consumes: ["invoice"], optionalConsumes: ["product"] },
  example: (f) => ({ invoiceId: f.invoice().id, description: "Extra revisions", quantity: 2, unitPrice: 120 }),
  handler: ({ invoiceId, ...item }, { store }) => {
    const inv = draft(store, invoiceId);
    return store.update<Invoice>("invoices", inv.id, withItems([...inv.lineItems, lineOf(store, item)]));
  },
});

const updateDraft = defineAction({
  id: "M28.A05",
  description: "Change a draft invoice: its memo, which contact it's for, or replace all its line items.",
  risk: "write",
  input: z.strictObject({ invoiceId: InvoiceId, memo: z.string().nullable().optional(), contactId: z.string().optional(), lineItems: z.array(LineInput).optional() }),
  output: Invoice,
  entities: { consumes: ["invoice", "contact"] },
  example: (f) => ({ invoiceId: f.invoice().id, memo: "Thanks for your business!" }),
  handler: ({ invoiceId, ...a }, { store }) => {
    atLeastOne(a, ["memo", "contactId", "lineItems"]);
    const inv = draft(store, invoiceId);
    if (a.contactId) activeContact(store, a.contactId);
    return store.update<Invoice>("invoices", inv.id, {
      ...(a.memo !== undefined ? { memo: a.memo } : {}),
      ...(a.contactId ? { contactId: a.contactId } : {}),
      ...(a.lineItems ? withItems(a.lineItems.map((i) => lineOf(store, i))) : {}),
    });
  },
});

const setDueDate = defineAction({
  id: "M28.A06",
  description: "Set or move the due date of a draft or open invoice, e.g. to give a customer more time.",
  risk: "write",
  input: z.strictObject({ invoiceId: InvoiceId, dueDate: z.iso.date().describe("YYYY-MM-DD") }),
  output: Invoice,
  entities: { consumes: ["invoice"] },
  example: (f) => ({ invoiceId: f.invoice({ status: "open", issueDate: f.day(-10), dueDate: f.day(-2) }).id, dueDate: f.day(14) }),
  handler: ({ invoiceId, dueDate }, { store, clock }) => {
    const inv = mustGet<Invoice>(store, "invoices", invoiceId, "invoice");
    requireState(`Invoice ${inv.number}`, inv.status, ["draft", "open"], "change its due date");
    notPast(dueDate, localDate(clock.now()), "dueDate");
    if (inv.dueDate === dueDate) throw new ActionError("CONFLICT", `Invoice ${inv.number} is already due ${dueDate}`);
    return store.update<Invoice>("invoices", inv.id, { dueDate });
  },
});

const issueInvoice = defineAction({
  id: "M28.A07",
  description: "Issue a draft invoice: it becomes open and is emailed to the contact. The due date defaults to 30 days from today.",
  risk: "external",
  input: z.strictObject({ invoiceId: InvoiceId }),
  output: Invoice,
  siblings: ["M29.A01"],
  entities: { consumes: ["invoice"] },
  destination: { id: "email", label: "Email" },
  example: (f) => ({ invoiceId: f.invoice({ contactId: f.contact().id }).id }),
  handler: ({ invoiceId }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "billing.manage");
    const inv = draft(store, invoiceId);
    if (!inv.lineItems.length || inv.total <= 0) throw new ActionError("CONFLICT", `Invoice ${inv.number} has nothing to bill; add line items first (M28.A04)`);
    activeContact(store, inv.contactId);
    const today = localDate(clock.now());
    const dueDate = inv.dueDate ?? addDays(today, 30);
    const open = store.update<Invoice>("invoices", inv.id, { status: "open", issueDate: today, dueDate });
    invoiceEmail(store, open, "invoice", `Invoice ${inv.number} for $${inv.total.toFixed(2)}`, `Hi,\n\nPlease find invoice ${inv.number} for $${inv.total.toFixed(2)}, due ${dueDate}.\n\nThanks!`, actorId, clock.now().toISOString());
    return mustGet<Invoice>(store, "invoices", inv.id);
  },
});

const sendReminder = defineAction({
  id: "M28.A08",
  description:
    "Email the contact a payment reminder for an open invoice now. At most one reminder per invoice per 24 hours. To write one for review without sending, draft it with M13.A01 (invoiceId).",
  risk: "external",
  input: z.strictObject({ invoiceId: InvoiceId, message: z.string().optional().describe("custom body; a standard reminder otherwise") }),
  output: z.object({ invoice: Invoice, emailId: z.string(), status: z.string() }),
  siblings: ["M13.A01", "M13.A03"],
  entities: { consumes: ["invoice"], produces: "email" },
  destination: { id: "email", label: "Email" },
  example: (f) => ({ invoiceId: f.invoice({ contactId: f.contact().id, status: "open", issueDate: f.day(-40), dueDate: f.day(-10) }).id }),
  handler: ({ invoiceId, message }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "billing.manage");
    const inv = mustGet<Invoice>(store, "invoices", invoiceId, "invoice");
    const why = reminderBlocker(inv, clock.now());
    if (why) throw new ActionError("CONFLICT", why);
    const late = daysOverdue(inv, localDate(clock.now()));
    const subject = `Reminder: invoice ${inv.number} ${late ? `is ${late} days overdue` : `is due ${inv.dueDate}`}`;
    const body = message ?? `Hi,\n\nA friendly reminder that invoice ${inv.number} for $${inv.amountDue.toFixed(2)} was due on ${inv.dueDate}.\n\nThanks!`;
    const e = invoiceEmail(store, inv, "invoice_reminder", subject, body, actorId, clock.now().toISOString());
    return { invoice: mustGet<Invoice>(store, "invoices", inv.id), emailId: e.id, status: e.status };
  },
});

const voidInvoice = defineAction({
  id: "M28.A09",
  description: "Void a draft or open invoice that nothing has been paid on, with a reason. It can't be undone.",
  risk: "destructive",
  input: z.strictObject({ invoiceId: InvoiceId, reason: z.string().min(1) }),
  output: Invoice,
  entities: { consumes: ["invoice"] },
  example: (f) => ({ invoiceId: f.invoice().id, reason: "Created by mistake" }),
  handler: ({ invoiceId, reason }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "billing.manage");
    const inv = mustGet<Invoice>(store, "invoices", invoiceId, "invoice");
    requireState(`Invoice ${inv.number}`, inv.status, ["draft", "open"], "be voided");
    if (inv.amountPaid > 0) throw new ActionError("CONFLICT", `Invoice ${inv.number} has $${inv.amountPaid} paid on it; remove the payment allocation first (M29.A08)`);
    return store.update<Invoice>("invoices", inv.id, { status: "void", voidedAt: clock.now().toISOString(), voidReason: reason, amountDue: 0 });
  },
});

const listOverdue = defineAction({
  id: "M28.A10",
  description:
    "List unpaid (open) invoices past their due date, most overdue first. minDaysOverdue: 16 means 'overdue by more than 15 days'. To skip invoices reminded this week, set notRemindedSince to this week's Monday from <now>; older reminders and never-reminded invoices remain eligible. This only reads; M28.A08 sends reminders.",
  risk: "read",
  input: z.strictObject({ minDaysOverdue: z.number().int().min(1).optional().describe("default 1"), contactId: z.string().optional(), notRemindedSince: z.iso.date().optional().describe("exclude reminders on or after this date, midnight America/New_York; null/older reminders remain eligible"), limit: Limit }),
  output: listOf(
    z.object({
      invoiceId: z.string(),
      number: z.string(),
      contactId: z.string(),
      contactName: z.string(),
      total: z.number(),
      amountDue: z.number(),
      dueDate: z.string(),
      daysOverdue: z.number(),
      lastReminderAt: z.string().nullable(),
      reminderCount: z.number(),
    }),
  ),
  siblings: ["M28.A03"],
  entities: { produces: "invoice" },
  example: () => ({ minDaysOverdue: 16 }),
  handler: (a, { store, clock }) => {
    const today = localDate(clock.now());
    const min = a.minDaysOverdue ?? 1;
    const items = store
      .find<Invoice>("invoices", (i) => (!a.contactId || i.contactId === a.contactId) && daysOverdue(i, today) >= min &&
        (!a.notRemindedSince || !i.lastReminderAt || localDate(new Date(i.lastReminderAt)) < a.notRemindedSince))
      .map((i) => ({
        invoiceId: i.id,
        number: i.number,
        contactId: i.contactId,
        contactName: contactName(store, i),
        total: i.total,
        amountDue: i.amountDue,
        dueDate: i.dueDate!,
        daysOverdue: daysOverdue(i, today),
        lastReminderAt: i.lastReminderAt,
        reminderCount: i.reminders.length,
      }));
    items.sort((x, y) => y.daysOverdue - x.daysOverdue);
    return page(items, a.limit);
  },
});

export default {
  actions: [createInvoice, getInvoice, searchInvoices, addLineItem, updateDraft, setDueDate, issueInvoice, sendReminder, voidInvoice, listOverdue],
  resolvers: {
    // "Marco Patel's open invoice": by number, or by its contact and status.
    invoice: ownedResolver<Invoice>({ table: "invoices", noun: "invoice", state: (i) => i.status, label: (_, i) => i.number, detail: (i) => `${i.status}, $${i.amountDue} due`, qualifiers: { status: (_, i) => i.status } }),
  },
} satisfies ModuleExports;
