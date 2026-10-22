import "./fixtures.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { atLeastOne, contains, Limit, listOf, noChange, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import { Form } from "../m18-forms/schema.js";
import { LandingPage, type PageSection } from "./schema.js";

export { LandingPage } from "./schema.js";

// A landing page is published on its own. A draft form can sit on a draft page, but not on a page that is published or being published.

const PageId = z.string().describe("landing page id (lp_…)");
const Text = z.string().trim().min(1);
const SeoText = z.string().trim().nullable().optional();
const SectionType = z.enum(["hero", "text", "image", "cta", "form"]);

function load(store: Store, id: string): LandingPage {
  return mustGet<LandingPage>(store, "landing_pages", id, "landing page");
}

function slugTaken(store: Store, slug: string, exceptId?: string): boolean {
  const key = slug.trim().toLowerCase();
  return store.find<LandingPage>("landing_pages", (p) => p.id !== exceptId && p.slug.toLowerCase() === key).length > 0;
}

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function mediaIdsOf(store: Store, ids: string[]): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    mustGet(store, "media_assets", id, "media asset");
    next.push(id);
  }
  return next;
}

const createPage = defineAction({
  id: "M37.A01",
  description:
    "Create a draft landing page with a title and a slug unique across landing pages. Add sections with M37.A05 and publish with M37.A09. This does not upload a file (that is M39, whose delete is M39.A10).",
  risk: "write",
  input: z.strictObject({ title: Text, slug: Text }),
  output: LandingPage,
  siblings: ["M39.A10"],
  entities: { produces: "landing_page" },
  example: () => ({ title: "Spring offer", slug: "spring-offer" }),
  handler: ({ title, slug }, { store, clock }) => {
    const nextSlug = slug.trim();
    if (slugTaken(store, nextSlug)) throw new ActionError("DUPLICATE", `A landing page with slug "${nextSlug}" already exists`);
    const at = clock.now().toISOString();
    return store.insert("landing_pages", "lp", {
      title: title.trim(),
      slug: nextSlug,
      sections: [],
      formId: null,
      mediaIds: [],
      seo: { title: null, description: null },
      status: "draft" as const,
      createdAt: at,
      updatedAt: at,
      publishedAt: null,
    });
  },
});

const getPage = defineAction({
  id: "M37.A02",
  description:
    "Get one landing page: its sections, form, media, SEO and whether it is published. To find pages by title or slug, use M37.A03 Search landing pages.",
  risk: "read",
  input: z.strictObject({ landingPageId: PageId }),
  output: LandingPage,
  entities: { consumes: ["landing_page"] },
  example: (f) => ({ landingPageId: f.landingPage().id }),
  handler: ({ landingPageId }, { store }) => load(store, landingPageId),
});

