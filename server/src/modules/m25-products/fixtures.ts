import { Fixtures, type Input } from "../../store/fixtures.js";
import { Product } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    product(o?: Input<Product>): Product;
  }
}

Fixtures.prototype.product = function (this: Fixtures, o: Input<Product> = {}): Product {
  const n = this.seq();
  return this.make("products", "prd", Product, {
    name: `Product ${n}`,
    description: null,
    sku: null,
    inventory: null,
    variants: [],
    taxCategory: null,
    defaultPriceId: null,
    status: "active",
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};
