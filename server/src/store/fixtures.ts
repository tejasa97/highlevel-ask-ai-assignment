import { Contact } from "../modules/m01-contacts/schema.js";
import { Lead } from "../modules/m03-leads/schema.js";
import { Opportunity, Pipeline } from "../modules/m04-opportunities/schema.js";
import { Task } from "../modules/m06-tasks/schema.js";
import { Note } from "../modules/m07-notes/schema.js";
import { Tag } from "../modules/m08-tags/schema.js";
import { Conversation } from "../modules/m11-conversations/schema.js";
import { Sms } from "../modules/m12-sms/schema.js";
import { Email } from "../modules/m13-email/schema.js";
import { Campaign } from "../modules/m15-campaigns/schema.js";
import { Appointment } from "../modules/m21-appointments/schema.js";
import { Invoice } from "../modules/m28-invoices/schema.js";
import { Payment, PaymentRequest } from "../modules/m29-payments/schema.js";
import { User } from "../modules/m48-users/schema.js";
import { Team } from "../modules/m49-teams/schema.js";
import { Review, ReviewRequest } from "../modules/m45-reviews/schema.js";
import { defaultHours, Listing } from "../modules/m46-business-listings/schema.js";
import { Ticket } from "../modules/m47-support-tickets/schema.js";
import { addDays, type Clock, localDate } from "./clock.js";
import type { Store } from "./db.js";

// Record builders with sensible defaults. Tests, the seed and eval scenarios all create data through these,
// so a test asks for exactly the records it needs ("an overdue task for an unavailable rep") and nothing
// else. Every record is checked against its module's schema, so fixtures can't drift from the handlers.

export type Input<T> = Partial<Omit<T, "id">>;

export class Fixtures {
  constructor(
    readonly store: Store,
    readonly clock: Clock,
  ) {}

  get today(): string {
    return localDate(this.clock.now());
  }

  /** YYYY-MM-DD, `days` from today (negative = past). */
  day(days: number): string {
    return addDays(this.today, days);
  }

  /** ISO timestamp `days` from now, at the given UTC hour. */
  at(days: number, hour = 14): string {
    return `${this.day(days)}T${String(hour).padStart(2, "0")}:00:00.000Z`;
  }

  /** The clock's current time as an ISO timestamp. */
  now(): string {
    return this.clock.now().toISOString();
  }

  /** A per-store counter, so default names and emails never collide. */
  seq(): number {
    return Number(this.store.nextId("_fixture", "fx").slice(3));
  }

  user(o: Input<User> = {}): User {
    const n = this.seq();
    const firstName = o.firstName ?? o.name?.split(" ")[0] ?? `User${n}`;
    const lastName = o.lastName !== undefined ? o.lastName : (o.name?.split(" ").slice(1).join(" ") || "Test");
    return this.make("users", "us", User, {
      firstName,
      lastName,
      name: [firstName, lastName].filter(Boolean).join(" "),
      email: `${firstName}.${lastName ?? n}@ourco.example`.toLowerCase(),
      phone: null,
      title: null,
      roles: ["sales"],
      status: "active",
      available: true,
      createdAt: this.now(),
      deactivatedAt: null,
      ...o,
    });
  }

  team(o: Input<Team> = {}): Team {
    return this.make("teams", "tm", Team, {
      name: `Team ${this.seq()}`,
      description: null,
      memberIds: [],
      managerId: null,
      strategy: "round_robin",
      status: "active",
      createdAt: this.now(),
      ...o,
    });
  }

  contact(o: Input<Contact> = {}): Contact {
    const n = this.seq();
    const firstName = o.firstName ?? o.name?.split(" ")[0] ?? `Contact${n}`;
    const lastName = o.lastName !== undefined ? o.lastName : (o.name?.split(" ").slice(1).join(" ") || "Test");
    return this.make("contacts", "ct", Contact, {
      firstName,
      lastName,
      name: [firstName, lastName].filter(Boolean).join(" "),
      email: `${firstName}.${lastName ?? ""}${n}@example.com`.toLowerCase(),
      phone: null,
      company: null,
      companyId: null,
      ownerId: null,
      tags: [],
      preferences: { email: true, sms: true, call: true, dnd: false },
      relationships: [],
      status: "active",
      mergedInto: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      ...o,
    });
  }

