import "./fixtures.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { atLeastOne, contains, Limit, listOf, noChange, page } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { BlogPost } from "../m38-blogs/schema.js";
import type { LandingPage } from "../m37-landing-pages/schema.js";
import type { Lesson } from "../m41-lessons/schema.js";
import { MediaAsset } from "./schema.js";

export { MediaAsset } from "./schema.js";

// Files in a library. Deleting one is refused while a landing page, blog post or lesson still lists it in mediaIds.

const AssetId = z.string().describe("media asset id (md_…)");
const Text = z.string().trim().min(1);

const Reference = z.object({
  recordType: z.enum(["landing_page", "blog_post", "lesson"]),
  recordId: z.string(),
  label: z.string(),
});

function load(store: Store, id: string): MediaAsset {
  return mustGet<MediaAsset>(store, "media_assets", id, "media asset");
}

function cleanFolder(raw: string): string {
  const folder = raw.trim();
  if (folder === "") return "";
  if (folder.startsWith("/") || folder.endsWith("/") || folder.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new ActionError("INVALID", "Folder must be a slash path like brand/logos, or empty for the root");
  }
  return folder;
}

function nameTaken(store: Store, folder: string, name: string, exceptId?: string): boolean {
  const folderKey = folder.toLowerCase();
  const nameKey = name.trim().toLowerCase();
  return store.find<MediaAsset>(
    "media_assets",
    (a) => a.id !== exceptId && a.folder.toLowerCase() === folderKey && a.name.trim().toLowerCase() === nameKey,
  ).length > 0;
}

function requireFuture(iso: string, nowIso: string, label: string): void {
  const when = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(when)) throw new ActionError("INVALID", `${label} is not a valid timestamp`);
  if (when < now) throw new ActionError("INVALID", `${label} ${iso} is in the past (now is ${nowIso})`);
  if (when === now) throw new ActionError("INVALID", `${label} ${iso} is not in the future (now is ${nowIso})`);
}

function references(store: Store, assetId: string): { recordType: "landing_page" | "blog_post" | "lesson"; recordId: string; label: string }[] {
  const items: { recordType: "landing_page" | "blog_post" | "lesson"; recordId: string; label: string }[] = [];
  for (const page of store.find<LandingPage>("landing_pages", (p) => p.mediaIds.includes(assetId))) {
    items.push({ recordType: "landing_page", recordId: page.id, label: page.title });
  }
  for (const post of store.find<BlogPost>("blog_posts", (p) => p.mediaIds.includes(assetId))) {
    items.push({ recordType: "blog_post", recordId: post.id, label: post.title });
  }
  for (const lesson of store.find<Lesson>("lessons", (p) => p.mediaIds.includes(assetId))) {
    items.push({ recordType: "lesson", recordId: lesson.id, label: lesson.title });
  }
  items.sort((a, b) => a.recordType.localeCompare(b.recordType) || a.recordId.localeCompare(b.recordId));
  return items;
}

const upload = defineAction({
  id: "M39.A01",
  description:
    "Upload a file into the media library with a name, type, size and optional folder. The name must be unique in that folder. Replacing the file later keeps the id (M39.A07).",
  risk: "write",
  input: z.strictObject({
    name: Text,
    mimeType: Text,
    sizeBytes: z.number().int().min(0),
    folder: z.string().optional().describe("slash path such as brand/logos; empty or omitted is the root"),
    url: Text.optional().describe("storage url; one is chosen when omitted"),
  }),
  output: MediaAsset,
  entities: { produces: "media_asset" },
  example: () => ({ name: "Logo", mimeType: "image/png", sizeBytes: 2048, folder: "brand" }),
  handler: (a, { store, clock, actorId }) => {
    const folder = cleanFolder(a.folder ?? "");
    const name = a.name.trim();
    if (nameTaken(store, folder, name)) throw new ActionError("DUPLICATE", `An asset named "${name}" is already in that folder`);
    const at = clock.now().toISOString();
    const url = a.url?.trim() || `https://cdn.example/${folder ? `${folder}/` : ""}${encodeURIComponent(name)}`;
    return store.insert("media_assets", "md", {
      name,
      mimeType: a.mimeType.trim(),
      sizeBytes: a.sizeBytes,
      folder,
      altText: null,
      url,
      version: 1,
      accessLinks: [],
      uploadedBy: actorId ?? "us_1",
      createdAt: at,
      updatedAt: at,
    });
  },
});

