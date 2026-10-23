import { Fixtures, type Input } from "../../store/fixtures.js";
import { Event, EventRegistration } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    event(o?: Input<Event>): Event;
    registration(o?: Input<EventRegistration>): EventRegistration;
  }
}

Fixtures.prototype.event = function (this: Fixtures, o: Input<Event> = {}): Event {
  const n = this.seq();
  const startsAt = o.startsAt ?? this.at(3);
  const endsAt = o.endsAt ?? new Date(Date.parse(startsAt) + 3_600_000).toISOString();
  return this.make("events", "ev", Event, {
    title: `Event ${n}`,
    description: null,
    startsAt,
    endsAt,
    location: null,
    capacity: 10,
    status: "scheduled",
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};

Fixtures.prototype.registration = function (this: Fixtures, o: Input<EventRegistration> = {}): EventRegistration {
  const status = o.status ?? "registered";
  return this.make("event_registrations", "evr", EventRegistration, {
    eventId: o.eventId ?? this.event().id,
    contactId: o.contactId ?? this.contact().id,
    status,
    waitlistPosition: status === "waitlisted" ? 1 : null,
    registeredAt: this.now(),
    checkedInAt: null,
    cancelledAt: null,
    ...o,
  });
};
