import { Fixtures, type Input } from "../../store/fixtures.js";
import { Funnel } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    funnel(o?: Input<Funnel>): Funnel;
  }
}

Fixtures.prototype.funnel = function (this: Fixtures, o: Input<Funnel> = {}): Funnel {
  const n = this.seq();
  return this.make("funnels", "fn", Funnel, {
    name: `Funnel ${n}`,
    steps: [],
    goal: null,
    status: "draft",
    createdAt: this.now(),
    updatedAt: this.now(),
    publishedAt: null,
    ...o,
  });
};