const getAsset = defineAction({
  id: "M39.A02",
  description:
    "Get one asset's metadata: type, size, folder, alt text, version and access links. To find assets by name or folder, use M39.A03 Search media assets.",
  risk: "read",
  input: z.strictObject({ assetId: AssetId }),
  output: MediaAsset,
  entities: { consumes: ["media_asset"] },
  example: (f) => ({ assetId: f.mediaAsset().id }),
  handler: ({ assetId }, { store }) => load(store, assetId),
});

const searchAssets = defineAction({
  id: "M39.A03",
  description:
    "Search media assets by name, folder or mime type, sorted by name then id. Folder matches exactly, and an empty folder is the root. Where an asset is used is M39.A08, not this.",
  risk: "read",
  input: z.strictObject({
    query: z.string().optional().describe("words in the name"),
    folder: z.string().optional().describe("exact folder; empty string is the root"),
    mimeType: z.string().optional(),
    limit: Limit,
  }),
  output: listOf(MediaAsset),
  entities: { produces: "media_asset" },
  example: () => ({}),
  handler: (a, { store }) => {
    const query = a.query?.trim();
    const folder = a.folder === undefined ? undefined : cleanFolder(a.folder);
    const mime = a.mimeType?.trim().toLowerCase();
    const items = store.find<MediaAsset>(
      "media_assets",
      (asset) =>
        (folder === undefined || asset.folder.toLowerCase() === folder.toLowerCase()) &&
        (!mime || asset.mimeType.toLowerCase() === mime) &&
        (!query || contains(asset.name, query)),
    );
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const rename = defineAction({
  id: "M39.A04",
  description:
    "Rename a media asset. The new name must be unique in its current folder. This does not move the file (M39.A06) or replace its bytes (M39.A07).",
  risk: "write",
  input: z.strictObject({ assetId: AssetId, name: Text }),
  output: MediaAsset,
  entities: { consumes: ["media_asset"] },
  example: (f) => ({ assetId: f.mediaAsset().id, name: "Logo mark" }),
  handler: ({ assetId, name }, { store, clock }) => {
    const asset = load(store, assetId);
    const next = name.trim();
    if (next === asset.name) noChange();
    if (nameTaken(store, asset.folder, next, asset.id)) throw new ActionError("DUPLICATE", `An asset named "${next}" is already in that folder`);
    return store.update<MediaAsset>("media_assets", asset.id, { name: next, updatedAt: clock.now().toISOString() });
  },
});

const setAlt = defineAction({
  id: "M39.A05",
  description:
    "Set or clear an asset's alt text. Pass null or a blank string to clear it. This does not rename the file; renaming is M39.A04.",
  risk: "write",
  input: z.strictObject({ assetId: AssetId, altText: z.string().trim().nullable() }),
  output: MediaAsset,
  entities: { consumes: ["media_asset"] },
  example: (f) => ({ assetId: f.mediaAsset().id, altText: "Company logo" }),
  handler: ({ assetId, altText }, { store, clock }) => {
    const asset = load(store, assetId);
    const next = altText === null ? null : blankOrNull(altText);
    if (next === asset.altText) noChange();
    return store.update<MediaAsset>("media_assets", asset.id, { altText: next, updatedAt: clock.now().toISOString() });
  },
});

function blankOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const move = defineAction({
  id: "M39.A06",
  description:
    "Move an asset into another folder. An empty string is the root, and the path looks like brand/logos. The name must be free in the destination. Renaming is M39.A04, not this.",
  risk: "write",
  input: z.strictObject({ assetId: AssetId, folder: z.string() }),
  output: MediaAsset,
  entities: { consumes: ["media_asset"] },
  example: (f) => ({ assetId: f.mediaAsset().id, folder: "brand/logos" }),
  handler: ({ assetId, folder }, { store, clock }) => {
    const asset = load(store, assetId);
    const next = cleanFolder(folder);
    if (next.toLowerCase() === asset.folder.toLowerCase()) noChange();
    if (nameTaken(store, next, asset.name, asset.id)) throw new ActionError("DUPLICATE", `An asset named "${asset.name}" is already in that folder`);
    return store.update<MediaAsset>("media_assets", asset.id, { folder: next, updatedAt: clock.now().toISOString() });
  },
});

const replaceFile = defineAction({
  id: "M39.A07",
  description:
    "Replace an asset's file (url, mime type and/or size) and bump its version. The id stays the same, so pages that reference it keep working. This does not delete the asset (M39.A10).",
  risk: "write",
  input: z.strictObject({
    assetId: AssetId,
    url: Text.optional(),
    mimeType: Text.optional(),
    sizeBytes: z.number().int().min(0).optional(),
  }),
  output: MediaAsset,
  entities: { consumes: ["media_asset"] },
  example: (f) => ({ assetId: f.mediaAsset().id, url: "https://cdn.example/logo-v2.png" }),
  handler: (a, { store, clock }) => {
    atLeastOne(a, ["url", "mimeType", "sizeBytes"]);
    const asset = load(store, a.assetId);
    const url = a.url === undefined ? asset.url : a.url.trim();
    const mimeType = a.mimeType === undefined ? asset.mimeType : a.mimeType.trim();
    const sizeBytes = a.sizeBytes === undefined ? asset.sizeBytes : a.sizeBytes;
    if (url === asset.url && mimeType === asset.mimeType && sizeBytes === asset.sizeBytes) noChange();
    return store.update<MediaAsset>("media_assets", asset.id, {
      url,
      mimeType,
      sizeBytes,
      version: asset.version + 1,
      updatedAt: clock.now().toISOString(),
    });
  },
});

const listReferences = defineAction({
  id: "M39.A08",
  description:
    "List landing pages, blog posts and lessons whose mediaIds include this asset, sorted by record type then id. This does not delete the asset; M39.A10 refuses while any of these references remain.",
  risk: "read",
  input: z.strictObject({ assetId: AssetId, limit: Limit }),
  output: listOf(Reference),
  entities: { consumes: ["media_asset"] },
  example: (f) => ({ assetId: f.mediaAsset().id }),
  handler: ({ assetId, limit }, { store }) => {
    load(store, assetId);
    return page(references(store, assetId), limit);
  },
});

const accessLink = defineAction({
  id: "M39.A09",
  description:
    "Store a time-limited access link on the asset and return the asset. The link is not emailed or otherwise sent. expiresAt must be in the future. Deleting the asset is M39.A10.",
  risk: "write",
  input: z.strictObject({ assetId: AssetId, expiresAt: z.iso.datetime() }),
  output: MediaAsset,
  entities: { consumes: ["media_asset"] },
  example: (f) => ({ assetId: f.mediaAsset().id, expiresAt: "2027-01-01T00:00:00.000Z" }),
  handler: ({ assetId, expiresAt }, { store, clock }) => {
    const asset = load(store, assetId);
    const now = clock.now().toISOString();
    requireFuture(expiresAt, now, "expiresAt");
    const token = store.nextId("_nested", "ak");
    const join = asset.url.includes("?") ? "&" : "?";
    const url = `${asset.url}${join}access=${token}`;
    return store.update<MediaAsset>("media_assets", asset.id, {
      accessLinks: [...asset.accessLinks, { url, expiresAt }],
      updatedAt: now,
    });
  },
});

const deleteAsset = defineAction({
  id: "M39.A10",
  description:
    "Delete an asset that no landing page, blog post or lesson references in mediaIds. If any still do, the error says how many records and to remove it first. Creating those pages and posts is M37.A01 and M38.A01.",
  risk: "destructive",
  input: z.strictObject({ assetId: AssetId }),
  output: MediaAsset,
  siblings: ["M37.A01", "M38.A01"],
  entities: { consumes: ["media_asset"] },
  example: (f) => ({ assetId: f.mediaAsset().id }),
  handler: ({ assetId }, { store }) => {
    const asset = load(store, assetId);
    const used = references(store, asset.id);
    if (used.length > 0) {
      const noun = used.length === 1 ? "record" : "records";
      throw new ActionError("CONFLICT", `This asset is used by ${used.length} ${noun}. Remove it from ${used.length} ${noun} first`);
    }
    store.delete("media_assets", asset.id);
    return asset;
  },
});

export default {
  actions: [upload, getAsset, searchAssets, rename, setAlt, move, replaceFile, listReferences, accessLink, deleteAsset],
} satisfies ModuleExports;
