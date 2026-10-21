import { ActionError } from "../../registry/define.js";
import { cents } from "../../registry/helpers.js";
import type { Store } from "../../store/db.js";
import type { Invoice, LineItem } from "./schema.js";

// Invoice arithmetic shared by invoices, payments and invoice reminder emails.

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** Days past the due date for an open invoice; 0 when it isn't overdue. */
export function daysOverdue(inv: Invoice, today: string): number {
  return inv.status === "open" && inv.dueDate && inv.dueDate < today ? daysBetween(inv.dueDate, today) : 0;
}

export function totals(items: LineItem[]): { total: number } {
  return { total: cents(items.reduce((n, i) => n + i.amount, 0)) };
}

export function line(i: { description: string; quantity?: number; unitPrice: number }): LineItem {
  const quantity = i.quantity ?? 1;
  return { description: i.description, quantity, unitPrice: i.unitPrice, amount: cents(quantity * i.unitPrice) };
}

/** Why a reminder for this invoice can't go out now, or null. One per invoice per 24 hours. */
export function reminderBlocker(inv: Invoice, now: Date): string | null {
  if (inv.status !== "open") return `Invoice ${inv.number} is ${inv.status}; only open (issued, unpaid) invoices get reminders`;
  if (inv.lastReminderAt && now.getTime() - Date.parse(inv.lastReminderAt) < 86_400_000) {
    return `Invoice ${inv.number} already got a reminder at ${inv.lastReminderAt}; wait 24 hours between reminders`;
  }
  return null;
}

/** Adds (or with a negative amount, takes back) a payment on an invoice, marking it paid or open again. */
export function applyPayment(store: Store, inv: Invoice, amount: number, at: string): Invoice {
  const amountPaid = cents(inv.amountPaid + amount);
  const amountDue = cents(inv.total - amountPaid);
  if (amountDue < 0) throw new ActionError("CONFLICT", `That's more than invoice ${inv.number} has left to pay (${inv.amountDue})`, { amountDue: inv.amountDue });
  const paid = amountDue === 0;
  return store.update<Invoice>("invoices", inv.id, { amountPaid, amountDue, status: paid ? "paid" : "open", paidAt: paid ? at : null });
}

export function nextInvoiceNumber(store: Store): string {
  return `INV-${1001 + store.all("invoices").length}`;
}
