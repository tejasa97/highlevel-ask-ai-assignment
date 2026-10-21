import { addDays, type Clock, localDate } from "./clock.js";
import type { Store } from "./db.js";

// Deterministic synthetic data. Same seed + same clock = same rows and ids, every run.
// Dates are relative to the clock, so "last week" always has data in it.

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
export const LEAD_SOURCES = ["facebook_ads", "google_ads", "website", "referral"] as const;
export const LEAD_STATUSES = ["new", "contacted", "qualified", "disqualified", "converted"] as const;

export interface SeedOptions {
  seed?: number;
  contacts?: number;
  leads?: number;
}

export function seed(store: Store, clock: Clock, opts: SeedOptions = {}): void {
  const r = rng(opts.seed ?? 42);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const today = localDate(clock.now());
  const at = (daysAgo: number) => `${addDays(today, -daysAgo)}T${String(9 + Math.floor(r() * 8)).padStart(2, "0")}:00:00.000Z`;
  const person = () => {
    const firstName = pick(FIRST);
    const lastName = pick(LAST);
    const domain = `${pick(COMPANIES).toLowerCase()}.example`;
    return { firstName, lastName, name: `${firstName} ${lastName}`, email: `${firstName}.${lastName}@${domain}`.toLowerCase() };
  };

  store.tx(() => {
    // Users and teams. Availability is fixed, not random, so workflow scenarios are easy to reason about.
    const staff = [
      { name: "Maya Chen", role: "admin", available: true },
      { name: "Raj Iyer", role: "sales", available: true },
      { name: "Lucia Gomez", role: "sales", available: false }, // on leave
      { name: "Tom Becker", role: "sales", available: true },
      { name: "Aisha Bello", role: "sales", available: true },
      { name: "Noah Park", role: "support", available: true },
      { name: "Eva Rossi", role: "support", available: false },
      { name: "Liam Walsh", role: "marketing", available: true },
    ];
    const users = staff.map((s) => {
      const [firstName, lastName] = s.name.split(" ");
      return store.insert("users", "us", {
        ...s,
        email: `${firstName}.${lastName}@ourco.example`.toLowerCase(),
        status: "active",
        createdAt: at(400),
      });
    });
    const byRole = (role: string) => users.filter((u) => u.role === role).map((u) => u.id);
    store.insert("teams", "tm", { name: "Sales", memberIds: byRole("sales"), managerId: users[0]!.id, strategy: "round_robin", status: "active", createdAt: at(300) });
    store.insert("teams", "tm", { name: "Support", memberIds: byRole("support"), managerId: users[0]!.id, strategy: "least_busy", status: "active", createdAt: at(300) });
    store.insert("teams", "tm", { name: "Marketing", memberIds: byRole("marketing"), managerId: users[0]!.id, strategy: "manual", status: "active", createdAt: at(300) });

    const salesIds = byRole("sales");
    for (let i = 0; i < (opts.contacts ?? 30); i++) {
      const p = person();
      store.insert("contacts", "ct", {
        ...p,
        phone: `+1555${String(1000000 + Math.floor(r() * 8999999))}`,
        ownerId: pick(salesIds),
        tags: r() < 0.3 ? ["vip"] : [],
        status: "active",
        createdAt: at(Math.floor(r() * 120)),
      });
    }

    // Leads: spread over the last 30 days, so every relative range has some.
    for (let i = 0; i < (opts.leads ?? 40); i++) {
      const p = person();
      store.insert("leads", "ld", {
        ...p,
        source: pick(LEAD_SOURCES),
        status: pick(["new", "new", "contacted", "qualified"]),
        score: Math.floor(r() * 100),
        ownerId: r() < 0.4 ? pick(salesIds) : null,
        createdAt: at(Math.floor(r() * 30)),
      });
    }

    // Fixed showcase leads: last week's Facebook leads, unassigned, for the brief's workflow examples.
    [2, 3, 5, 6, 8].forEach((daysAgo, i) => {
      const p = person();
      store.insert("leads", "ld", { ...p, source: "facebook_ads", status: "new", score: 40 + i * 10, ownerId: null, createdAt: at(daysAgo + 3) });
    });

    // Open tasks, so team workload isn't all zeros.
    for (let i = 0; i < 12; i++) {
      store.insert("tasks", "tk", {
        title: pick(["Call back", "Send proposal", "Check in", "Prepare demo"]),
        description: null,
        assigneeId: pick(salesIds),
        dueDate: addDays(today, Math.floor(r() * 10) - 3),
        priority: pick(["low", "normal", "high"]),
        status: "open",
        relatedTo: null,
        createdAt: at(Math.floor(r() * 14)),
      });
    }
  });
}