  lead(o: Input<Lead> = {}): Lead {
    const n = this.seq();
    const firstName = o.firstName ?? o.name?.split(" ")[0] ?? `Lead${n}`;
    const lastName = o.lastName !== undefined ? o.lastName : (o.name?.split(" ").slice(1).join(" ") || "Test");
    return this.make("leads", "ld", Lead, {
      firstName,
      lastName,
      name: [firstName, lastName].filter(Boolean).join(" "),
      email: `${firstName}.${lastName ?? ""}${n}@prospect.example`.toLowerCase(),
      phone: null,
      company: null,
      source: "website",
      campaignId: null,
      status: "new",
      score: 50,
      ownerId: null,
      tags: [],
      qualification: { budget: null, authority: null, need: null, timeline: null },
      disqualifyReason: null,
      disqualifyNote: null,
      convertedTo: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      ...o,
    });
  }

  pipeline(o: Input<Pipeline> = {}): Pipeline {
    const n = this.seq();
    const stages = ["New", "Qualified", "Proposal", "Negotiation"].map((name, i) => ({ id: `st_${n}_${i + 1}`, name, probability: [10, 25, 50, 75][i]! }));
    return this.make("pipelines", "pl", Pipeline, { name: `Pipeline ${n}`, stages, status: "active", createdAt: this.now(), ...o });
  }

  /** Uses the first active pipeline (creating one if needed) and a new contact unless given. */
  opportunity(o: Input<Opportunity> = {}): Opportunity {
    const pipeline =
      (o.pipelineId ? this.store.get<Pipeline>("pipelines", o.pipelineId) : this.store.find<Pipeline>("pipelines", (p) => p.status === "active")[0]) ??
      this.pipeline();
    const contactId = o.contactId ?? this.contact().id;
    return this.make("opportunities", "op", Opportunity, {
      name: `Deal ${this.seq()}`,
      contactId,
      leadId: null,
      pipelineId: pipeline.id,
      stageId: pipeline.stages[0]!.id,
      value: 1000,
      currency: "USD",
      ownerId: null,
      status: "open",
      expectedCloseDate: null,
      lostReason: null,
      createdAt: this.now(),
      closedAt: null,
      ...o,
    });
  }

  task(o: Input<Task> = {}): Task {
    return this.make("tasks", "tk", Task, {
      title: `Task ${this.seq()}`,
      description: null,
      assigneeId: null,
      dueDate: null,
      priority: "normal",
      status: "open",
      relatedTo: null,
      createdBy: "us_1",
      createdAt: this.now(),
      completedAt: null,
      cancelReason: null,
      ...o,
    });
  }

  /** A note on a new contact unless attachedTo is given. */
  note(o: Input<Note> = {}): Note {
    return this.make("notes", "nt", Note, {
      body: `Note ${this.seq()}`,
      attachedTo: o.attachedTo ?? [{ type: "contact", id: this.contact().id }],
      pinned: false,
      authorId: "us_1",
      revisions: [],
      createdAt: this.now(),
      updatedAt: this.now(),
      ...o,
    });
  }

  tag(o: Input<Tag> = {}): Tag {
    return this.make("tags", "tg", Tag, { name: `tag-${this.seq()}`, color: "gray", description: null, createdAt: this.now(), ...o });
  }

