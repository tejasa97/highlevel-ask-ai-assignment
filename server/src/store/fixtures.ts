import { Contact } from "../modules/m01-contacts/schema.js";
import { Lead } from "../modules/m03-leads/schema.js";
import { Opportunity, Pipeline } from "../modules/m04-opportunities/schema.js";
import { Task } from "../modules/m06-tasks/schema.js";
import { User } from "../modules/m48-users/schema.js";
import { Team } from "../modules/m49-teams/schema.js";
import { addDays, type Clock, localDate } from "./clock.js";
import type { Store } from "./db.js";

// Record builders with sensible defaults. Tests, the seed and eval scenarios all create data through these,
// so a test asks for exactly the records it needs ("an overdue task for an unavailable rep") and nothing
// else. Every record is checked against its module's schema, so fixtures can't drift from the handlers.

type Input<T> = Partial<Omit<T, "id">>;

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

  private now(): string {
    return this.clock.now().toISOString();
  }

  /** A per-store counter, so default names and emails never collide. */
  private seq(): number {
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

  /** Make calls to `action` fail with `code`. `match` narrows it to calls whose args contain those values. */
  fault(action: string, o: { code: string; message?: string; match?: Record<string, unknown>; times?: number }): void {
    this.store.addFault({ action, match: o.match ?? {}, code: o.code, message: o.message ?? `Simulated ${o.code.toLowerCase()} failure`, remaining: o.times ?? null });
  }

  private make<T extends { id: string }>(entity: string, prefix: string, schema: { parse(v: unknown): T }, doc: Omit<T, "id">): T {
    const full = schema.parse({ ...doc, id: this.store.nextId(entity, prefix) });
    return this.store.put(entity, full);
  }
}