const searchPages = defineAction({
  id: "M37.A03",
  description:
    "Search landing pages by title, slug or status, sorted by title then id. To read every section of one page, use M37.A02 Get landing page.",
  risk: "read",
  input: z.strictObject({
    query: z.string().optional().describe("words in the title or slug"),
    status: z.enum(["draft", "published"]).optional(),
    limit: Limit,
  }),
  output: listOf(LandingPage),
  entities: { produces: "landing_page" },
  example: () => ({}),
  handler: (a, { store }) => {
    const query = a.query?.trim();
    const items = store.find<LandingPage>(
      "landing_pages",
      (p) => (!a.status || p.status === a.status) && (!query || contains(p.title, query) || contains(p.slug, query)),
    );
    items.sort((x, y) => x.title.localeCompare(y.title) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const updateContent = defineAction({
  id: "M37.A04",
  description:
    "Change a draft landing page's title or slug, or replace the media assets it uses. Title and slug are refused while the page is published (unpublish with M37.A10 first). Adding a section is M37.A05.",
  risk: "write",
  input: z.strictObject({
    landingPageId: PageId,
    title: Text.optional(),
    slug: Text.optional(),
    mediaIds: z.array(z.string()).optional().describe("media asset ids (md_…) that this page uses"),
  }),
  output: LandingPage,
  entities: { consumes: ["landing_page"] },
  example: (f) => ({ landingPageId: f.landingPage().id, title: "Spring offer revised" }),
  handler: (a, { store, clock }) => {
    atLeastOne(a, ["title", "slug", "mediaIds"]);
    const p = load(store, a.landingPageId);
    if ((a.title !== undefined || a.slug !== undefined) && p.status !== "draft") {
      requireState(`Landing page "${p.title}"`, p.status, ["draft"], "have its title or slug changed — unpublish it first");
    }
    const title = a.title === undefined ? p.title : a.title.trim();
    const slug = a.slug === undefined ? p.slug : a.slug.trim();
    if (a.slug !== undefined && slug.toLowerCase() !== p.slug.toLowerCase() && slugTaken(store, slug, p.id)) {
      throw new ActionError("DUPLICATE", `A landing page with slug "${slug}" already exists`);
    }
    const mediaIds = a.mediaIds === undefined ? p.mediaIds : mediaIdsOf(store, a.mediaIds);
    if (title === p.title && slug === p.slug && JSON.stringify(mediaIds) === JSON.stringify(p.mediaIds)) noChange();
    return store.update<LandingPage>("landing_pages", p.id, { title, slug, mediaIds, updatedAt: clock.now().toISOString() });
  },
});

const addSection = defineAction({
  id: "M37.A05",
  description:
    "Append a section (hero, text, image, call to action or form) to a draft landing page. Reorder sections with M37.A06. A published page must be unpublished first (M37.A10).",
  risk: "write",
  input: z.strictObject({
    landingPageId: PageId,
    type: SectionType,
    heading: z.string().trim().nullable().optional(),
    body: z.string().trim().nullable().optional(),
  }),
  output: LandingPage,
  entities: { consumes: ["landing_page"] },
  example: (f) => ({ landingPageId: f.landingPage().id, type: "hero", heading: "Welcome" }),
  handler: (a, { store, clock }) => {
    const p = load(store, a.landingPageId);
    requireState(`Landing page "${p.title}"`, p.status, ["draft"], "have a section added — unpublish it first");
    const section: PageSection = {
      id: store.nextId("_nested", "sc"),
      type: a.type,
      heading: a.heading == null ? null : blankToNull(a.heading),
      body: a.body == null ? null : blankToNull(a.body),
    };
    return store.update<LandingPage>("landing_pages", p.id, { sections: [...p.sections, section], updatedAt: clock.now().toISOString() });
  },
});

const reorderSections = defineAction({
  id: "M37.A06",
  description:
    "Reorder a draft landing page's sections. Pass every section id exactly once. This does not add sections (M37.A05) or publish the page (M37.A09).",
  risk: "write",
  input: z.strictObject({ landingPageId: PageId, sectionIds: z.array(z.string()).describe("every section id, in the new order") }),
  output: LandingPage,
  entities: { consumes: ["landing_page"] },
  example: (f) => {
    const first = `sc_${f.seq()}`;
    const second = `sc_${f.seq()}`;
    const page = f.landingPage({
      sections: [
        { id: first, type: "hero", heading: "Hi", body: null },
        { id: second, type: "text", heading: null, body: "More" },
      ],
    });
    return { landingPageId: page.id, sectionIds: [second, first] };
  },
  handler: ({ landingPageId, sectionIds }, { store, clock }) => {
    const p = load(store, landingPageId);
    requireState(`Landing page "${p.title}"`, p.status, ["draft"], "have its sections reordered — unpublish it first");
    if (sectionIds.length !== p.sections.length || new Set(sectionIds).size !== sectionIds.length) {
      throw new ActionError("INVALID", "Give every section id exactly once");
    }
    const byId = new Map(p.sections.map((s) => [s.id, s]));
    const sections: PageSection[] = [];
    for (const id of sectionIds) {
      const section = byId.get(id);
      if (!section) throw new ActionError("INVALID", `Section ${id} is not on this page`);
      sections.push(section);
    }
    if (sections.every((s, i) => s.id === p.sections[i]?.id)) noChange();
    return store.update<LandingPage>("landing_pages", p.id, { sections, updatedAt: clock.now().toISOString() });
  },
});

const attachForm = defineAction({
  id: "M37.A07",
  description:
    "Attach an existing form to a landing page. If the page is already published, the form must be published too (M18.A08); a draft form is refused. Publishing the page itself is M37.A09, and a funnel that shows it is M36.A09.",
  risk: "write",
  input: z.strictObject({ landingPageId: PageId, formId: z.string().describe("form id (fm_…)") }),
  output: LandingPage,
  siblings: ["M18.A08", "M36.A09"],
  entities: { consumes: ["landing_page", "form"] },
  example: (f) => {
    const form = f.make("forms", "fm", Form, {
      name: "Workshop signup",
      fields: [],
      status: "published",
      createdAt: f.now(),
      updatedAt: f.now(),
      publishedAt: f.now(),
    });
    return { landingPageId: f.landingPage().id, formId: form.id };
  },
  handler: ({ landingPageId, formId }, { store, clock }) => {
    const p = load(store, landingPageId);
    const form = mustGet<Form>(store, "forms", formId, "form");
    if (form.status === "archived") throw new ActionError("CONFLICT", `Form "${form.name}" is archived and can't be attached`);
    if (p.status === "published" && form.status !== "published") {
      throw new ActionError("CONFLICT", "A draft form can't be attached to a published page. Publish the form first");
    }
    if (p.formId === form.id) noChange();
    return store.update<LandingPage>("landing_pages", p.id, { formId: form.id, updatedAt: clock.now().toISOString() });
  },
});

const setSeo = defineAction({
  id: "M37.A08",
  description:
    "Set a landing page's own SEO title and description, whether the page is draft or published. This is not the website's default SEO (M35.A08). Pass at least one field.",
  risk: "write",
  input: z.strictObject({ landingPageId: PageId, title: SeoText, description: SeoText }),
  output: LandingPage,
  entities: { consumes: ["landing_page"] },
  example: (f) => ({ landingPageId: f.landingPage().id, title: "Spring offer" }),
  handler: (a, { store, clock }) => {
    atLeastOne(a, ["title", "description"]);
    const p = load(store, a.landingPageId);
    const title = a.title === undefined ? p.seo.title : blankToNull(a.title);
    const description = a.description === undefined ? p.seo.description : blankToNull(a.description);
    if (title === p.seo.title && description === p.seo.description) noChange();
    return store.update<LandingPage>("landing_pages", p.id, { seo: { title, description }, updatedAt: clock.now().toISOString() });
  },
});

const publishPage = defineAction({
  id: "M37.A09",
  description:
    "Publish a draft landing page. If a form is attached, that form must already be published (M18.A08); otherwise publish the form first. A funnel (M36.A09) can show this page only after this succeeds.",
  risk: "external",
  input: z.strictObject({ landingPageId: PageId }),
  output: LandingPage,
  siblings: ["M18.A08", "M36.A09"],
  entities: { consumes: ["landing_page", "form"] },
  example: (f) => ({ landingPageId: f.landingPage().id }),
  handler: ({ landingPageId }, { store, clock }) => {
    const p = load(store, landingPageId);
    requireState(`Landing page "${p.title}"`, p.status, ["draft"], "be published");
    if (p.formId) {
      const form = mustGet<Form>(store, "forms", p.formId, "form");
      if (form.status !== "published") throw new ActionError("CONFLICT", "Publish the form first");
    }
    const at = clock.now().toISOString();
    return store.update<LandingPage>("landing_pages", p.id, { status: "published", publishedAt: at, updatedAt: at });
  },
});

const unpublishPage = defineAction({
  id: "M37.A10",
  description:
    "Take a published landing page back to draft. A funnel that still links to it cannot be published until the page is published again with M37.A09.",
  risk: "destructive",
  input: z.strictObject({ landingPageId: PageId }),
  output: LandingPage,
  entities: { consumes: ["landing_page"] },
  example: (f) => ({ landingPageId: f.landingPage({ status: "published", publishedAt: f.now() }).id }),
  handler: ({ landingPageId }, { store, clock }) => {
    const p = load(store, landingPageId);
    requireState(`Landing page "${p.title}"`, p.status, ["published"], "be unpublished");
    return store.update<LandingPage>("landing_pages", p.id, { status: "draft", publishedAt: null, updatedAt: clock.now().toISOString() });
  },
});

export default {
  actions: [createPage, getPage, searchPages, updateContent, addSection, reorderSections, attachForm, setSeo, publishPage, unpublishPage],
} satisfies ModuleExports;
