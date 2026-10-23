import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { namedResolver } from "../../registry/lookup.js";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import {
  contains,
  Limit,
  listOf,
  norm,
  page,
  requirePermission,
} from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { ActionContext } from "../../registry/define.js";
import type { Store } from "../../store/db.js";
import { defaultHours, Hours, Listing } from "./schema.js";

const Text = z.string().trim().min(1);
const ListingId = Text.describe("business listing id (bl_…)");
const Phone = Text.regex(/^\+\d{10,15}$/, "use + and 10–15 digits");
const Categories = z.array(Text).min(1).max(20);
const tidy = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))];
const get = (s: Store, id: string) =>
  mustGet<Listing>(s, "listings", id, "business listing");
function unique(
  store: Store,
  name: string,
  address: string,
  directory: string,
  except?: string,
) {
  if (
    store.find<Listing>(
      "listings",
      (l) =>
        l.id !== except &&
        norm(l.name) === norm(name) &&
        norm(l.address) === norm(address) &&
        norm(l.directory) === norm(directory),
    ).length
  )
    throw new ActionError(
      "DUPLICATE",
      "This business/location already has a listing on that directory",
    );
}
function change(
  ctx: ActionContext,
  id: string,
  patch: Partial<Listing>,
): Listing {
  const l = get(ctx.store, id);
  if (
    Object.entries(patch).every(
      ([k, v]) => isDeepStrictEqual(l[k as keyof Listing], v),
    )
  )
    throw new ActionError("CONFLICT", "The listing is unchanged");
  unique(
    ctx.store,
    patch.name ?? l.name,
    patch.address ?? l.address,
    l.directory,
    l.id,
  );
  return ctx.store.update<Listing>("listings", l.id, {
    ...patch,
    version: l.version + 1,
    updatedAt: ctx.clock.now().toISOString(),
    failureReason: null,
  });
}
const create = defineAction({
  id: "M46.A01",
  description:
    "Create a draft business listing for one directory and address. The same business may have listings on different directories; duplicate business/location/directory combinations are refused.",
  risk: "write",
  input: z.strictObject({
    name: Text,
    directory: Text,
    address: Text,
    phone: Phone,
    categories: Categories.optional(),
    hours: Hours.optional(),
  }),
  output: Listing,
  entities: { produces: "listing" },
  example: () => ({
    name: "Test Business",
    directory: "google",
    address: "1 Test Road",
    phone: "+15550123456",
  }),
  handler: (a, { store, clock }) => {
    unique(store, a.name, a.address, a.directory);
    const at = clock.now().toISOString();
    return store.insert("listings", "bl", {
      ...a,
      directory: a.directory.toLowerCase(),
      categories: tidy(a.categories ?? ["business"]),
      hours: a.hours ?? defaultHours(),
      timezone: "America/New_York" as const,
      version: 1,
      publishedVersion: null,
      publishedAt: null,
      lastSyncAt: null,
      failureReason: null,
      createdAt: at,
      updatedAt: at,
    });
  },
});
const details = defineAction({
  id: "M46.A02",
  description:
    "Get one business listing, including directory, address, phone, categories, weekly hours and publication version.",
  risk: "read",
  input: z.strictObject({ listingId: ListingId }),
  output: Listing,
  entities: { consumes: ["listing"] },
  example: (f) => ({ listingId: f.listing().id }),
  handler: ({ listingId }, { store }) => get(store, listingId),
});
const search = defineAction({
  id: "M46.A03",
  description:
    "Search business listings by name/address text or directory. A business can appear once per directory/location; ask which one if several match.",
  risk: "read",
  input: z.strictObject({
    query: Text.optional(),
    directory: Text.optional(),
    limit: Limit,
  }),
  output: listOf(Listing),
  entities: { produces: "listing" },
  example: () => ({}),
  handler: (a, { store }) =>
    page(
      store
        .find<Listing>(
          "listings",
          (l) =>
            (!a.query ||
              contains(l.name, a.query) ||
              contains(l.address, a.query)) &&
            (!a.directory || norm(l.directory) === norm(a.directory)),
        )
        .sort(
          (x, y) =>
            x.name.localeCompare(y.name) ||
            x.directory.localeCompare(y.directory) ||
            x.id.localeCompare(y.id),
        ),
      a.limit,
    ),
});
const rename = defineAction({
  id: "M46.A04",
  description:
    "Update a business listing's name; its directory and location identify which listing changes. Publishing later syncs this change.",
  risk: "write",
  input: z.strictObject({ listingId: ListingId, name: Text }),
  output: Listing,
  entities: { consumes: ["listing"] },
  example: (f) => ({ listingId: f.listing().id, name: "Renamed business" }),
  handler: ({ listingId, name }, ctx) => change(ctx, listingId, { name }),
});
const address = defineAction({
  id: "M46.A05",
  description:
    "Update the address of one business listing, without publishing it.",
  risk: "write",
  input: z.strictObject({ listingId: ListingId, address: Text }),
  output: Listing,
  entities: { consumes: ["listing"] },
  example: (f) => ({ listingId: f.listing().id, address: "2 Test Road" }),
  handler: ({ listingId, address }, ctx) => change(ctx, listingId, { address }),
});
const phone = defineAction({
  id: "M46.A06",
  description:
    "Update the phone number on one business directory listing. Does not change a contact's phone or publish the listing.",
  risk: "write",
  input: z.strictObject({ listingId: ListingId, phone: Phone }),
  output: Listing,
  entities: { consumes: ["listing"] },
  example: (f) => ({ listingId: f.listing().id, phone: "+15550987654" }),
  handler: ({ listingId, phone }, ctx) => change(ctx, listingId, { phone }),
});
const hours = defineAction({
  id: "M46.A07",
  description:
    "Replace a business listing's weekly hours in America/New_York. Give all seven lowercase weekday keys; each is {open:'09:00',close:'17:00'} or null for closed. One interval per day, no overnight hours.",
  risk: "write",
  input: z.strictObject({ listingId: ListingId, hours: Hours }),
  output: Listing,
  entities: { consumes: ["listing"] },
  example: (f) => ({
    listingId: f.listing().id,
    hours: { ...defaultHours(), monday: { open: "09:00", close: "17:00" } },
  }),
  handler: ({ listingId, hours }, ctx) => change(ctx, listingId, { hours }),
});
const categories = defineAction({
  id: "M46.A08",
  description:
    "Replace a business listing's category list (non-empty, deduplicated). Does not publish the changes.",
  risk: "write",
  input: z.strictObject({ listingId: ListingId, categories: Categories }),
  output: Listing,
  entities: { consumes: ["listing"] },
  example: (f) => ({ listingId: f.listing().id, categories: ["dentist"] }),
  handler: ({ listingId, categories }, ctx) =>
    change(ctx, listingId, { categories: tidy(categories) }),
});
const publish = defineAction({
  id: "M46.A09",
  description:
    "Publish or sync the latest version of a business listing to its simulated directory. This publishes a business profile, not a customer review response. No real directory is contacted.",
  risk: "external",
  input: z.strictObject({ listingId: ListingId }),
  output: Listing,
  entities: { consumes: ["listing"] },
  example: (f) => ({ listingId: f.listing().id }),
  handler: ({ listingId }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "reputation.manage");
    const l = get(store, listingId);
    if (l.publishedVersion === l.version)
      throw new ActionError("CONFLICT", "This listing is already in sync");
    const at = clock.now().toISOString();
    return store.update<Listing>("listings", l.id, {
      publishedVersion: l.version,
      publishedAt: at,
      lastSyncAt: at,
      failureReason: null,
    });
  },
});
const sync = defineAction({
  id: "M46.A10",
  description:
    "Check whether a business listing is never published, pending changes, synced or failed. Computed from current and last-published versions; no real directory is queried.",
  risk: "read",
  input: z.strictObject({ listingId: ListingId }),
  output: z.object({
    listingId: z.string(),
    name: z.string(),
    directory: z.string(),
    status: z.enum(["never_published", "pending", "synced", "failed"]),
    version: z.number(),
    publishedVersion: z.number().nullable(),
    lastSyncAt: z.string().nullable(),
    failureReason: z.string().nullable(),
  }),
  entities: { consumes: ["listing"] },
  example: (f) => ({ listingId: f.listing().id }),
  handler: ({ listingId }, { store }) => {
    const l = get(store, listingId);
    return {
      listingId: l.id,
      name: l.name,
      directory: l.directory,
      status: l.failureReason
        ? ("failed" as const)
        : l.publishedVersion === null
          ? ("never_published" as const)
          : l.publishedVersion === l.version
            ? ("synced" as const)
            : ("pending" as const),
      version: l.version,
      publishedVersion: l.publishedVersion,
      lastSyncAt: l.lastSyncAt,
      failureReason: l.failureReason,
    };
  },
});
export default {
  actions: [
    create,
    details,
    search,
    rename,
    address,
    phone,
    hours,
    categories,
    publish,
    sync,
  ],
  resolvers: {
    listing: namedResolver<Listing>({
      records: (store) => store.all<Listing>("listings"),
      name: (l) => `${l.name} ${l.directory}`, detail: (l) => l.address,
      qualifiers: { directory: (l) => l.directory },
    }),
  },
} satisfies ModuleExports;
