import "./fixtures.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { atLeastOne, blankToNull, contains, Limit, listOf, noChange, page, requirePermission, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import { Website, type SitePage } from "./schema.js";

export { Website } from "./schema.js";

// A website is a named collection of pages. It can go live only after one of those pages is the home page.

const WebsiteId = z.string().describe("website id (ws_…)");
const Text = z.string().trim().min(1);
const SeoText = z.string().trim().nullable().optional();

function load(store: Store, id: string): Website {
  return mustGet<Website>(store, "websites", id, "website");
}

function nameTaken(store: Store, name: string, exceptId?: string): boolean {
  const key = name.trim().toLowerCase();
  return store.find<Website>("websites", (w) => w.id !== exceptId && w.name.trim().toLowerCase() === key).length > 0;
}

function domainTaken(store: Store, domain: string, exceptId?: string): boolean {
  const key = domain.trim().toLowerCase();
  return store.find<Website>("websites", (w) => w.id !== exceptId && !!w.domain && w.domain.trim().toLowerCase() === key).length > 0;
}

const createWebsite = defineAction({
  id: "M35.A01",
  description:
    "Create a draft website with a unique name and an optional domain. It has no pages yet; add them with M35.A05, choose a home page with M35.A06, then publish with M35.A09.",
  risk: "write",
  input: z.strictObject({ name: Text, domain: z.string().trim().min(1).nullable().optional() }),
  output: Website,
  entities: { produces: "website" },
  example: () => ({ name: "Northwind Site", domain: "northwind.example" }),
  handler: (a, { store, clock }) => {
    const name = a.name.trim();
    if (nameTaken(store, name)) throw new ActionError("DUPLICATE", `A website named "${name}" already exists`);
    const domain = a.domain ?? null;
    if (domain && domainTaken(store, domain)) throw new ActionError("DUPLICATE", `A website with domain "${domain}" already exists`);
    const at = clock.now().toISOString();
    return store.insert("websites", "ws", {
      name,
      domain,
      pages: [],
      homePageId: null,
      navigation: [],
      seoDefaults: { title: null, description: null },
      status: "draft" as const,
      createdAt: at,
      updatedAt: at,
      publishedAt: null,
    });
  },
});

const getWebsite = defineAction({
  id: "M35.A02",
  description:
    "Get one website's settings: domain, pages, home page, navigation, SEO defaults and whether it is published. To browse several sites, use M35.A03 List websites.",
  risk: "read",
  input: z.strictObject({ websiteId: WebsiteId }),
  output: Website,
  entities: { consumes: ["website"] },
  example: (f) => ({ websiteId: f.website().id }),
  handler: ({ websiteId }, { store }) => load(store, websiteId),
});

