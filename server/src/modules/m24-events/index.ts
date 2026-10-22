import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { atLeastOne, contains, inDateRange, Limit, listOf, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Contact } from "../m01-contacts/schema.js";
import { Event, EventRegistration } from "./schema.js";
import "./fixtures.js";

// Group events. A full event waitlists instead of refusing; cancelling a seat does not promote anyone.

const EventId = z.string().describe("event id (ev_…)");
const RegistrationId = z.string().describe("event registration id (evr_…)");
const When = z.iso.datetime({ offset: true });

const EventView = Event.extend({
  registered: z.number().int().describe("status registered, not checked in"),
  waitlisted: z.number().int(),
  checkedIn: z.number().int(),
});

function counts(store: Store, eventId: string): { registered: number; waitlisted: number; checkedIn: number } {
  const rows = store.find<EventRegistration>("event_registrations", (r) => r.eventId === eventId);
  return {
    registered: rows.filter((r) => r.status === "registered").length,
    waitlisted: rows.filter((r) => r.status === "waitlisted").length,
    checkedIn: rows.filter((r) => r.status === "checked_in").length,
  };
}

function taken(store: Store, eventId: string): number {
  const c = counts(store, eventId);
  return c.registered + c.checkedIn;
}

function scheduled(store: Store, id: string, doing: string): Event {
  const ev = mustGet<Event>(store, "events", id, "event");
  requireState(`Event "${ev.title}"`, ev.status, ["scheduled"], doing);
  return ev;
}

function activeContact(store: Store, id: string): Contact {
  const c = mustGet<Contact>(store, "contacts", id, "contact");
  if (c.status === "merged") throw new ActionError("CONFLICT", `${c.name} was merged into ${c.mergedInto}; use that contact instead`);
  requireState(c.name, c.status, ["active"], "be registered");
  return c;
}

function openRegistration(store: Store, eventId: string, contactId: string): EventRegistration | undefined {
  return store.find<EventRegistration>(
    "event_registrations",
    (r) => r.eventId === eventId && r.contactId === contactId && r.status !== "cancelled",
  )[0];
}

function nextWait(store: Store, eventId: string): number {
  const positions = store
    .find<EventRegistration>("event_registrations", (r) => r.eventId === eventId && r.status === "waitlisted")
    .map((r) => r.waitlistPosition ?? 0);
  return Math.max(0, ...positions) + 1;
}

function renumber(store: Store, eventId: string): void {
  const waiting = store.find<EventRegistration>("event_registrations", (r) => r.eventId === eventId && r.status === "waitlisted");
  waiting.sort((a, b) => (a.waitlistPosition ?? 0) - (b.waitlistPosition ?? 0) || a.id.localeCompare(b.id, "en"));
  waiting.forEach((r, i) => {
    const pos = i + 1;
    if (r.waitlistPosition !== pos) store.update("event_registrations", r.id, { waitlistPosition: pos });
  });
}

function times(startsAt: string, endsAt: string): void {
  if (!(Date.parse(endsAt) > Date.parse(startsAt))) throw new ActionError("INVALID", "endsAt must be after startsAt");
}

