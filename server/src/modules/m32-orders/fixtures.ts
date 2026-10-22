import { Fixtures, type Input } from "../../store/fixtures.js";
import { Order } from "./schema.js";

// Product, price, coupon and tax rows belong to other modules. Build them with f.make.

declare module "../../store/fixtures.js" {
  interface Fixtures {
    order(o?: Input<Order>): Order;
  }
}

Fixtures.prototype.order = function (this: Fixtures, o: Input<Order> = {}): Order {
  const n = this.store.all("orders").length;
  return this.make("orders", "ord", Order, {
    number: `ORD-${1001 + n}`,
    contactId: o.contactId ?? this.contact().id,
    status: "draft",
    lines: [],
    shippingAddress: null,
    couponId: null,
    subtotal: 0,
    discountTotal: 0,
    taxTotal: 0,
    total: 0,
    currency: "USD",
    invoiceId: null,
    submittedAt: null,
    fulfilledAt: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};
