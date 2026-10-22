import { Fixtures, type Input } from "../../store/fixtures.js";
import { Coupon } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    coupon(o?: Input<Coupon>): Coupon;
  }
}

Fixtures.prototype.coupon = function (this: Fixtures, o: Input<Coupon> = {}): Coupon {
  const n = this.seq();
  return this.make("coupons", "cou", Coupon, {
    code: `OFF${n}`,
    description: null,
    discount: { type: "percent", value: 10 },
    validFrom: null,
    validUntil: null,
    maxRedemptions: null,
    redemptions: 0,
    productIds: [],
    status: "active",
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};