  /** An open conversation with a new contact where we wrote last. */
  conversation(o: Input<Conversation> = {}): Conversation {
    const contactId = o.contactId !== undefined ? o.contactId : o.leadId ? null : this.contact().id;
    return this.make("conversations", "cv", Conversation, {
      contactId,
      leadId: null,
      channels: ["email"],
      status: "open",
      ownerId: null,
      unread: false,
      lastMessageAt: this.at(-1),
      lastDirection: "outbound",
      lastMessagePreview: "Hi there",
      lastInboundAt: null,
      lastOutboundAt: this.at(-1),
      comments: [],
      createdAt: this.at(-1),
      closedAt: null,
      ...o,
    });
  }

  /** A delivered outbound text to a new contact. */
  sms(o: Input<Sms> = {}): Sms {
    const to = o.to ?? `+1555${String(1000000 + this.seq()).slice(-7)}`;
    const contactId = o.contactId !== undefined ? o.contactId : o.leadId ? null : this.contact({ phone: to }).id;
    return this.make("sms", "sm", Sms, {
      conversationId: null,
      contactId,
      leadId: null,
      to,
      from: "+15550009999",
      body: "Hi! Just checking in.",
      campaignId: null,
      direction: "outbound",
      status: "delivered",
      segments: 1,
      encoding: "GSM-7",
      scheduledAt: null,
      sentAt: this.at(-1),
      deliveredAt: this.at(-1),
      failureReason: null,
      createdBy: "us_1",
      createdAt: this.at(-1),
      ...o,
    });
  }

  /** A delivered outbound email to a new contact. */
  email(o: Input<Email> = {}): Email {
    const c = o.contactId || o.leadId ? undefined : this.contact();
    return this.make("emails", "em", Email, {
      conversationId: null,
      contactId: c?.id ?? null,
      leadId: null,
      to: c?.email ?? "someone@example.com",
      from: "hello@ourco.example",
      subject: "Hello",
      body: "Just checking in.",
      kind: "general",
      invoiceId: null,
      campaignId: null,
      direction: "outbound",
      status: "delivered",
      scheduledAt: null,
      sentAt: this.at(-1),
      deliveredAt: this.at(-1),
      failureReason: null,
      createdBy: "us_1",
      createdAt: this.at(-1),
      ...o,
    });
  }

  campaign(o: Input<Campaign> = {}): Campaign {
    return this.make("campaigns", "cp", Campaign, {
      name: `Campaign ${this.seq()}`,
      channel: "email",
      status: "draft",
      audience: { tag: null, contactIds: [] },
      steps: [],
      startAt: null,
      launchedAt: null,
      pausedAt: null,
      ownerId: null,
      createdAt: this.now(),
      ...o,
    });
  }

  /** A booked 30-minute meeting in three days with a new contact, hosted by a new user. */
  appointment(o: Input<Appointment> = {}): Appointment {
    const contact = o.contactId || o.leadId ? undefined : this.contact();
    const startAt = o.startAt ?? this.at(3);
    return this.make("appointments", "ap", Appointment, {
      title: `Meeting ${this.seq()}`,
      contactId: contact?.id ?? null,
      leadId: null,
      hostId: o.hostId ?? this.user().id,
      calendarId: null,
      attendees: contact ? [{ kind: "contact", id: contact.id, name: contact.name, noShow: false }] : [],
      startAt,
      endAt: new Date(Date.parse(startAt) + 30 * 60_000).toISOString(),
      location: null,
      status: "booked",
      cancelReason: null,
      outcome: null,
      createdAt: this.now(),
      ...o,
    });
  }

  /** A $500 draft invoice for a new contact. */
  invoice(o: Input<Invoice> = {}): Invoice {
    const n = this.store.all("invoices").length;
    const lineItems = o.lineItems ?? [{ description: "Services", quantity: 1, unitPrice: 500, amount: 500 }];
    const total = lineItems.reduce((t, i) => t + i.amount, 0);
    return this.make("invoices", "inv", Invoice, {
      number: `INV-${1001 + n}`,
      contactId: o.contactId ?? this.contact().id,
      status: "draft",
      lineItems,
      total,
      amountPaid: 0,
      amountDue: total,
      currency: "USD",
      issueDate: null,
      dueDate: null,
      paidAt: null,
      voidedAt: null,
      voidReason: null,
      reminders: [],
      lastReminderAt: null,
      memo: null,
      createdAt: this.now(),
      ...o,
    });
  }

