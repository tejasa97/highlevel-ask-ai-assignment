import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { activeUser, candidates, inDateRange, Limit, listOf, page, person, PersonArgs, personName, personRef, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { User } from "../m48-users/schema.js";
import { Appointment, APPOINTMENT_STATUSES, Attendee } from "./schema.js";

export { Appointment } from "./schema.js";

// Appointments with contacts or leads. A host can't be double-booked; times are ISO date-times.

const AppointmentId = z.string().describe("appointment id (ap_…)");
const When = z.iso.datetime({ offset: true });

function overlapping(store: Store, hostId: string, startAt: string, endAt: string, except?: string): Appointment | undefined {
  const s = Date.parse(startAt);
  const e = Date.parse(endAt);
  return store.find<Appointment>("appointments", (a) => a.id !== except && a.status === "booked" && a.hostId === hostId && Date.parse(a.startAt) < e && Date.parse(a.endAt) > s)[0];
}

/** Checks the host can take a slot: active, available and free. */
function requireHost(store: Store, hostId: string, startAt: string, endAt: string, except?: string): User {
  const u = activeUser(store, hostId, "host appointments");
  if (!u.available) throw new ActionError("CONFLICT", `${u.name} is marked unavailable and can't take appointments`);
  const clash = overlapping(store, u.id, startAt, endAt, except);
  if (clash) throw new ActionError("CONFLICT", `${u.name} already has "${clash.title}" from ${clash.startAt} to ${clash.endAt}`, { appointmentId: clash.id });
  return u;
}

function slot(startAt: string, minutes: number | undefined, endAt: string | undefined, now: Date): { startAt: string; endAt: string } {
  const s = new Date(startAt);
  if (s <= now) throw new ActionError("INVALID", `startAt ${startAt} isn't in the future (now is ${now.toISOString()})`);
  const e = endAt ? new Date(endAt) : new Date(s.getTime() + (minutes ?? 30) * 60_000);
  if (e <= s) throw new ActionError("INVALID", "endAt must be after startAt");
  return { startAt: s.toISOString(), endAt: e.toISOString() };
}

function booked(store: Store, id: string, doing: string): Appointment {
  const a = mustGet<Appointment>(store, "appointments", id, "appointment");
  requireState(`"${a.title}"`, a.status, ["booked"], doing);
  return a;
}

const Detail = Appointment.extend({ personName: z.string().nullable(), hostName: z.string() });
const detail = (store: Store, a: Appointment) => ({ ...a, personName: personName(store, a), hostName: store.get<User>("users", a.hostId)?.name ?? a.hostId });

const createAppointment = defineAction({
  id: "M21.A01",
  description: "Book an appointment with a contact or lead, hosted by a user, at a future time (30 minutes unless durationMinutes or endAt is given). Refused if the host is busy or unavailable.",
  risk: "write",
  input: z.strictObject({
    ...PersonArgs,
    hostId: z.string().describe("user id (us_…) hosting the meeting"),
    title: z.string().min(1).optional(),
    startAt: When.describe("ISO date-time"),
    durationMinutes: z.number().int().min(5).max(480).optional(),
    endAt: When.optional(),
    location: z.string().optional(),
  }),
  output: Appointment,
  siblings: ["M06.A01"],
  entities: { produces: "appointment", consumes: ["contact", "lead", "user"] },
  example: (f) => ({ contactId: "ct_31", hostId: "us_2", title: "Proposal walkthrough", startAt: f.at(5, 15) }),
  handler: (a, { store, clock }) => {
    const p = person(store, a, "have appointments booked");
    const t = slot(a.startAt, a.durationMinutes, a.endAt, clock.now());
    const host = requireHost(store, a.hostId, t.startAt, t.endAt);
    return store.insert("appointments", "ap", {
      title: a.title ?? `Meeting with ${p.name}`,
      ...personRef(p),
      hostId: host.id,
      attendees: [{ kind: p.type, id: p.id, name: p.name, noShow: false }] as Attendee[],
      ...t,
      location: a.location ?? null,
      status: "booked" as Appointment["status"],
      cancelReason: null,
      outcome: null,
      createdAt: clock.now().toISOString(),
    });
  },
});

const getAppointment = defineAction({
  id: "M21.A02",
  description: "Get one appointment: who it's with, host, attendees, time, location, status and outcome.",
  risk: "read",
  input: z.strictObject({ appointmentId: AppointmentId }),
  output: Detail,
  entities: { consumes: ["appointment"] },
  example: () => ({ appointmentId: "ap_1" }),
  handler: ({ appointmentId }, { store }) => detail(store, mustGet<Appointment>(store, "appointments", appointmentId, "appointment")),
});

const searchAppointments = defineAction({
  id: "M21.A03",
  description:
    "Find appointments by contact or lead, host, status (default booked; 'any' for all) and date range. Use it to check whether someone has a meeting booked. Soonest first.",
  risk: "read",
  input: z.strictObject({
    ...PersonArgs,
    hostId: z.string().optional(),
    status: z.enum([...APPOINTMENT_STATUSES, "any"]).optional().describe("default booked"),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: Limit,
  }),
  output: listOf(Detail),
  entities: { produces: "appointment" },
  example: () => ({ hostId: "us_2" }),
  handler: (a, { store }) => {
    const status = a.status ?? "booked";
    const items = store
      .find<Appointment>(
        "appointments",
        (x) =>
          (status === "any" || x.status === status) &&
          (!a.contactId || x.contactId === a.contactId || x.attendees.some((t) => t.id === a.contactId)) &&
          (!a.leadId || x.leadId === a.leadId || x.attendees.some((t) => t.id === a.leadId)) &&
          (!a.hostId || x.hostId === a.hostId) &&
          inDateRange(x.startAt, a.from, a.to),
      )
      .map((x) => detail(store, x));
    items.sort((x, y) => x.startAt.localeCompare(y.startAt));
    return page(items, a.limit);
  },
});

const reschedule = defineAction({
  id: "M21.A04",
  description: "Move a booked appointment to a new future time, keeping its length unless durationMinutes or endAt is given.",
  risk: "write",
  input: z.strictObject({ appointmentId: AppointmentId, startAt: When, durationMinutes: z.number().int().min(5).max(480).optional(), endAt: When.optional() }),
  output: Appointment,
  entities: { consumes: ["appointment"] },
  example: (f) => ({ appointmentId: "ap_1", startAt: f.at(9, 16) }),
  handler: (a, { store, clock }) => {
    const ap = booked(store, a.appointmentId, "be rescheduled");
    const length = (Date.parse(ap.endAt) - Date.parse(ap.startAt)) / 60_000;
    const t = slot(a.startAt, a.durationMinutes ?? length, a.endAt, clock.now());
    if (t.startAt === ap.startAt && t.endAt === ap.endAt) throw new ActionError("CONFLICT", `"${ap.title}" is already at that time`);
    requireHost(store, ap.hostId, t.startAt, t.endAt, ap.id);
    return store.update<Appointment>("appointments", ap.id, t);
  },
});

const cancel = defineAction({
  id: "M21.A05",
  description: "Cancel a booked appointment, with an optional reason.",
  risk: "destructive",
  input: z.strictObject({ appointmentId: AppointmentId, reason: z.string().optional() }),
  output: Appointment,
  entities: { consumes: ["appointment"] },
  example: (f) => ({ appointmentId: f.appointment().id, reason: "Customer asked to postpone" }),
  handler: ({ appointmentId, reason }, { store }) => {
    const ap = booked(store, appointmentId, "be cancelled");
    return store.update<Appointment>("appointments", ap.id, { status: "cancelled", cancelReason: reason ?? null });
  },
});

const assignHost = defineAction({
  id: "M21.A06",
  description: "Hand a booked appointment to a different host. Refused if they're unavailable or busy at that time.",
  risk: "write",
  input: z.strictObject({ appointmentId: AppointmentId, hostId: z.string() }),
  output: Appointment,
  siblings: ["M01.A06"],
  entities: { consumes: ["appointment", "user"] },
  example: () => ({ appointmentId: "ap_1", hostId: "us_5" }),
  handler: ({ appointmentId, hostId }, { store }) => {
    const ap = booked(store, appointmentId, "change host");
    if (ap.hostId === hostId) throw new ActionError("CONFLICT", `${hostId} is already the host`);
    requireHost(store, hostId, ap.startAt, ap.endAt, ap.id);
    return store.update<Appointment>("appointments", ap.id, { hostId });
  },
});

const addAttendee = defineAction({
  id: "M21.A07",
  description: "Invite another contact, lead or teammate (user) to a booked appointment.",
  risk: "write",
  input: z.strictObject({ appointmentId: AppointmentId, ...PersonArgs, userId: z.string().optional().describe("a teammate (us_…) instead of a contact or lead") }),
  output: Appointment,
  entities: { consumes: ["appointment", "contact", "lead", "user"] },
  example: () => ({ appointmentId: "ap_1", userId: "us_4" }),
  handler: ({ appointmentId, userId, ...a }, { store }) => {
    const ap = booked(store, appointmentId, "take attendees");
    let who: Attendee;
    if (userId) {
      if (a.contactId || a.leadId) throw new ActionError("INVALID", "Give one of contactId, leadId or userId");
      const u = activeUser(store, userId, "attend");
      who = { kind: "user", id: u.id, name: u.name, noShow: false };
    } else {
      const p = person(store, a, "attend");
      who = { kind: p.type, id: p.id, name: p.name, noShow: false };
    }
    if (who.id === ap.hostId || ap.attendees.some((t) => t.id === who.id)) throw new ActionError("CONFLICT", `${who.name} is already on "${ap.title}"`);
    return store.update<Appointment>("appointments", ap.id, { attendees: [...ap.attendees, who] });
  },
});

const removeAttendee = defineAction({
  id: "M21.A08",
  description: "Remove an invited attendee (not the main contact or lead) from a booked appointment.",
  risk: "write",
  input: z.strictObject({ appointmentId: AppointmentId, attendeeId: z.string().describe("the attendee's contact, lead or user id") }),
  output: Appointment,
  entities: { consumes: ["appointment"] },
  example: (f) => ({ appointmentId: f.appointment({ attendees: [{ kind: "contact", id: "ct_31", name: "Sarah Johnson", noShow: false }, { kind: "user", id: "us_4", name: "Tom", noShow: false }] }).id, attendeeId: "us_4" }),
  handler: ({ appointmentId, attendeeId }, { store }) => {
    const ap = booked(store, appointmentId, "change attendees");
    if (attendeeId === ap.contactId || attendeeId === ap.leadId) throw new ActionError("CONFLICT", "That's who the appointment is with; cancel it instead (M21.A05)");
    if (!ap.attendees.some((t) => t.id === attendeeId)) throw new ActionError("NOT_FOUND", `${attendeeId} isn't on "${ap.title}"`);
    return store.update<Appointment>("appointments", ap.id, { attendees: ap.attendees.filter((t) => t.id !== attendeeId) });
  },
});

const markNoShow = defineAction({
  id: "M21.A09",
  description: "Mark that the contact or lead didn't show up to an appointment that has already started.",
  risk: "write",
  input: z.strictObject({ appointmentId: AppointmentId, note: z.string().optional() }),
  output: Appointment,
  siblings: ["M21.A10"],
  entities: { consumes: ["appointment"] },
  example: (f) => ({ appointmentId: f.appointment({ startAt: f.at(-1), endAt: f.at(-1, 15) }).id }),
  handler: ({ appointmentId, note }, { store, clock }) => {
    const ap = booked(store, appointmentId, "be marked a no-show");
    if (Date.parse(ap.startAt) > clock.now().getTime()) throw new ActionError("CONFLICT", `"${ap.title}" hasn't started yet (${ap.startAt})`);
    return store.update<Appointment>("appointments", ap.id, {
      status: "no_show",
      outcome: note ?? null,
      attendees: ap.attendees.map((t) => (t.id === ap.contactId || t.id === ap.leadId ? { ...t, noShow: true } : t)),
    });
  },
});

const markCompleted = defineAction({
  id: "M21.A10",
  description: "Mark an appointment that has started as completed, with an optional outcome note.",
  risk: "write",
  input: z.strictObject({ appointmentId: AppointmentId, outcome: z.string().optional() }),
  output: Appointment,
  siblings: ["M21.A09", "M07.A01"],
  entities: { consumes: ["appointment"] },
  example: (f) => ({ appointmentId: f.appointment({ startAt: f.at(-1), endAt: f.at(-1, 15) }).id, outcome: "Agreed to a pilot" }),
  handler: ({ appointmentId, outcome }, { store, clock }) => {
    const ap = booked(store, appointmentId, "be completed");
    if (Date.parse(ap.startAt) > clock.now().getTime()) throw new ActionError("CONFLICT", `"${ap.title}" hasn't started yet (${ap.startAt})`);
    return store.update<Appointment>("appointments", ap.id, { status: "completed", outcome: outcome ?? null });
  },
});

export default {
  actions: [createAppointment, getAppointment, searchAppointments, reschedule, cancel, assignHost, addAttendee, removeAttendee, markNoShow, markCompleted],
  resolvers: {
    appointment: (store, name) =>
      // People name a meeting by who it's with ("Sarah Johnson's walkthrough"), so the person is part of its name.
      candidates(
        store.all<Appointment>("appointments"),
        name,
        (a) => [a.title, personName(store, a)].filter(Boolean).join(" with "),
        (a) => a.startAt,
        (a) => (a.status === "booked" ? undefined : a.status),
      ),
  },
} satisfies ModuleExports;
