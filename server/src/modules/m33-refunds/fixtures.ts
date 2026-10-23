import { Fixtures, type Input } from "../../store/fixtures.js";
import { Refund } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    refund(o?: Input<Refund>): Refund;
  }
}

Fixtures.prototype.refund = function (this: Fixtures, o: Input<Refund> = {}): Refund {
  const created = o.paymentId ? undefined : this.payment(o.contactId ? { contactId: o.contactId } : {});
  return this.make("refunds", "rf", Refund, {
    paymentId: created?.id ?? "pay_unset",
    contactId: created?.contactId ?? "ct_1",
    amount: 10,
    reason: null,
    status: "requested",
    requestedBy: "us_1",
    decidedBy: null,
    decisionNote: null,
    failure: null,
    createdAt: this.now(),
    decidedAt: null,
    executedAt: null,
    ...o,
  });
};