const listWebsites = defineAction({
  id: "M35.A03",
  description:
    "List websites by status or by words in the name or domain, sorted by name then id. To read one site's pages and menu, use M35.A02 Get website settings.",
  risk: "read",
  input: z.strictObject({
    status: z.enum(["draft", "published"]).optional(),
    query: z.string().optional().describe("words in the name or domain"),
    limit: Limit,
  }),
  output: listOf(Website),
  entities: { produces: "website" },
  example: () => ({}),
  handler: (a, { store }) => {
    const query = a.query?.trim();
    const items = store.find<Website>(
      "websites",
      (w) => (!a.status || w.status === a.status) && (!query || contains(w.name, query) || contains(w.domain, query)),
    );
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const renameWebsite = defineAction({
  id: "M35.A04",
  description:
    "Rename a website. The new name must be unique across sites. This does not change the domain, the pages or the published status; publishing is M35.A09.",
  risk: "write",
  input: z.strictObject({ websiteId: WebsiteId, name: Text }),
  output: Website,
  entities: { consumes: ["website"] },
  example: (f) => ({ websiteId: f.website().id, name: "Renamed site" }),
  handler: ({ websiteId, name }, { store, clock }) => {
    const w = load(store, websiteId);
    const next = name.trim();
    if (next === w.name) noChange();
    if (nameTaken(store, next, w.id)) throw new ActionError("DUPLICATE", `A website named "${next}" already exists`);
    return store.update<Website>("websites", w.id, { name: next, updatedAt: clock.now().toISOString() });
  },
});

const addPage = defineAction({
  id: "M35.A05",
  description:
    "Add a page to a website. The slug must be unique on that site (another site may reuse it). Optionally point the page at an existing landing page. To make it the home page, use M35.A06.",
  risk: "write",
  input: z.strictObject({
    websiteId: WebsiteId,
    title: Text,
    slug: Text,
    landingPageId: z.string().optional().describe("landing page id (lp_…), if this page shows one"),
  }),
  output: Website,
  entities: { consumes: ["website"] },
  example: (f) => ({ websiteId: f.website().id, title: "About", slug: "about" }),
  handler: (a, { store, clock }) => {
    const w = load(store, a.websiteId);
    const slug = a.slug.trim();
    if (w.pages.some((p) => p.slug.toLowerCase() === slug.toLowerCase())) {
      throw new ActionError("DUPLICATE", `This website already has a page with slug "${slug}"`);
    }
    if (a.landingPageId) mustGet(store, "landing_pages", a.landingPageId, "landing page");
    const page: SitePage = { id: store.nextId("_nested", "pg"), title: a.title.trim(), slug, landingPageId: a.landingPageId ?? null };
    return store.update<Website>("websites", w.id, { pages: [...w.pages, page], updatedAt: clock.now().toISOString() });
  },
});

const setHome = defineAction({
  id: "M35.A06",
  description:
    "Choose which of this website's pages is the home page. The page must already be on the site (M35.A05). Publishing (M35.A09) is refused until a home page is set.",
  risk: "write",
  input: z.strictObject({ websiteId: WebsiteId, pageId: z.string().describe("page id on this website") }),
  output: Website,
  entities: { consumes: ["website"] },
  example: (f) => {
    const pageId = `pg_${f.seq()}`;
    const website = f.website({ pages: [{ id: pageId, title: "Home", slug: "home", landingPageId: null }] });
    return { websiteId: website.id, pageId };
  },
  handler: ({ websiteId, pageId }, { store, clock }) => {
    const w = load(store, websiteId);
    if (!w.pages.some((p) => p.id === pageId)) throw new ActionError("CONFLICT", `Page ${pageId} is not on this website; add it with M35.A05 first`);
    if (w.homePageId === pageId) noChange();
    return store.update<Website>("websites", w.id, { homePageId: pageId, updatedAt: clock.now().toISOString() });
  },
});

const NavItem = z.strictObject({ label: Text, pageId: z.string().describe("page id on this website") });

const updateNav = defineAction({
  id: "M35.A07",
  description:
    "Replace the website's navigation menu, in the order given. Every entry must point at a page already on this site. This does not add pages; use M35.A05 Add website page for that.",
  risk: "write",
  input: z.strictObject({ websiteId: WebsiteId, navigation: z.array(NavItem) }),
  output: Website,
  entities: { consumes: ["website"] },
  example: (f) => {
    const pageId = `pg_${f.seq()}`;
    const website = f.website({ pages: [{ id: pageId, title: "Home", slug: "home", landingPageId: null }] });
    return { websiteId: website.id, navigation: [{ label: "Home", pageId }] };
  },
  handler: ({ websiteId, navigation }, { store, clock }) => {
    const w = load(store, websiteId);
    const next = navigation.map((item) => {
      if (!w.pages.some((p) => p.id === item.pageId)) {
        throw new ActionError("CONFLICT", `Page ${item.pageId} is not on this website; add it with M35.A05 first`);
      }
      return { label: item.label.trim(), pageId: item.pageId };
    });
    if (JSON.stringify(next) === JSON.stringify(w.navigation)) noChange();
    return store.update<Website>("websites", w.id, { navigation: next, updatedAt: clock.now().toISOString() });
  },
});

const setSeo = defineAction({
  id: "M35.A08",
  description:
    "Set the website's default SEO title and description. These are the site-wide defaults, not one landing page's metadata (that is M37.A08). Pass at least one field.",
  risk: "write",
  input: z.strictObject({ websiteId: WebsiteId, title: SeoText, description: SeoText }),
  output: Website,
  entities: { consumes: ["website"] },
  example: (f) => ({ websiteId: f.website().id, title: "Acme site" }),
  handler: (a, { store, clock }) => {
    atLeastOne(a, ["title", "description"]);
    const w = load(store, a.websiteId);
    const title = a.title === undefined ? w.seoDefaults.title : blankToNull(a.title);
    const description = a.description === undefined ? w.seoDefaults.description : blankToNull(a.description);
    if (title === w.seoDefaults.title && description === w.seoDefaults.description) noChange();
    return store.update<Website>("websites", w.id, { seoDefaults: { title, description }, updatedAt: clock.now().toISOString() });
  },
});

const publishWebsite = defineAction({
  id: "M35.A09",
  description:
    "Publish a draft website so it is live. A home page must already be set (M35.A06); otherwise this is refused. Taking a live site offline is M35.A10 Unpublish website. Unlike M37.A09 Publish landing page, M36.A09 Publish funnel and M38.A09 Publish post, this puts the whole site live, not a single page, funnel or article.",
  risk: "external",
  input: z.strictObject({ websiteId: WebsiteId }),
  output: Website,
  siblings: ["M36.A09", "M37.A09", "M38.A09"],
  entities: { consumes: ["website"] },
  example: (f) => {
    const pageId = `pg_${f.seq()}`;
    const website = f.website({
      pages: [{ id: pageId, title: "Home", slug: "home", landingPageId: null }],
      homePageId: pageId,
    });
    return { websiteId: website.id };
  },
  handler: ({ websiteId }, { store, clock, actorId }) => {
    // Going live puts content in front of the public, so it is held to the same bar as sending (see WAVE1-ASSUMPTIONS.md).
    requirePermission(store, actorId, "messaging.send");
    const w = load(store, websiteId);
    requireState(`Website "${w.name}"`, w.status, ["draft"], "be published");
    if (!w.homePageId || !w.pages.some((p) => p.id === w.homePageId)) {
      throw new ActionError("CONFLICT", "Set a home page before publishing this website");
    }
    const at = clock.now().toISOString();
    return store.update<Website>("websites", w.id, { status: "published", publishedAt: at, updatedAt: at });
  },
});

const unpublishWebsite = defineAction({
  id: "M35.A10",
  description:
    "Take a published website offline and return it to draft. Pages, the home page and the menu are kept. To put it back online, use M35.A09 Publish website. Unlike M37.A10 Unpublish landing page and M38.A10 Unpublish post, this takes the whole site offline, not a single page or article.",
  risk: "destructive",
  input: z.strictObject({ websiteId: WebsiteId }),
  output: Website,
  siblings: ["M37.A10", "M38.A10"],
  entities: { consumes: ["website"] },
  example: (f) => ({ websiteId: f.website({ status: "published", publishedAt: f.now() }).id }),
  handler: ({ websiteId }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "messaging.send");
    const w = load(store, websiteId);
    requireState(`Website "${w.name}"`, w.status, ["published"], "be unpublished");
    return store.update<Website>("websites", w.id, { status: "draft", publishedAt: null, updatedAt: clock.now().toISOString() });
  },
});

export default {
  actions: [createWebsite, getWebsite, listWebsites, renameWebsite, addPage, setHome, updateNav, setSeo, publishWebsite, unpublishWebsite],
} satisfies ModuleExports;
