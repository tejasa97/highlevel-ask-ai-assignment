import { Fixtures, type Input } from "../../store/fixtures.js";
import { TaxExemption, TaxRule } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    taxRule(o?: Input<TaxRule>): TaxRule;
    taxExemption(o?: Input<TaxExemption>): TaxExemption;
  }
}

Fixtures.prototype.taxRule = function (this: Fixtures, o: Input<TaxRule> = {}): TaxRule {
  const n = this.seq();
  return this.make("tax_rules", "tx", TaxRule, {
    name: `Tax ${n}`,
    rate: 8.25,
    region: "US",
    productCategory: null,
    inclusive: false,
    status: "active",
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};

Fixtures.prototype.taxExemption = function (this: Fixtures, o: Input<TaxExemption> = {}): TaxExemption {
  const n = this.seq();
  return this.make("tax_exemptions", "txe", TaxExemption, {
    contactId: o.contactId ?? this.contact().id,
    certificateNumber: `EX-${n}`,
    reason: null,
    regions: [],
    expiresAt: null,
    recordedBy: "us_1",
    createdAt: this.now(),
    ...o,
  });
};
