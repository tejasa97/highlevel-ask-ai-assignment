import { cents } from "../../registry/helpers.js";
import { Fixtures, type Input } from "../../store/fixtures.js";
import type { Discount } from "../m31-coupons/schema.js";
import { Quote } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    quote(o?: Input<Quote>): Quote;
  }
}

function off(subtotal: number, discount: Discount | null): number {
  if (!discount || subtotal <= 0) return 0;
  const raw = discount.type === "percent" ? cents(subtotal * discount.value / 100) : cents(Math.min(discount.value, subtotal));
  return Math.min(subtotal, raw);
}

Fixtures.prototype.quote = function (this: Fixtures, o: Input<Quote> = {}): Quote {
  const n = this.seq();
  const lines = o.lines ?? [];
  const discount = o.discount ?? null;
  const subtotal = o.subtotal ?? cents(lines.reduce((sum, line) => sum + line.amount, 0));
  const total = o.total ?? cents(subtotal - off(subtotal, discount));
  return this.make("quotes", "qt", Quote, {
    number: `QT-${9000 + n}`,
    contactId: o.contactId ?? this.contact().id,
    opportunityId: null,
    status: "draft",
    lines,
    discount,
    subtotal,
    total,
    currency: "USD",
    expiresAt: null,
    sentAt: null,
    decidedAt: null,
    invoiceId: null,
    createdBy: "us_1",
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};
