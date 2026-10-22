import { Fixtures, type Input } from "../../store/fixtures.js";
import { Subscription } from "./schema.js";

// Product and price rows are owned by M25/M26. Examples and tests build them with f.make.

declare module "../../store/fixtures.js" {
  interface Fixtures {
    subscription(o?: Input<Subscription>): Subscription;
  }
}

Fixtures.prototype.subscription = function (this: Fixtures, o: Input<Subscription> = {}): Subscription {
  const now = this.now();
  return this.make("subscriptions", "sub", Subscription, {
    contactId: o.contactId ?? this.contact().id,
    priceId: "prc_unset",
    productId: "prd_unset",
    quantity: 1,
    status: "active",
    trialEnd: null,
    currentPeriodStart: now,
    currentPeriodEnd: now,
    pausedAt: null,
    canceledAt: null,
    cancelReason: null,
    createdAt: now,
    updatedAt: now,
    ...o,
  });
};
