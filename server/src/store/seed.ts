import type { Contact } from "../modules/m01-contacts/schema.js";
import { type Lead, LEAD_SOURCES } from "../modules/m03-leads/schema.js";
import { OUR_EMAIL, OUR_PHONE, type Ref, touch } from "../modules/m11-conversations/messaging.js";
import type { LineItem } from "../modules/m28-invoices/schema.js";
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
    const contacts: Contact[] = [];
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

    // Everything below was added with the messaging, billing and calendar modules. It comes after the
    // original rows so their ids and random draws stay the same.

    // A couple of closed deals, so won/lost reports aren't empty.
    f.opportunity({ name: `${contacts[8]!.company} - Pro plan`, contactId: contacts[8]!.id, pipelineId: pipeline.id, stageId: pipeline.stages[3]!.id, value: 4800, ownerId: tom.id, status: "won", closedAt: at(12), createdAt: at(50) });
    f.opportunity({ name: `${contacts[9]!.company} - Agency plan`, contactId: contacts[9]!.id, pipelineId: pipeline.id, stageId: pipeline.stages[2]!.id, value: 24000, ownerId: aisha.id, status: "lost", lostReason: "Went with a competitor", closedAt: at(8), createdAt: at(45) });

    // The managed tag list. Records carry tag names; "vip" is already on about a third of contacts.
    f.tag({ name: "vip", color: "yellow", description: "Our most valuable customers", createdAt: at(300) });
    f.tag({ name: "newsletter", color: "blue", description: "Gets the monthly newsletter", createdAt: at(200) });
    f.tag({ name: "webinar", color: "green", description: "Signed up for a webinar", createdAt: at(60) });
    f.tag({ name: "partner", color: "purple", description: "Agency or referral partner", createdAt: at(150) });
    for (const c of contacts.slice(10, 22)) store.update("contacts", c.id, { tags: [...c.tags, "newsletter"] });
    store.update("contacts", contacts[12]!.id, { tags: [...store.get<{ tags: string[] }>("contacts", contacts[12]!.id)!.tags, "partner"] });

    // Notes. nt_1 is the one examples point at.
    f.note({ body: "Asked us to call back after their budget review; prefers mornings.", attachedTo: [{ type: "contact", id: contacts[0]!.id }], authorId: raj.id, createdAt: at(6), updatedAt: at(6) });
    f.note({ body: "Key account: renewal is due in March. Always loop in Raj.", attachedTo: [{ type: "contact", id: contacts[2]!.id }], pinned: true, authorId: maya.id, createdAt: at(40), updatedAt: at(40) });
    f.note({
      body: "Decision maker is the COO, not the CEO. Send the proposal to both.",
      attachedTo: [{ type: "opportunity", id: "op_2" }, { type: "contact", id: contacts[1]!.id }],
      authorId: tom.id,
      revisions: [{ body: "Decision maker is the CEO.", at: at(15), by: tom.id }],
      createdAt: at(15),
      updatedAt: at(9),
    });

    // Messages. Each one also updates the person's conversation, as sending would.
    const after = (iso: string, hours: number) => new Date(Date.parse(iso) + hours * 3_600_000).toISOString();
    const message = (ref: Ref, address: string, channel: "sms" | "email", direction: "inbound" | "outbound", text: string, when: string, extra: Record<string, unknown> = {}) => {
      const conv = touch(store, ref, channel, direction, text, when);
      const out = direction === "outbound";
      const base = { ...ref, conversationId: conv.id, direction, status: out ? ("delivered" as const) : ("received" as const), sentAt: when, deliveredAt: when, createdAt: when, createdBy: out ? maya.id : null };
      return channel === "email"
        ? f.email({ ...base, to: out ? address : OUR_EMAIL, from: out ? OUR_EMAIL : address, subject: text, body: text, ...extra })
        : f.sms({ ...base, to: out ? address : OUR_PHONE, from: out ? OUR_PHONE : address, body: text, ...extra });
    };
    // cv_1: Sarah Johnson asked about pricing yesterday and is waiting on us.
    const sarah = { contactId: "ct_31", leadId: null };
    message(sarah, "sarah.johnson@brightside.example", "email", "outbound", "Following up on our call", at(3));
    message(sarah, "sarah.johnson@brightside.example", "email", "inbound", "Re: Following up on our call - what does the Agency plan cost?", at(1));
    // A few customers waiting on a reply from us.
    for (const c of contacts.slice(14, 17)) message({ contactId: c.id, leadId: null }, c.phone!, "sms", "inbound", pick(["Can we move our call?", "Is the invoice ready?", "Who should I talk to about upgrading?"]), at(Math.floor(r() * 3) + 1));

    // Lead follow-up: we emailed recent leads a day after they came in; some replied.
    const leads = store.all<Lead>("leads");
    const fb = leads.filter((l) => l.source === "facebook_ads");
    const recent = leads.filter((l) => l.source !== "facebook_ads" && l.createdAt >= f.at(-16, 0) && l.createdAt <= f.at(-2, 0) && l.status !== "new");
    const silent: Lead[] = [];
    [...recent, ...fb].forEach((l) => {
      const ref = { contactId: null, leadId: l.id };
      const sent = after(l.createdAt, 24);
      message(ref, l.email!, "email", "outbound", `Thanks for your interest, ${l.firstName}!`, sent);
      const replied = l.source === "facebook_ads" ? fb.indexOf(l) < 2 : r() < 0.4;
      if (replied) message(ref, l.email!, "email", "inbound", "Re: Thanks for your interest - yes, let's talk", after(sent, 5 + Math.floor(r() * 30)));
      else silent.push(l);
    });

    // Campaigns. None of these is the Facebook campaign: those leads have source facebook_ads only.
    const webinar = f.campaign({
      name: "Fall Webinar Series",
      channel: "email",
      status: "active",
      audience: { tag: "newsletter", contactIds: [] },
      steps: [
        { order: 1, channel: "email", subject: "Join our fall webinar series", body: "Three live sessions on growing with automation.", delayDays: 0 },
        { order: 2, channel: "email", subject: "Starting tomorrow", body: "A reminder: the first session is tomorrow.", delayDays: 6 },
      ],
      launchedAt: at(10),
      ownerId: liam.id,
      createdAt: at(20),
    });
    for (const c of contacts.slice(10, 22).filter((c) => c.preferences.email)) {
      message({ contactId: c.id, leadId: null }, c.email!, "email", "outbound", "Join our fall webinar series", f.at(-10, 15), { kind: "campaign", campaignId: webinar.id, ...(c.email!.includes("bounce") ? { status: "bounced", deliveredAt: null } : {}) });
    }
    f.campaign({
      name: "Spring Promo",
      channel: "sms",
      status: "completed",
      audience: { tag: "vip", contactIds: [] },
      steps: [{ order: 1, channel: "sms", subject: null, body: "Spring offer: 20% off annual plans this week. Reply STOP to opt out.", delayDays: 0 }],
      launchedAt: at(180),
      ownerId: liam.id,
      createdAt: at(190),
    });
    f.campaign({ name: "Holiday Offer", channel: "email", status: "draft", ownerId: liam.id, createdAt: at(4) });
    for (const l of leads.filter((l) => l.source === "event").slice(0, 4)) store.update("leads", l.id, { campaignId: webinar.id });

    // Appointments. ap_1 is upcoming with Sarah; one silent lead from last week already has a meeting booked.
    const meeting = (o: Parameters<Fixtures["appointment"]>[0] & { startAt: string }, minutes = 30) => f.appointment({ endAt: after(o.startAt, minutes / 60), createdAt: at(5), ...o });
    const contactAttendee = (c: { id: string; name: string }) => [{ kind: "contact" as const, id: c.id, name: c.name, noShow: false }];
    meeting({ title: "Agency plan walkthrough", contactId: "ct_31", hostId: raj.id, attendees: contactAttendee({ id: "ct_31", name: "Sarah Johnson" }), startAt: f.at(2, 15) });
    const booked = silent.find((l) => l.createdAt >= f.at(-9, 0)) ?? silent[0]!;
    meeting({ title: `Intro call with ${booked.name}`, contactId: null, leadId: booked.id, hostId: tom.id, attendees: [{ kind: "lead", id: booked.id, name: booked.name, noShow: false }], startAt: f.at(1, 18) });
    meeting({ title: `Quarterly review - ${contacts[5]!.name}`, contactId: contacts[5]!.id, hostId: aisha.id, attendees: contactAttendee(contacts[5]!), startAt: f.at(6, 16) }, 60);
    meeting({ title: `Onboarding - ${contacts[3]!.name}`, contactId: contacts[3]!.id, hostId: noah.id, attendees: contactAttendee(contacts[3]!), startAt: f.at(-5, 15), status: "completed", outcome: "Set up their first pipeline", createdAt: at(12) });
    meeting({ title: `Demo - ${contacts[6]!.name}`, contactId: contacts[6]!.id, hostId: tom.id, attendees: contactAttendee(contacts[6]!), startAt: f.at(-2, 17), status: "cancelled", cancelReason: "Customer rescheduling", createdAt: at(9) });
    const noShow = silent[silent.length - 1]!;
    meeting({ title: `Discovery call with ${noShow.name}`, contactId: null, leadId: noShow.id, hostId: aisha.id, attendees: [{ kind: "lead", id: noShow.id, name: noShow.name, noShow: true }], startAt: f.at(-3, 16), status: "no_show", createdAt: at(7) });

    // Invoices: paid, open, overdue by different amounts (two already reminded), a draft and a void one.
    const items = (...xs: [string, number, number][]): LineItem[] => xs.map(([description, quantity, unitPrice]) => ({ description, quantity, unitPrice, amount: quantity * unitPrice }));
    const invoice = (contact: { id: string }, lineItems: LineItem[], o: Parameters<Fixtures["invoice"]>[0] & { dueIn?: number } = {}) => {
      const { dueIn, ...rest } = o;
      const issued = dueIn !== undefined ? { status: "open" as const, issueDate: f.day(dueIn - 30), dueDate: f.day(dueIn), createdAt: f.at(dueIn - 31) } : {};
      return f.invoice({ contactId: contact.id, lineItems, ...issued, ...rest });
    };
    const remind = (inv: { id: string; number: string; contactId: string; reminders: unknown[] }, daysAgo: number) => {
      const c = contacts.find((x) => x.id === inv.contactId) ?? store.get<{ email: string }>("contacts", inv.contactId)!;
      const e = message({ contactId: inv.contactId, leadId: null }, c.email!, "email", "outbound", `Reminder: invoice ${inv.number} is overdue`, f.at(-daysAgo, 15), { kind: "invoice_reminder", invoiceId: inv.id });
      const cur = store.get<{ reminders: { at: string; emailId: string }[] }>("invoices", inv.id)!;
      store.update("invoices", inv.id, { reminders: [...cur.reminders, { at: e.sentAt, emailId: e.id }], lastReminderAt: e.sentAt });
    };
    const paid = invoice(contacts[0]!, items(["Pro plan (annual)", 1, 1200]), { dueIn: -10 });
    invoice(contacts[1]!, items(["Starter plan (monthly)", 3, 99]), { dueIn: 25 });
    const late5 = invoice(contacts[2]!, items(["Setup and onboarding", 1, 450]), { dueIn: -5 });
    const late20 = invoice(contacts[3]!, items(["Agency plan (quarterly)", 1, 897], ["Extra seats", 4, 25]), { dueIn: -20 });
    const late30 = invoice(contacts[4]!, items(["Consulting", 6, 150]), { dueIn: -30 });
    const late45 = invoice({ id: "ct_31" }, items(["Website build", 1, 2400]), { dueIn: -45 });
    invoice(contacts[6]!, items(["Pro plan (annual)", 1, 1200]));
    invoice(contacts[7]!, items(["Duplicate charge", 1, 300]), { status: "void", voidedAt: at(20), voidReason: "Billed twice by mistake", amountDue: 0 });
    invoice({ id: "ct_33" }, items(["Strategy workshop", 1, 650]), { dueIn: -18 });
    remind(late20, 2); // this week: workflow 2 should skip this customer
    remind(late30, 10);
    remind(late45, 9);

    // Payments: one paid in full, one partial, one declined, one not yet applied; and an open payment link.
    const pay = (o: Parameters<Fixtures["payment"]>[0]) => f.payment({ recordedBy: maya.id, ...o });
    const settle = (inv: { id: string; total: number }, amount: number, when: string) => {
      const p = pay({ contactId: store.get<{ contactId: string }>("invoices", inv.id)!.contactId, amount, unallocated: 0, allocations: [{ invoiceId: inv.id, amount, at: when }], createdAt: when });
      const cur = store.get<{ amountPaid: number; total: number }>("invoices", inv.id)!;
      const amountPaid = cur.amountPaid + amount;
      store.update("invoices", inv.id, { amountPaid, amountDue: cur.total - amountPaid, ...(amountPaid >= cur.total ? { status: "paid", paidAt: when } : {}) });
      return p;
    };
    settle(paid, 1200, at(12));
    settle(late45, 400, at(30));
    pay({ contactId: late30.contactId, amount: 900, method: "card", status: "failed", failure: { code: "card_declined", message: "The card was declined by the issuing bank" }, unallocated: 0, createdAt: at(4) });
    pay({ contactId: contacts[1]!.id, amount: 300, method: "bank_transfer", createdAt: at(3) });
    f.paymentRequest({ contactId: late5.contactId, invoiceId: late5.id, amount: 450, description: `Payment for invoice ${late5.number}`, createdBy: maya.id, createdAt: at(4) });
  });
}