const createEvent = defineAction({
  id: "M24.A01",
  description:
    "Create a scheduled group event with a start, end and seat count. M21.A01 books a one-to-one appointment; this does not reserve a host or a calendar.",
  risk: "write",
  input: z.strictObject({
    title: z.string().min(1),
    startsAt: When,
    endsAt: When,
    description: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    capacity: z.number().int().min(1).optional().describe("seats, default 10"),
  }),
  output: Event,
  siblings: ["M21.A01"],
  entities: { produces: "event" },
  example: (f) => ({ title: "Office hours", startsAt: f.at(4, 15), endsAt: f.at(4, 16), capacity: 20 }),
  handler: (a, { store, clock }) => {
    times(a.startsAt, a.endsAt);
    const now = clock.now().toISOString();
    return store.insert("events", "ev", {
      title: a.title,
      description: a.description ?? null,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      location: a.location ?? null,
      capacity: a.capacity ?? 10,
      status: "scheduled" as const,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getEvent = defineAction({
  id: "M24.A02",
  description:
    "Get one event plus how many people are registered, waitlisted and checked in. Seats taken are registered plus checked in. To browse several events, use M24.A03.",
  risk: "read",
  input: z.strictObject({ eventId: EventId }),
  output: EventView,
  entities: { consumes: ["event"] },
  example: (f) => ({ eventId: f.event().id }),
  handler: ({ eventId }, { store }) => ({ ...mustGet<Event>(store, "events", eventId, "event"), ...counts(store, eventId) }),
});

const searchEvents = defineAction({
  id: "M24.A03",
  description:
    "Find events by words in the title, description or location, by status, and by the UTC day of startsAt (inclusive). Sorted by title, then id. Unlike M24.A02, this returns a page of events and not seat counts.",
  risk: "read",
  input: z.strictObject({
    query: z.string().optional(),
    status: z.enum(["scheduled", "cancelled", "completed"]).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: Limit,
  }),
  output: listOf(Event),
  entities: { produces: "event" },
  example: () => ({}),
  handler: (a, { store }) => {
    const items = store.find<Event>(
      "events",
      (e) =>
        (!a.status || e.status === a.status) &&
        inDateRange(e.startsAt, a.from, a.to) &&
        (!a.query || contains(e.title, a.query) || contains(e.description, a.query) || contains(e.location, a.query)),
    );
    items.sort((x, y) => x.title.localeCompare(y.title, "en") || x.id.localeCompare(y.id, "en"));
    return page(items, a.limit);
  },
});

const updateEvent = defineAction({
  id: "M24.A04",
  description:
    "Change a scheduled event's title, description, location or times. Capacity is M24.A05. A cancelled or completed event cannot be edited.",
  risk: "write",
  input: z.strictObject({
    eventId: EventId,
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    startsAt: When.optional(),
    endsAt: When.optional(),
  }),
  output: Event,
  entities: { consumes: ["event"] },
  example: (f) => ({ eventId: f.event({ title: "Draft night" }).id, title: "Launch night" }),
  handler: (a, { store, clock }) => {
    const ev = scheduled(store, a.eventId, "be edited");
    atLeastOne(a, ["title", "description", "location", "startsAt", "endsAt"]);
    const startsAt = a.startsAt ?? ev.startsAt;
    const endsAt = a.endsAt ?? ev.endsAt;
    times(startsAt, endsAt);
    const patch: Partial<Event> = {};
    if (a.title !== undefined && a.title !== ev.title) patch.title = a.title;
    if (a.description !== undefined && a.description !== ev.description) patch.description = a.description;
    if (a.location !== undefined && a.location !== ev.location) patch.location = a.location;
    if (startsAt !== ev.startsAt) patch.startsAt = startsAt;
    if (endsAt !== ev.endsAt) patch.endsAt = endsAt;
    if (!Object.keys(patch).length) throw new ActionError("CONFLICT", "The event already has that value");
    return store.update<Event>("events", ev.id, { ...patch, updatedAt: clock.now().toISOString() });
  },
});

const setCapacity = defineAction({
  id: "M24.A05",
  description:
    "Set how many people can hold a seat (registered or checked in). Waitlisted people do not count. Refused when the new number is below the seats already taken. Registering someone is M24.A06.",
  risk: "write",
  input: z.strictObject({ eventId: EventId, capacity: z.number().int().min(1) }),
  output: Event,
  entities: { consumes: ["event"] },
  example: (f) => ({ eventId: f.event({ capacity: 10 }).id, capacity: 25 }),
  handler: ({ eventId, capacity }, { store, clock }) => {
    const ev = scheduled(store, eventId, "change capacity");
    if (ev.capacity === capacity) throw new ActionError("CONFLICT", "The event already has that capacity");
    const seats = taken(store, ev.id);
    if (capacity < seats) throw new ActionError("CONFLICT", `${seats} people are registered or checked in; cancel a registration or choose a capacity of at least ${seats}`);
    return store.update<Event>("events", ev.id, { capacity, updatedAt: clock.now().toISOString() });
  },
});

const registerAttendee = defineAction({
  id: "M24.A06",
  description:
    "Register an active contact for a scheduled event. When registered and checked-in people already fill the capacity, the new registration is waitlisted instead of refused. M21.A01 books an appointment, which has no waitlist.",
  risk: "write",
  input: z.strictObject({
    eventId: EventId,
    contactId: z.string().describe("contact id (ct_…)"),
  }),
  output: EventRegistration,
  siblings: ["M21.A01"],
  entities: { produces: "event", consumes: ["event", "contact"] },
  example: (f) => ({ eventId: f.event().id, contactId: f.contact().id }),
  handler: ({ eventId, contactId }, { store, clock }) => {
    const ev = scheduled(store, eventId, "take registrations");
    const contact = activeContact(store, contactId);
    const existing = openRegistration(store, ev.id, contact.id);
    if (existing) throw new ActionError("CONFLICT", `${contact.name} already has a ${existing.status.replace("_", " ")} registration`);
    const now = clock.now().toISOString();
    const full = taken(store, ev.id) >= ev.capacity;
    const status = full ? ("waitlisted" as const) : ("registered" as const);
    return store.insert("event_registrations", "evr", {
      eventId: ev.id,
      contactId: contact.id,
      status,
      waitlistPosition: full ? nextWait(store, ev.id) : null,
      registeredAt: now,
      checkedInAt: null,
      cancelledAt: null,
    });
  },
});

const cancelRegistration = defineAction({
  id: "M24.A07",
  description:
    "Cancel a registered or waitlisted attendee and, if they held a seat, free it. Nobody on the waitlist is promoted; use M24.A09 for that. Checked-in attendees cannot be cancelled.",
  risk: "destructive",
  input: z.strictObject({ registrationId: RegistrationId }),
  output: EventRegistration,
  entities: { consumes: ["event", "contact"] },
  example: (f) => ({ registrationId: f.registration().id }),
  handler: ({ registrationId }, { store, clock }) => {
    const reg = mustGet<EventRegistration>(store, "event_registrations", registrationId, "event registration");
    if (reg.status === "checked_in") throw new ActionError("CONFLICT", "They're checked in; cancel isn't available after check-in");
    if (reg.status === "cancelled") throw new ActionError("CONFLICT", "The registration is already cancelled");
    requireState("The registration", reg.status, ["registered", "waitlisted"], "be cancelled");
    const wasWaiting = reg.status === "waitlisted";
    const updated = store.update<EventRegistration>("event_registrations", reg.id, {
      status: "cancelled",
      cancelledAt: clock.now().toISOString(),
      waitlistPosition: null,
    });
    if (wasWaiting) renumber(store, reg.eventId);
    return updated;
  },
});

const addToWaitlist = defineAction({
  id: "M24.A08",
  description:
    "Put an active contact on the waitlist even when seats are still open. M24.A06 registers them when a seat is free and only waitlists once the event is full.",
  risk: "write",
  input: z.strictObject({
    eventId: EventId,
    contactId: z.string().describe("contact id (ct_…)"),
  }),
  output: EventRegistration,
  entities: { produces: "event", consumes: ["event", "contact"] },
  example: (f) => ({ eventId: f.event().id, contactId: f.contact().id }),
  handler: ({ eventId, contactId }, { store, clock }) => {
    const ev = scheduled(store, eventId, "take a waitlist entry");
    const contact = activeContact(store, contactId);
    const existing = openRegistration(store, ev.id, contact.id);
    if (existing) throw new ActionError("CONFLICT", `${contact.name} already has a ${existing.status.replace("_", " ")} registration`);
    return store.insert("event_registrations", "evr", {
      eventId: ev.id,
      contactId: contact.id,
      status: "waitlisted" as const,
      waitlistPosition: nextWait(store, ev.id),
      registeredAt: clock.now().toISOString(),
      checkedInAt: null,
      cancelledAt: null,
    });
  },
});

const promoteWaitlist = defineAction({
  id: "M24.A09",
  description:
    "Give the next waitlisted person (lowest position) a seat and renumber the rest. Refused when nobody is waiting or the event is already full. Cancelling a registration (M24.A07) does not do this.",
  risk: "write",
  input: z.strictObject({ eventId: EventId }),
  output: EventRegistration,
  entities: { consumes: ["event", "contact"] },
  example: (f) => {
    const event = f.event({ capacity: 5 });
    f.registration({ eventId: event.id, status: "waitlisted", waitlistPosition: 1 });
    return { eventId: event.id };
  },
  handler: ({ eventId }, { store }) => {
    const ev = scheduled(store, eventId, "promote a waitlisted attendee");
    if (taken(store, ev.id) >= ev.capacity) throw new ActionError("CONFLICT", "The event is full");
    const waiting = store.find<EventRegistration>("event_registrations", (r) => r.eventId === ev.id && r.status === "waitlisted");
    waiting.sort((a, b) => (a.waitlistPosition ?? 0) - (b.waitlistPosition ?? 0) || a.id.localeCompare(b.id, "en"));
    const next = waiting[0];
    if (!next) throw new ActionError("CONFLICT", "Nobody is waiting");
    const updated = store.update<EventRegistration>("event_registrations", next.id, { status: "registered", waitlistPosition: null });
    renumber(store, ev.id);
    return updated;
  },
});

const checkIn = defineAction({
  id: "M24.A10",
  description:
    "Record that a registered attendee has arrived, and set the time they were checked in. This writes attendance; it does not look anyone up. A waitlisted person must be promoted (M24.A09) first.",
  risk: "write",
  input: z.strictObject({ registrationId: RegistrationId }),
  output: EventRegistration,
  entities: { consumes: ["event", "contact"] },
  example: (f) => ({ registrationId: f.registration({ status: "registered" }).id }),
  handler: ({ registrationId }, { store, clock }) => {
    const reg = mustGet<EventRegistration>(store, "event_registrations", registrationId, "event registration");
    scheduled(store, reg.eventId, "check attendees in");
    if (reg.status === "waitlisted") throw new ActionError("CONFLICT", "Promote them first");
    if (reg.status === "checked_in") throw new ActionError("CONFLICT", "The attendee is already checked in");
    if (reg.status === "cancelled") throw new ActionError("CONFLICT", "The registration is cancelled; register them again");
    requireState("The registration", reg.status, ["registered"], "be checked in");
    return store.update<EventRegistration>("event_registrations", reg.id, { status: "checked_in", checkedInAt: clock.now().toISOString() });
  },
});

export default {
  actions: [createEvent, getEvent, searchEvents, updateEvent, setCapacity, registerAttendee, cancelRegistration, addToWaitlist, promoteWaitlist, checkIn],
} satisfies ModuleExports;