  paymentRequest(o: Input<PaymentRequest> = {}): PaymentRequest {
    const id = this.store.nextId("payment_requests", "prq");
    const full = PaymentRequest.parse({
      id,
      contactId: o.contactId ?? this.contact().id,
      invoiceId: null,
      amount: 250,
      description: "Payment",
      status: "pending",
      link: `https://pay.ourco.example/r/${id}`,
      paymentId: null,
      createdBy: "us_1",
      createdAt: this.now(),
      paidAt: null,
      cancelledAt: null,
      ...o,
    });
    return this.store.put("payment_requests", full);
  }

  /** A succeeded $250 card payment from a new contact, not yet applied to an invoice. */
  payment(o: Input<Payment> = {}): Payment {
    const amount = o.amount ?? 250;
    return this.make("payments", "pay", Payment, {
      contactId: o.contactId ?? this.contact().id,
      amount,
      currency: "USD",
      method: "card",
      status: "succeeded",
      failure: null,
      paymentRequestId: null,
      allocations: [],
      unallocated: amount,
      recordedBy: "us_1",
      createdAt: this.at(-1),
      ...o,
    });
  }

  reviewRequest(o: Input<ReviewRequest> = {}): ReviewRequest {
    return this.make("review_requests", "rrq", ReviewRequest, { contactId: o.contactId ?? this.contact().id, status: "draft", subject: "Your feedback", body: "How did we do?", emailId: null, createdAt: this.now(), sentAt: null, cancelledAt: null, fulfilledAt: null, reviewId: null, ...o });
  }

  review(o: Input<Review> = {}): Review {
    return this.make("reviews", "rv", Review, { contactId: o.contactId ?? this.contact().id, requestId: null, rating: 5, body: "Excellent service", responseDraft: null, publishedResponse: null, publishedAt: null, createdAt: this.now(), ...o });
  }

  listing(o: Input<Listing> = {}): Listing {
    return this.make("listings", "bl", Listing, { name: `Listing ${this.seq()}`, directory: "google", address: "1 Test Road", phone: "+15550123456", categories: ["business"], hours: defaultHours(), timezone: "America/New_York", version: 1, publishedVersion: null, publishedAt: null, lastSyncAt: null, failureReason: null, createdAt: this.now(), updatedAt: this.now(), ...o });
  }

  ticket(o: Input<Ticket> = {}): Ticket {
    const c = o.contactId ? this.store.get<Contact>("contacts", o.contactId) : o.contactId === null || o.requesterEmail ? undefined : this.contact();
    return this.make("tickets", "tic", Ticket, { title: `Support issue ${this.seq()}`, body: "Please investigate", contactId: c?.id ?? null, requesterEmail: c?.email ?? null, ownerId: null, priority: "normal", status: "open", notes: [], replies: [], createdAt: this.now(), updatedAt: this.now(), resolvedAt: null, closedAt: null, firstResponseAt: null, firstResponseDueAt: null, history: [], ...o });
  }

  /** Make calls to `action` fail with `code`. `match` narrows it to calls whose args contain those values. */
  fault(action: string, o: { code: string; message?: string; match?: Record<string, unknown>; times?: number }): void {
    this.store.addFault({ action, match: o.match ?? {}, code: o.code, message: o.message ?? `Simulated ${o.code.toLowerCase()} failure`, remaining: o.times ?? null });
  }

  /** Validates `doc` against `schema` and inserts it. A module's own fixtures.ts builds on this. */
  make<T extends { id: string }>(entity: string, prefix: string, schema: { parse(v: unknown): T }, doc: Omit<T, "id">): T {
    const full = schema.parse({ ...doc, id: this.store.nextId(entity, prefix) });
    return this.store.put(entity, full);
  }
}
