import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";
import { Form } from "../m18-forms/schema.js";
import type { TestWorld } from "../../testkit.js";

function form(w: TestWorld, status: "draft" | "published" | "archived") {
  return w.f.make("forms", "fm", Form, {
    name: `Form ${status} ${w.f.seq()}`,
    fields: [],
    status,
    createdAt: w.f.now(),
    updatedAt: w.f.now(),
    publishedAt: status === "published" ? w.f.now() : null,
  });
}

test("slug is unique across landing pages", async () => {
  const w = await testWorld();
  w.call("M37.A01", { title: "Offer", slug: "Offer" });
  assert.equal(failure(() => w.call("M37.A01", { title: "Other", slug: "offer" })).code, "DUPLICATE");
});

test("title and slug of a published page are refused; media can still change", async () => {
  const w = await testWorld();
  const page = w.f.landingPage({ status: "published", publishedAt: w.f.now() });
  assert.equal(failure(() => w.call("M37.A04", { landingPageId: page.id, title: "Next" })).code, "CONFLICT");
  const asset = w.f.mediaAsset();
  assert.deepEqual(w.call("M37.A04", { landingPageId: page.id, mediaIds: [asset.id] }).mediaIds, [asset.id]);
  const draft = w.f.landingPage({ title: "Same" });
  assert.equal(failure(() => w.call("M37.A04", { landingPageId: draft.id, title: "Same" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M37.A04", { landingPageId: draft.id, mediaIds: ["md_99999"] })).code, "NOT_FOUND");
});

test("sections can be added and reordered only on a draft", async () => {
  const w = await testWorld();
  const live = w.f.landingPage({ status: "published", publishedAt: w.f.now() });
  assert.equal(failure(() => w.call("M37.A05", { landingPageId: live.id, type: "hero", heading: "Hi" })).code, "CONFLICT");
  const draft = w.f.landingPage();
  const added = w.call("M37.A05", { landingPageId: draft.id, type: "hero", heading: "Hi" });
  assert.equal(added.sections.length, 1);
  const again = w.call("M37.A05", { landingPageId: draft.id, type: "text", body: "More" });
  const ids = again.sections.map((s: { id: string }) => s.id);
  assert.equal(failure(() => w.call("M37.A06", { landingPageId: draft.id, sectionIds: ids })).code, "CONFLICT");
  assert.deepEqual(
    w.call("M37.A06", { landingPageId: draft.id, sectionIds: [ids[1], ids[0]] }).sections.map((s: { id: string }) => s.id),
    [ids[1], ids[0]],
  );
});

test("a draft form cannot be attached to a published page", async () => {
  const w = await testWorld();
  const live = w.f.landingPage({ status: "published", publishedAt: w.f.now() });
  const draft = form(w, "draft");
  const err = failure(() => w.call("M37.A07", { landingPageId: live.id, formId: draft.id }));
  assert.equal(err.code, "CONFLICT");
  assert.match(err.message, /draft form/);
  assert.equal(failure(() => w.call("M37.A07", { landingPageId: live.id, formId: "fm_99999" })).code, "NOT_FOUND");
  const published = form(w, "published");
  assert.equal(w.call("M37.A07", { landingPageId: live.id, formId: published.id }).formId, published.id);
  assert.equal(failure(() => w.call("M37.A07", { landingPageId: live.id, formId: published.id })).code, "CONFLICT");
  const archived = form(w, "archived");
  assert.equal(failure(() => w.call("M37.A07", { landingPageId: w.f.landingPage().id, formId: archived.id })).code, "CONFLICT");
});

test("publishing a page with a draft form is refused until the form is published", async () => {
  const w = await testWorld();
  const page = w.call("M37.A01", { title: "Offer", slug: "offer-page" });
  const draft = form(w, "draft");
  w.call("M37.A07", { landingPageId: page.id, formId: draft.id });
  const err = failure(() => w.call("M37.A09", { landingPageId: page.id }));
  assert.equal(err.code, "CONFLICT");
  assert.match(err.message, /Publish the form first/);
  w.store.update("forms", draft.id, { status: "published", publishedAt: w.f.now() });
  assert.equal(w.call("M37.A09", { landingPageId: page.id }).status, "published");
  assert.equal(w.call("M37.A01", { title: "Plain", slug: "plain-page" }).status, "draft");
  const plain = w.f.landingPage({ slug: "plain-ready" });
  assert.equal(w.call("M37.A09", { landingPageId: plain.id }).status, "published");
});

test("SEO no-op conflicts, and unpublish is only for a live page", async () => {
  const w = await testWorld();
  const page = w.f.landingPage();
  assert.equal(failure(() => w.call("M37.A08", { landingPageId: page.id, title: null })).code, "CONFLICT");
  assert.equal(w.call("M37.A08", { landingPageId: page.id, description: "Details" }).seo.description, "Details");
  assert.equal(failure(() => w.call("M37.A10", { landingPageId: page.id })).code, "CONFLICT");
  const live = w.call("M37.A09", { landingPageId: page.id });
  assert.equal(w.call("M37.A10", { landingPageId: live.id }).status, "draft");
});

test("search is sorted by title then id", async () => {
  const w = await testWorld();
  w.f.landingPage({ title: "Beta", slug: "beta-page" });
  w.f.landingPage({ title: "Alpha", slug: "alpha-page" });
  const found = w.call("M37.A03", { query: "page" });
  assert.deepEqual(found.items.map((p: { title: string }) => p.title), ["Alpha", "Beta"]);
});

test("unknown field is INVALID", async () => {
  const w = await testWorld();
  const page = w.f.landingPage();
  assert.equal(failure(() => w.call("M37.A02", { landingPageId: page.id, madeUp: 1 })).code, "INVALID");
});
