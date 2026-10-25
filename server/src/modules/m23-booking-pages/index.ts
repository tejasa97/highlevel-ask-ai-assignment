import { tableResolver } from "../../registry/lookup.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { atLeastOne, contains, Limit, listOf, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Calendar } from "../m20-calendars/schema.js";
import { BookingPage } from "./schema.js";
import "./fixtures.js";

// Public pages that book onto one calendar. Publishing requires that calendar to be public and active.

const PageId = z.string().describe("booking page id (bkp_…)");
const Field = z.strictObject({
  label: z.string().min(1),
  type: z.enum(["text", "textarea", "dropdown", "phone"]),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

function assertUrl(url: string): void {
  if (!/^https?:\/\/\S+$/.test(url)) throw new ActionError("INVALID", "redirectUrl must be an http or https URL");
}

function publicActive(cal: Calendar): void {
  if (cal.status !== "active") throw new ActionError("CONFLICT", `Calendar "${cal.name}" is ${cal.status}; choose an active public calendar`);
  if (cal.visibility !== "public") throw new ActionError("CONFLICT", `Calendar "${cal.name}" is private; make it public before publishing`);
}

function uniqueSlug(store: Store, slug: string, except?: string): void {
  const taken = store.find<BookingPage>("booking_pages", (p) => p.slug.toLowerCase() === slug.toLowerCase() && p.id !== except);
  if (taken.length) throw new ActionError("DUPLICATE", `A booking page with slug "${slug}" already exists`);
}

function normFields(fields: z.infer<typeof Field>[]): BookingPage["intakeFields"] {
  return fields.map((f) => {
    const options = f.options ?? [];
    if (f.type === "dropdown" && options.length === 0) throw new ActionError("INVALID", `Dropdown "${f.label}" needs at least one option`);
    return { label: f.label, type: f.type, required: f.required, options };
  });
}

const createPage = defineAction({
  id: "M23.A01",
  description:
    "Create a draft booking page with a unique slug. It does not book anyone yet; link a calendar (M23.A05) and publish (M23.A09) before visitors can use it.",
  risk: "write",
  input: z.strictObject({
    title: z.string().min(1),
    slug: z.string().min(1).describe("URL path segment, unique across booking pages"),
    description: z.string().nullable().optional(),
  }),
  output: BookingPage,
  entities: { produces: "booking_page" },
  example: () => ({ title: "Intro calls", slug: "intro-calls" }),
  handler: (a, { store, clock }) => {
    const slug = a.slug.trim();
    if (!slug) throw new ActionError("INVALID", "slug is empty");
    uniqueSlug(store, slug);
    const now = clock.now().toISOString();
    return store.insert("booking_pages", "bkp", {
      title: a.title,
      slug,
      description: a.description ?? null,
      calendarId: null,
      intakeFields: [],
      confirmationMessage: null,
      redirectUrl: null,
      status: "draft" as const,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    });
  },
});

const getPage = defineAction({
  id: "M23.A02",
  description: "Get one booking page: slug, linked calendar, intake questions, confirmation, redirect and whether it is published. To browse several, use M23.A03.",
  risk: "read",
  input: z.strictObject({ bookingPageId: PageId }),
  output: BookingPage,
  entities: { consumes: ["booking_page"] },
  example: (f) => ({ bookingPageId: f.bookingPage().id }),
  handler: ({ bookingPageId }, { store }) => mustGet<BookingPage>(store, "booking_pages", bookingPageId, "booking page"),
});

const listPages = defineAction({
  id: "M23.A03",
  description:
    "List booking pages, sorted by title then id. Filter by draft or published, or a word in the title or slug. Unlike M23.A02, this returns a page of matches rather than one page's settings.",
  risk: "read",
  input: z.strictObject({
    status: z.enum(["draft", "published"]).optional(),
    query: z.string().optional(),
    limit: Limit,
  }),
  output: listOf(BookingPage),
  entities: { produces: "booking_page" },
  example: () => ({}),
  handler: (a, { store }) => {
    const items = store.find<BookingPage>(
      "booking_pages",
      (p) => (!a.status || p.status === a.status) && (!a.query || contains(p.title, a.query) || contains(p.slug, a.query)),
    );
    items.sort((x, y) => x.title.localeCompare(y.title, "en") || x.id.localeCompare(y.id, "en"));
    return page(items, a.limit);
  },
});

const updateContent = defineAction({
  id: "M23.A04",
  description:
    "Change a booking page's title, description or slug. The linked calendar, intake questions, confirmation and redirect each have their own action; publishing is M23.A09.",
  risk: "write",
  input: z.strictObject({
    bookingPageId: PageId,
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    slug: z.string().min(1).optional(),
  }),
  output: BookingPage,
  entities: { consumes: ["booking_page"] },
  example: (f) => ({ bookingPageId: f.bookingPage({ title: "Intro" }).id, title: "Intro calls" }),
  handler: (a, { store, clock }) => {
    const pageRow = mustGet<BookingPage>(store, "booking_pages", a.bookingPageId, "booking page");
    atLeastOne(a, ["title", "description", "slug"]);
    const patch: Partial<BookingPage> = {};
    if (a.title !== undefined && a.title !== pageRow.title) patch.title = a.title;
    if (a.description !== undefined && a.description !== pageRow.description) patch.description = a.description;
    if (a.slug !== undefined) {
      const slug = a.slug.trim();
      if (!slug) throw new ActionError("INVALID", "slug is empty");
      if (slug !== pageRow.slug) {
        uniqueSlug(store, slug, pageRow.id);
        patch.slug = slug;
      }
    }
    if (!Object.keys(patch).length) throw new ActionError("CONFLICT", "The booking page already has that value");
    return store.update<BookingPage>("booking_pages", pageRow.id, { ...patch, updatedAt: clock.now().toISOString() });
  },
});

const linkCalendar = defineAction({
  id: "M23.A05",
  description:
    "Point a booking page at a calendar. A draft may link a private calendar; a page that is already published can only switch to another public active calendar. Publishing itself is M23.A09.",
  risk: "write",
  input: z.strictObject({
    bookingPageId: PageId,
    calendarId: z.string().describe("calendar id (cal_…)"),
  }),
  output: BookingPage,
  entities: { consumes: ["booking_page", "calendar"] },
  example: (f) => ({ bookingPageId: f.bookingPage().id, calendarId: f.calendar({ visibility: "public" }).id }),
  handler: ({ bookingPageId, calendarId }, { store, clock }) => {
    const pageRow = mustGet<BookingPage>(store, "booking_pages", bookingPageId, "booking page");
    const cal = mustGet<Calendar>(store, "calendars", calendarId, "calendar");
    if (pageRow.calendarId === cal.id) throw new ActionError("CONFLICT", "The booking page already has that calendar");
    if (pageRow.status === "published") publicActive(cal);
    return store.update<BookingPage>("booking_pages", pageRow.id, { calendarId: cal.id, updatedAt: clock.now().toISOString() });
  },
});

const setIntake = defineAction({
  id: "M23.A06",
  description:
    "Replace the extra questions a booking page asks. Name and email are always collected. This does not change the title (M23.A04) or the confirmation text (M23.A07). A dropdown needs options.",
  risk: "write",
  input: z.strictObject({ bookingPageId: PageId, fields: z.array(Field) }),
  output: BookingPage,
  entities: { consumes: ["booking_page"] },
  example: (f) => ({ bookingPageId: f.bookingPage().id, fields: [{ label: "Company", type: "text", required: false }] }),
  handler: ({ bookingPageId, fields }, { store, clock }) => {
    const pageRow = mustGet<BookingPage>(store, "booking_pages", bookingPageId, "booking page");
    const intakeFields = normFields(fields);
    if (JSON.stringify(intakeFields) === JSON.stringify(pageRow.intakeFields)) throw new ActionError("CONFLICT", "The booking page already has those intake fields");
    return store.update<BookingPage>("booking_pages", pageRow.id, { intakeFields, updatedAt: clock.now().toISOString() });
  },
});

const setConfirmation = defineAction({
  id: "M23.A07",
  description:
    "Set the message shown after someone books, or clear it with null. The redirect URL is M23.A08; this does not change intake questions.",
  risk: "write",
  input: z.strictObject({ bookingPageId: PageId, confirmationMessage: z.string().min(1).nullable() }),
  output: BookingPage,
  entities: { consumes: ["booking_page"] },
  example: (f) => ({ bookingPageId: f.bookingPage().id, confirmationMessage: "You're booked. We'll send a reminder." }),
  handler: ({ bookingPageId, confirmationMessage }, { store, clock }) => {
    const pageRow = mustGet<BookingPage>(store, "booking_pages", bookingPageId, "booking page");
    if (pageRow.confirmationMessage === confirmationMessage) throw new ActionError("CONFLICT", "The booking page already has that confirmation message");
    return store.update<BookingPage>("booking_pages", pageRow.id, { confirmationMessage, updatedAt: clock.now().toISOString() });
  },
});

const setRedirect = defineAction({
  id: "M23.A08",
  description:
    "Set an http(s) URL to send people to after they book, or clear it with null. The on-page confirmation sentence is M23.A07; this does not publish the page.",
  risk: "write",
  input: z.strictObject({ bookingPageId: PageId, redirectUrl: z.string().min(1).nullable() }),
  output: BookingPage,
  entities: { consumes: ["booking_page"] },
  example: (f) => ({ bookingPageId: f.bookingPage().id, redirectUrl: "https://example.com/thanks" }),
  handler: ({ bookingPageId, redirectUrl }, { store, clock }) => {
    const pageRow = mustGet<BookingPage>(store, "booking_pages", bookingPageId, "booking page");
    if (redirectUrl !== null) assertUrl(redirectUrl);
    if (pageRow.redirectUrl === redirectUrl) throw new ActionError("CONFLICT", "The booking page already has that redirect URL");
    return store.update<BookingPage>("booking_pages", pageRow.id, { redirectUrl, updatedAt: clock.now().toISOString() });
  },
});

const publishPage = defineAction({
  id: "M23.A09",
  destination: { id: "booking_page", label: "Booking page" },
  description:
    "Publish a draft booking page so visitors can book. The linked calendar must be public and active; a private or archived calendar is refused. M20.A09 only changes the calendar's visibility and does not publish the page.",
  risk: "external",
  input: z.strictObject({ bookingPageId: PageId }),
  output: BookingPage,
  siblings: ["M20.A09"],
  entities: { consumes: ["booking_page", "calendar"] },
  example: (f) => {
    const calendar = f.calendar({ visibility: "public", status: "active" });
    return { bookingPageId: f.bookingPage({ calendarId: calendar.id, status: "draft" }).id };
  },
  handler: ({ bookingPageId }, { store, clock }) => {
    const pageRow = mustGet<BookingPage>(store, "booking_pages", bookingPageId, "booking page");
    requireState(`Booking page "${pageRow.title}"`, pageRow.status, ["draft"], "be published");
    if (!pageRow.calendarId) throw new ActionError("CONFLICT", "Link a public, active calendar before publishing");
    publicActive(mustGet<Calendar>(store, "calendars", pageRow.calendarId, "calendar"));
    const now = clock.now().toISOString();
    return store.update<BookingPage>("booking_pages", pageRow.id, { status: "published", publishedAt: now, updatedAt: now });
  },
});

const unpublishPage = defineAction({
  id: "M23.A10",
  description:
    "Take a published booking page back to draft so visitors can no longer book on it. The calendar link is kept. Publish it again with M23.A09.",
  risk: "destructive",
  input: z.strictObject({ bookingPageId: PageId }),
  output: BookingPage,
  entities: { consumes: ["booking_page"] },
  example: (f) => ({ bookingPageId: f.bookingPage({ status: "published", publishedAt: f.now() }).id }),
  handler: ({ bookingPageId }, { store, clock }) => {
    const pageRow = mustGet<BookingPage>(store, "booking_pages", bookingPageId, "booking page");
    requireState(`Booking page "${pageRow.title}"`, pageRow.status, ["published"], "be unpublished");
    return store.update<BookingPage>("booking_pages", pageRow.id, { status: "draft", publishedAt: null, updatedAt: clock.now().toISOString() });
  },
});

export default {
  resolvers: {
    booking_page: tableResolver("booking_pages", "title", {"slug":"slug","calendarId":"calendarId"}),
  },
  actions: [createPage, getPage, listPages, updateContent, linkCalendar, setIntake, setConfirmation, setRedirect, publishPage, unpublishPage],
} satisfies ModuleExports;
