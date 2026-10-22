import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("create rejects a duplicate name or domain", async () => {
  const w = await testWorld();
  w.call("M35.A01", { name: "Acme", domain: "acme.example" });
  assert.equal(failure(() => w.call("M35.A01", { name: "acme" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M35.A01", { name: "Other", domain: "ACME.example" })).code, "DUPLICATE");
  assert.equal(w.call("M35.A01", { name: "Other" }).domain, null);
});

test("page slugs are unique on a site, and another site may reuse one", async () => {
  const w = await testWorld();
  const a = w.call("M35.A01", { name: "Alpha" });
  const b = w.call("M35.A01", { name: "Beta" });
  w.call("M35.A05", { websiteId: a.id, title: "About", slug: "About" });
  assert.equal(failure(() => w.call("M35.A05", { websiteId: a.id, title: "Again", slug: "about" })).code, "DUPLICATE");
  assert.equal(w.call("M35.A05", { websiteId: b.id, title: "About", slug: "about" }).pages[0].slug, "about");
  assert.equal(failure(() => w.call("M35.A05", { websiteId: a.id, title: "Offer", slug: "offer", landingPageId: "lp_99999" })).code, "NOT_FOUND");
});

test("rename is a no-op when the name matches, and a taken name is a duplicate", async () => {
  const w = await testWorld();
  const site = w.f.website({ name: "Acme" });
  w.f.website({ name: "Other" });
  assert.equal(failure(() => w.call("M35.A04", { websiteId: site.id, name: "Acme" })).code, "CONFLICT");
  assert.match(failure(() => w.call("M35.A04", { websiteId: site.id, name: "Acme" })).message, /already has that value/);
  assert.equal(failure(() => w.call("M35.A04", { websiteId: site.id, name: "other" })).code, "DUPLICATE");
  assert.equal(w.call("M35.A04", { websiteId: site.id, name: "Acme Co" }).name, "Acme Co");
});

test("home page must be a page on the site", async () => {
  const w = await testWorld();
  const site = w.f.website();
  assert.equal(failure(() => w.call("M35.A06", { websiteId: site.id, pageId: "pg_404" })).code, "CONFLICT");
  const added = w.call("M35.A05", { websiteId: site.id, title: "Home", slug: "home" });
  const pageId = added.pages[0].id;
  assert.equal(w.call("M35.A06", { websiteId: site.id, pageId }).homePageId, pageId);
  assert.equal(failure(() => w.call("M35.A06", { websiteId: site.id, pageId })).code, "CONFLICT");
});

test("navigation entries must point at pages on the site", async () => {
  const w = await testWorld();
  const site = w.f.website();
  assert.equal(failure(() => w.call("M35.A07", { websiteId: site.id, navigation: [{ label: "Home", pageId: "pg_404" }] })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M35.A07", { websiteId: site.id, navigation: [] })).code, "CONFLICT");
  const added = w.call("M35.A05", { websiteId: site.id, title: "Home", slug: "home" });
  const nav = w.call("M35.A07", { websiteId: site.id, navigation: [{ label: "Home", pageId: added.pages[0].id }] });
  assert.equal(nav.navigation[0].label, "Home");
});

test("SEO no-op is a conflict, and a real change sticks", async () => {
  const w = await testWorld();
  const site = w.f.website();
  assert.equal(failure(() => w.call("M35.A08", { websiteId: site.id, title: null })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M35.A08", { websiteId: site.id })).code, "INVALID");
  assert.equal(w.call("M35.A08", { websiteId: site.id, title: "Acme", description: "" }).seoDefaults.title, "Acme");
});

test("publish requires a home page; unpublish returns a live site to draft", async () => {
  const w = await testWorld();
  const site = w.f.website();
  assert.equal(failure(() => w.call("M35.A09", { websiteId: site.id })).code, "CONFLICT");
  assert.match(failure(() => w.call("M35.A09", { websiteId: site.id })).message, /home page/);
  const added = w.call("M35.A05", { websiteId: site.id, title: "Home", slug: "home" });
  w.call("M35.A06", { websiteId: site.id, pageId: added.pages[0].id });
  const live = w.call("M35.A09", { websiteId: site.id });
  assert.equal(live.status, "published");
  assert.ok(live.publishedAt);
  assert.equal(failure(() => w.call("M35.A09", { websiteId: site.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M35.A10", { websiteId: w.f.website().id })).code, "CONFLICT");
  const draft = w.call("M35.A10", { websiteId: site.id });
  assert.equal(draft.status, "draft");
  assert.equal(draft.publishedAt, null);
  assert.equal(draft.homePageId, added.pages[0].id);
});

test("list is sorted by name then id", async () => {
  const w = await testWorld();
  w.f.website({ name: "Beta" });
  w.f.website({ name: "Alpha" });
  const listed = w.call("M35.A03", { limit: 1 });
  assert.equal(listed.total, 2);
  assert.equal(listed.items[0].name, "Alpha");
});

test("unknown field is INVALID", async () => {
  const w = await testWorld();
  const site = w.f.website();
  assert.equal(failure(() => w.call("M35.A02", { websiteId: site.id, madeUp: 1 })).code, "INVALID");
});

test("M35.A09 publish and M35.A10 unpublish need messaging.send", async () => {
  const w = await testWorld();
  const billing = w.f.user({ roles: ["billing"] });
  const marketing = w.f.user({ roles: ["marketing"] });
  const site = w.f.website();
  const home = w.call("M35.A05", { websiteId: site.id, title: "Home", slug: "home" }).pages[0];
  w.call("M35.A06", { websiteId: site.id, pageId: home.id });

  assert.equal(failure(() => w.call("M35.A09", { websiteId: site.id }, billing.id)).code, "PERMISSION");
  assert.equal(failure(() => w.call("M35.A09", { websiteId: site.id }, "us_missing")).code, "PERMISSION");
  assert.equal(w.call("M35.A02", { websiteId: site.id }).status, "draft");

  assert.equal(w.call("M35.A09", { websiteId: site.id }, marketing.id).status, "published");

  assert.equal(failure(() => w.call("M35.A10", { websiteId: site.id }, billing.id)).code, "PERMISSION");
  assert.equal(w.call("M35.A02", { websiteId: site.id }).status, "published");
  assert.equal(w.call("M35.A10", { websiteId: site.id }, marketing.id).status, "draft");
});
