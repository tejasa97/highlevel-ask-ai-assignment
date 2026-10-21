import { LEAD_SOURCES } from "../modules/m03-leads/schema.js";
import type { Clock } from "./clock.js";
import type { Store } from "./db.js";
import { Fixtures } from "./fixtures.js";

// The base data set: a small but believable account. Deterministic: same seed + same clock = same rows
// and ids, every run. Dates are relative to the clock, so "last week" always has data in it.
// Tests and scenarios add what they need on top with Fixtures; nothing here is load-bearing for one test.

export function rng(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Ana", "Ben", "Chloe", "Dev", "Elena", "Femi", "Grace", "Hiro", "Isla", "Jo", "Kofi", "Lena", "Marco", "Nina", "Omar", "Priya", "Quinn", "Rosa", "Sam", "Tara", "Uma", "Victor", "Wen", "Yusuf", "Zoe"];
const LAST = ["Ruiz", "Okafor", "Nguyen", "Patel", "Schmidt", "Kim", "Silva", "Haddad", "Novak", "Ito", "Brown", "Costa", "Mensah", "Larsen", "Reyes"];
const COMPANIES = ["Acme", "Globex", "Initech", "Umbrella", "Hooli", "Stark", "Wayne", "Wonka", "Tyrell", "Soylent"];

export interface SeedOptions {
  seed?: number;
  contacts?: number;
  leads?: number;
}

export function seed(store: Store, clock: Clock, opts: SeedOptions = {}): void {
  const r = rng(opts.seed ?? 42);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const f = new Fixtures(store, clock);
  const at = (daysAgo: number) => f.at(-daysAgo, 9 + Math.floor(r() * 8));
  const person = () => {
    const firstName = pick(FIRST);
    const lastName = pick(LAST);
    const company = pick(COMPANIES);
    return { firstName, lastName, name: `${firstName} ${lastName}`, company, email: `${firstName}.${lastName}@${company}.example`.toLowerCase() };
  };
  const phone = () => `+1555${String(1000000 + Math.floor(r() * 8999999))}`;

  store.tx(() => {
    // Staff. Fixed, not random, so scenarios can name people. us_1 is the admin everyone acts as by default.
    const u = (name: string, roles: ("admin" | "manager" | "sales" | "support" | "marketing" | "billing")[], extra: Parameters<Fixtures["user"]>[0] = {}) =>
      f.user({ name, roles, createdAt: at(400), ...extra });
    const maya = u("Maya Chen", ["admin"], { title: "Head of Operations" });
    const raj = u("Raj Iyer", ["sales", "manager"], { title: "Sales Lead" });
    const lucia = u("Lucia Gomez", ["sales"], { available: false, title: "Account Executive" }); // on leave
    const tom = u("Tom Becker", ["sales"], { title: "Account Executive" });
    const aisha = u("Aisha Bello", ["sales"], { title: "Account Executive" });
    const noah = u("Noah Park", ["support"], { title: "Support Specialist" });
    const eva = u("Eva Rossi", ["support"], { available: false, title: "Support Specialist" });
    const liam = u("Liam Walsh", ["marketing"], { title: "Marketing Manager" });
    const dan = u("Dan Ortiz", ["sales"], { status: "deactivated", available: false, deactivatedAt: at(20) }); // left the company
    u("Priya Shah", ["billing"], { status: "invited", createdAt: at(2) });

    const sales = [raj, lucia, tom, aisha, dan].map((x) => x.id);
    const activeSales = [raj, tom, aisha].map((x) => x.id);
    f.team({ name: "Sales", description: "Inbound and outbound sales", memberIds: sales, managerId: raj.id, strategy: "round_robin", createdAt: at(300) });
    f.team({ name: "Support", description: "Customer support", memberIds: [noah.id, eva.id], managerId: maya.id, strategy: "least_busy", createdAt: at(300) });
    f.team({ name: "Marketing", memberIds: [liam.id], managerId: liam.id, strategy: "manual", createdAt: at(300) });

    const pipeline = f.pipeline({ name: "Sales Pipeline", createdAt: at(300) });

    // Contacts: existing customers and people we deal with.
    const contacts = [];
    for (let i = 0; i < (opts.contacts ?? 30); i++) {
      const p = person();
      const created = at(Math.floor(r() * 120) + 1);
      contacts.push(
        f.contact({
          ...p,
          phone: phone(),
          ownerId: pick(activeSales),
          tags: r() < 0.3 ? ["vip"] : [],
          preferences: { email: r() > 0.1, sms: r() > 0.25, call: true, dnd: false },
          createdAt: created,
          updatedAt: created,
        }),
      );
    }
    // Named contacts the brief and scenarios lean on: a likely duplicate pair, a do-not-disturb, an archived one.
    f.contact({ name: "Sarah Johnson", email: "sarah.johnson@brightside.example", phone: "+15550100001", company: "Brightside", ownerId: raj.id, createdAt: at(60), updatedAt: at(60) });
    f.contact({ name: "Sarah Johnson", email: "sjohnson@gmail.example", phone: "+15550100001", company: null, ownerId: tom.id, createdAt: at(10), updatedAt: at(10) });
    f.contact({ name: "Marcus Lee", email: "marcus@leeandco.example", company: "Lee & Co", ownerId: aisha.id, preferences: { email: true, sms: true, call: true, dnd: true }, createdAt: at(90), updatedAt: at(90) });
    f.contact({ name: "Old Customer", email: "old@defunct.example", status: "archived", createdAt: at(300), updatedAt: at(100) });

    // Leads: prospects spread over the last 30 days, so every relative range has some.
    for (let i = 0; i < (opts.leads ?? 40); i++) {
      const p = person();
      const created = at(Math.floor(r() * 30));
      const status = pick(["new", "new", "contacted", "qualified"] as const);
      f.lead({
        ...p,
        email: p.email.replace(".example", "-lead.example"),
        source: pick(LEAD_SOURCES.filter((s) => s !== "manual")),
        status,
        score: Math.floor(r() * 100),
        ownerId: r() < 0.4 ? pick(activeSales) : null,
        qualification:
          status === "qualified"
            ? { budget: pick(["$5k", "$10-20k", "$50k+"]), authority: "decision maker", need: pick(["more leads", "automation", "reporting"]), timeline: pick(["this month", "this quarter"]) }
            : { budget: null, authority: null, need: null, timeline: null },
        createdAt: created,
        updatedAt: created,
      });
    }
    // Last week's Facebook leads, unassigned: the brief's workflow examples run on these.
    [2, 3, 5, 6, 8].forEach((daysAgo, i) => {
      const p = person();
      f.lead({ ...p, email: p.email.replace(".example", "-fb.example"), source: "facebook_ads", status: "new", score: 40 + i * 10, createdAt: at(daysAgo + 3), updatedAt: at(daysAgo + 3) });
    });

    // Open deals on some contacts.
    for (const c of contacts.slice(0, 8)) {
      f.opportunity({
        name: `${c.company} - ${pick(["Starter plan", "Pro plan", "Agency plan"])}`,
        contactId: c.id,
        pipelineId: pipeline.id,
        stageId: pick(pipeline.stages).id,
        value: pick([1200, 4800, 9600, 24000]),
        ownerId: c.ownerId,
        expectedCloseDate: f.day(Math.floor(r() * 45) + 5),
        createdAt: at(Math.floor(r() * 40) + 5),
      });
    }

    // Tasks: open ones (some overdue) so workload isn't all zeros, plus some history.
    for (let i = 0; i < 12; i++) {
      const c = pick(contacts);
      f.task({
        title: `${pick(["Call back", "Send proposal to", "Check in with", "Prepare demo for"])} ${c.name}`,
        assigneeId: pick(activeSales),
        dueDate: f.day(Math.floor(r() * 10) - 3),
        priority: pick(["low", "normal", "normal", "high"] as const),
        relatedTo: { type: "contact", id: c.id },
        createdBy: maya.id,
        createdAt: at(Math.floor(r() * 14) + 1),
      });
    }
    for (let i = 0; i < 6; i++) {
      f.task({ title: `Onboarding call ${i + 1}`, assigneeId: pick(activeSales), dueDate: f.day(-10 - i), status: "completed", completedAt: at(10 + i), createdAt: at(20 + i) });
    }
    f.task({ title: "Follow up on old quote", assigneeId: lucia.id, dueDate: f.day(-4), priority: "high", createdAt: at(12) }); // stuck with someone on leave
  });
}
