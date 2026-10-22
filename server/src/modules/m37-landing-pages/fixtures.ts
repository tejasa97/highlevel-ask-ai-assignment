import { Fixtures, type Input } from "../../store/fixtures.js";
import { LandingPage } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    landingPage(o?: Input<LandingPage>): LandingPage;
  }
}

Fixtures.prototype.landingPage = function (this: Fixtures, o: Input<LandingPage> = {}): LandingPage {
  const n = this.seq();
  return this.make("landing_pages", "lp", LandingPage, {
    title: `Page ${n}`,
    slug: `page-${n}`,
    sections: [],
    formId: null,
    mediaIds: [],
    seo: { title: null, description: null },
    status: "draft",
    createdAt: this.now(),
    updatedAt: this.now(),
    publishedAt: null,
    ...o,
  });
};
