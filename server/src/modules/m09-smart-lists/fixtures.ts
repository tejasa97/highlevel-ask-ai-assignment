import { Fixtures, type Input } from "../../store/fixtures.js";
import { SmartList } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    smartList(o?: Input<SmartList>): SmartList;
  }
}

Fixtures.prototype.smartList = function (this: Fixtures, o: Input<SmartList> = {}): SmartList {
  const n = this.seq();
  return this.make("smart_lists", "sl", SmartList, {
    name: `List ${n}`,
    target: "contact",
    rules: [],
    createdBy: "us_1",
    status: "active",
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};
