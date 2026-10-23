import { Fixtures, type Input } from "../../store/fixtures.js";
import { Price } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    price(o?: Input<Price>): Price;
  }
}

Fixtures.prototype.price = function (this: Fixtures, o: Input<Price> = {}): Price {
  const n = this.seq();
  const productId = o.productId ?? this.product().id;
  const row = this.make("prices", "prc", Price, {
    label: `Price ${n}`,
    amount: 10,
    currency: "USD",
    interval: "one_time",
    intervalCount: 1,
    trialDays: 0,
    isDefault: true,
    status: "active",
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
    productId,
  });
  if (row.isDefault) {
    for (const other of this.store.find<Price>("prices", (p) => p.productId === row.productId && p.id !== row.id && p.isDefault)) {
      this.store.update("prices", other.id, { isDefault: false, updatedAt: this.now() });
    }
    this.store.update("products", row.productId, { defaultPriceId: row.id, updatedAt: this.now() });
  }
  return row;
};
