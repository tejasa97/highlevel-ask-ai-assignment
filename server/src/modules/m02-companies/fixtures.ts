import { Fixtures, type Input } from "../../store/fixtures.js";
import { Company } from "./schema.js";

// Module-local fixtures: a module adds its own builders to `Fixtures` here instead of editing store/fixtures.ts,
// so modules built side by side never touch the same file. The module's index.ts imports this file (for its
// `example(f)` functions), and tests and the seed get the builders through `w.f`.

declare module "../../store/fixtures.js" {
  interface Fixtures {
    company(o?: Input<Company>): Company;
  }
}

Fixtures.prototype.company = function (this: Fixtures, o: Input<Company> = {}): Company {
  const n = this.seq();
  return this.make("companies", "co", Company, {
    name: `Company ${n}`,
    domain: `company${n}.example`,
    industry: null,
    size: null,
    phone: null,
    address: null,
    accountManagerId: null,
    status: "active",
    mergedInto: null,
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};
