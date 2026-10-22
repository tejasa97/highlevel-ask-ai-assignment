import { Fixtures, type Input } from "../../store/fixtures.js";
import { Website } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    website(o?: Input<Website>): Website;
  }
}

Fixtures.prototype.website = function (this: Fixtures, o: Input<Website> = {}): Website {
  const n = this.seq();
  return this.make("websites", "ws", Website, {
    name: `Website ${n}`,
    domain: null,
    pages: [],
    homePageId: null,
    navigation: [],
    seoDefaults: { title: null, description: null },
    status: "draft",
    createdAt: this.now(),
    updatedAt: this.now(),
    publishedAt: null,
    ...o,
  });
};
