import { tableResolver } from "../../registry/lookup.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { atLeastOne, contains, Limit, listOf, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import { MessageTemplate, TEMPLATE_CHANNELS, TemplateVariable } from "./schema.js";
import "./fixtures.js";

// Reusable email and SMS bodies. Sending a message is M13 or M12; this module only stores and renders the text.

const TemplateId = z.string().describe("template id (tpl_…)");
const VarInput = z.strictObject({
  name: z.string().min(1),
  required: z.boolean(),
  sample: z.string().nullable().optional(),
});

function title(name: string): string {
  const n = name.trim();
  if (!n) throw new ActionError("INVALID", "Give the template a name");
  return n;
}

function nameTaken(store: Store, name: string, exceptId?: string): MessageTemplate | undefined {
  const n = name.trim().toLowerCase();
  return store.find<MessageTemplate>("message_templates", (t) => t.id !== exceptId && t.name.trim().toLowerCase() === n)[0];
}

function live(t: MessageTemplate, doing: string): void {
  requireState(`Template ${t.name}`, t.status, ["active"], doing);
}

function varName(name: string): string {
  const n = name.trim();
  if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(n)) throw new ActionError("INVALID", `Variable "${name}" must start with a letter and use only letters, numbers, dots and underscores`);
  return n;
}

function normalizeVars(vars: { name: string; required: boolean; sample?: string | null }[]): TemplateVariable[] {
  const names = vars.map((v) => varName(v.name));
  if (new Set(names).size !== names.length) throw new ActionError("DUPLICATE", "Variable names in one template have to be different");
  return vars.map((v) => ({ name: varName(v.name), required: v.required, sample: v.sample ?? null }));
}

function sameVars(a: TemplateVariable[], b: TemplateVariable[]): boolean {
  const norm = (vs: TemplateVariable[]) => JSON.stringify([...vs].map((v) => ({ name: v.name, required: v.required, sample: v.sample })).sort((x, y) => x.name.localeCompare(y.name)));
  return norm(a) === norm(b);
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}\}/g)].map((m) => m[1]!);
}

function used(t: MessageTemplate): string[] {
  return placeholders(`${t.subject ?? ""}\n${t.body}`);
}

function lookup(data: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(data, name)) return data[name];
  let cur: unknown = data;
  for (const part of name.split(".")) {
    if (cur == null || typeof cur !== "object" || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function fill(text: string, vars: TemplateVariable[], data: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}\}/g, (_raw, name: string) => {
    const spec = vars.find((v) => v.name === name);
    let value = lookup(data, name);
    if (value == null) value = spec?.sample ?? null;
    if (value == null || value === "") {
      if (spec?.required !== false) throw new ActionError("INVALID", `Missing a value for {{${name}}}; pass it in data or set a sample (M14.A07)`);
      return "";
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    throw new ActionError("INVALID", `{{${name}}} must be text, a number, or a yes/no`);
  });
}

function emailSubject(channel: MessageTemplate["channel"], subject: string | null | undefined, required: boolean): string | null {
  if (channel === "sms") {
    if (subject) throw new ActionError("INVALID", "SMS templates don't have a subject; use an email template for that");
    return null;
  }
  const s = subject?.trim();
  if (required && !s) throw new ActionError("INVALID", "Email templates need a subject; SMS templates don't");
  return s || null;
}

const createTemplate = defineAction({
  id: "M14.A01",
  description: "Save a reusable email or SMS body with {{variables}}. This does not send anything: drafting a one-off email is M13.A01 and a text is M12.A01.",
  risk: "write",
  input: z.strictObject({
    name: z.string().min(1),
    channel: z.enum(TEMPLATE_CHANNELS),
    subject: z.string().nullable().optional().describe("email only"),
    body: z.string().min(1),
    variables: z.array(VarInput).optional(),
  }),
  output: MessageTemplate,
  siblings: ["M13.A01", "M12.A01"],
  entities: { produces: "template" },
  example: () => ({ name: "Intro email", channel: "email", subject: "Hello", body: "Hi {{firstName}}", variables: [{ name: "firstName", required: true, sample: "Ada" }] }),
  handler: (a, { store, clock, actorId }) => {
    const name = title(a.name);
    const dup = nameTaken(store, name);
    if (dup) throw new ActionError("DUPLICATE", `A template named "${dup.name}" already exists (${dup.id})`, { existingId: dup.id });
    const now = clock.now().toISOString();
    const who = actorId ?? "us_1";
    return store.insert("message_templates", "tpl", {
      name,
      channel: a.channel,
      subject: emailSubject(a.channel, a.subject, true),
      body: a.body,
      variables: normalizeVars(a.variables ?? []),
      version: 1,
      versions: [],
      status: "active" as const,
      createdBy: who,
      updatedBy: who,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getTemplate = defineAction({
  id: "M14.A02",
  description: "Get one message template: channel, subject, body, variables, version and whether it is archived.",
  risk: "read",
  input: z.strictObject({ templateId: TemplateId }),
  output: MessageTemplate,
  entities: { consumes: ["template"] },
  example: (f) => ({ templateId: f.messageTemplate().id }),
  handler: ({ templateId }, { store }) => mustGet<MessageTemplate>(store, "message_templates", templateId, "template"),
});

const searchTemplates = defineAction({
  id: "M14.A03",
  description: "Find message templates by name or text, channel and status. Active templates are the default. Sent messages are a different search: M13.A07 or M12.A07.",
  risk: "read",
  input: z.strictObject({
    query: z.string().optional().describe("part of the name, subject or body"),
    channel: z.enum(TEMPLATE_CHANNELS).optional(),
    status: z.enum(["active", "archived"]).optional(),
    limit: Limit,
  }),
  output: listOf(MessageTemplate),
  entities: { produces: "template" },
  example: (f) => {
    f.messageTemplate({ name: "Onboarding note" });
    return { query: "Onboarding" };
  },
  handler: (a, { store }) => {
    const status = a.status ?? "active";
    const items = store.find<MessageTemplate>(
      "message_templates",
      (t) => t.status === status && (!a.channel || t.channel === a.channel) && (!a.query || [t.name, t.subject, t.body].some((v) => contains(v, a.query!))),
    );
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const updateContent = defineAction({
  id: "M14.A04",
  description: "Change a template's subject or body. The previous text is kept as a version you can restore with M14.A10. This still does not send the message.",
  risk: "write",
  input: z.strictObject({ templateId: TemplateId, subject: z.string().nullable().optional(), body: z.string().min(1).optional() }),
  output: MessageTemplate,
  entities: { consumes: ["template"] },
  example: (f) => ({ templateId: f.messageTemplate().id, body: "Hi {{firstName}}, welcome" }),
  handler: (a, { store, clock, actorId }) => {
    const t = mustGet<MessageTemplate>(store, "message_templates", a.templateId, "template");
    live(t, "be edited");
    atLeastOne(a, ["subject", "body"]);
    if (t.channel === "sms" && a.subject != null) throw new ActionError("INVALID", "SMS templates don't have a subject; use an email template for that");
    const subject = a.subject === undefined ? t.subject : emailSubject(t.channel, a.subject, true);
    const body = a.body ?? t.body;
    if (subject === t.subject && body === t.body) throw new ActionError("CONFLICT", `${t.name} already has that content`);
    const now = clock.now().toISOString();
    return store.update<MessageTemplate>("message_templates", t.id, {
      subject,
      body,
      version: t.version + 1,
      versions: [...t.versions, { version: t.version, subject: t.subject, body: t.body, at: t.updatedAt, by: t.updatedBy }],
      updatedBy: actorId ?? "us_1",
      updatedAt: now,
    });
  },
});

const archiveTemplate = defineAction({
  id: "M14.A05",
  description: "Archive a template so it can't be edited or rendered into new sends. Duplicate it first (M14.A06) if you still need the text.",
  risk: "destructive",
  input: z.strictObject({ templateId: TemplateId }),
  output: MessageTemplate,
  entities: { consumes: ["template"] },
  example: (f) => ({ templateId: f.messageTemplate().id }),
  handler: ({ templateId }, { store, clock, actorId }) => {
    const t = mustGet<MessageTemplate>(store, "message_templates", templateId, "template");
    live(t, "be archived");
    return store.update<MessageTemplate>("message_templates", t.id, { status: "archived", updatedBy: actorId ?? "us_1", updatedAt: clock.now().toISOString() });
  },
});

const duplicateTemplate = defineAction({
  id: "M14.A06",
  description: "Copy a template into a new active one at version 1, with no history. The original, even an archived one, is left as it is.",
  risk: "write",
  input: z.strictObject({ templateId: TemplateId, name: z.string().min(1).optional() }),
  output: MessageTemplate,
  entities: { consumes: ["template"], produces: "template" },
  example: (f) => ({ templateId: f.messageTemplate().id }),
  handler: ({ templateId, name }, { store, clock, actorId }) => {
    const t = mustGet<MessageTemplate>(store, "message_templates", templateId, "template");
    const next = title(name ?? `Copy of ${t.name}`);
    const dup = nameTaken(store, next);
    if (dup) throw new ActionError("DUPLICATE", `A template named "${dup.name}" already exists (${dup.id}); pass a different name`, { existingId: dup.id });
    const now = clock.now().toISOString();
    const who = actorId ?? "us_1";
    return store.insert("message_templates", "tpl", {
      name: next,
      channel: t.channel,
      subject: t.subject,
      body: t.body,
      variables: t.variables,
      version: 1,
      versions: [],
      status: "active" as const,
      createdBy: who,
      updatedBy: who,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const defineVariables = defineAction({
  id: "M14.A07",
  description: "Replace the variables a template declares (name, whether it's required, and a sample). This does not check that the body uses them; M14.A08 Validate template variables does.",
  risk: "write",
  input: z.strictObject({ templateId: TemplateId, variables: z.array(VarInput) }),
  output: MessageTemplate,
  entities: { consumes: ["template"] },
  example: (f) => ({
    templateId: f.messageTemplate().id,
    variables: [{ name: "firstName", required: true, sample: "Ada" }, { name: "company", required: false, sample: "Acme" }],
  }),
  handler: ({ templateId, variables }, { store, clock, actorId }) => {
    const t = mustGet<MessageTemplate>(store, "message_templates", templateId, "template");
    live(t, "have its variables changed");
    const next = normalizeVars(variables);
    if (sameVars(next, t.variables)) throw new ActionError("CONFLICT", `${t.name} already declares those variables`);
    return store.update<MessageTemplate>("message_templates", t.id, { variables: next, updatedBy: actorId ?? "us_1", updatedAt: clock.now().toISOString() });
  },
});

const validateVariables = defineAction({
  id: "M14.A08",
  description: "Check that every {{placeholder}} in the subject and body is a declared variable, and that every required variable appears. Rendering (M14.A09) is separate and fills in values.",
  risk: "read",
  input: z.strictObject({ templateId: TemplateId }),
  output: z.object({ templateId: z.string(), valid: z.literal(true), placeholders: z.array(z.string()) }),
  entities: { consumes: ["template"] },
  example: (f) => ({ templateId: f.messageTemplate().id }),
  handler: ({ templateId }, { store }) => {
    const t = mustGet<MessageTemplate>(store, "message_templates", templateId, "template");
    const names = used(t);
    const defined = new Set(t.variables.map((v) => v.name));
    const unknown = [...new Set(names.filter((n) => !defined.has(n)))];
    const missing = t.variables.filter((v) => v.required && !names.includes(v.name)).map((v) => v.name);
    if (unknown.length || missing.length) {
      const parts = [
        unknown.length ? `unknown placeholders: ${unknown.join(", ")} (define them with M14.A07)` : "",
        missing.length ? `required variables not in the text: ${missing.join(", ")}` : "",
      ].filter(Boolean);
      throw new ActionError("INVALID", `${t.name} has ${parts.join("; ")}`);
    }
    return { templateId: t.id, valid: true as const, placeholders: [...new Set(names)] };
  },
});

const renderTemplate = defineAction({
  id: "M14.A09",
  description: "Fill a template's {{placeholders}} from data you pass, falling back to each variable's sample. This only returns the text. To send it, use M13.A03 Send email or M12.A03 Send SMS.",
  risk: "read",
  input: z.strictObject({ templateId: TemplateId, data: z.record(z.string(), z.unknown()).optional() }),
  output: z.object({ templateId: z.string(), channel: z.enum(TEMPLATE_CHANNELS), subject: z.string().nullable(), body: z.string() }),
  siblings: ["M13.A02", "M12.A02"],
  entities: { consumes: ["template"] },
  example: (f) => ({ templateId: f.messageTemplate().id, data: { firstName: "Ada" } }),
  handler: ({ templateId, data }, { store }) => {
    const t = mustGet<MessageTemplate>(store, "message_templates", templateId, "template");
    if (t.status === "archived") throw new ActionError("CONFLICT", `${t.name} is archived; duplicate it (M14.A06) before rendering`);
    const values = data ?? {};
    return {
      templateId: t.id,
      channel: t.channel,
      subject: t.subject == null ? null : fill(t.subject, t.variables, values),
      body: fill(t.body, t.variables, values),
    };
  },
});

const restoreVersion = defineAction({
  id: "M14.A10",
  description: "Put an earlier saved version of the subject and body back. The current text is kept in the history first. Unknown version numbers are refused.",
  risk: "write",
  input: z.strictObject({ templateId: TemplateId, version: z.number().int().positive() }),
  output: MessageTemplate,
  entities: { consumes: ["template"] },
  example: (f) => ({
    templateId: f.messageTemplate({
      version: 2,
      body: "Hi {{firstName}} there",
      versions: [{ version: 1, subject: "Hello", body: "Hi {{firstName}}", at: f.at(-1), by: "us_1" }],
    }).id,
    version: 1,
  }),
  handler: (a, { store, clock, actorId }) => {
    const t = mustGet<MessageTemplate>(store, "message_templates", a.templateId, "template");
    live(t, "be restored");
    const snap = t.versions.find((v) => v.version === a.version);
    if (!snap) {
      const have = t.versions.map((v) => v.version).join(", ") || "none";
      throw new ActionError("CONFLICT", `Template ${t.name} has no saved version ${a.version} (saved versions: ${have}). Edit it with M14.A04 to create one`);
    }
    if (snap.subject === t.subject && snap.body === t.body) throw new ActionError("CONFLICT", `${t.name} already has the content of version ${a.version}`);
    const now = clock.now().toISOString();
    return store.update<MessageTemplate>("message_templates", t.id, {
      subject: snap.subject,
      body: snap.body,
      version: t.version + 1,
      versions: [...t.versions, { version: t.version, subject: t.subject, body: t.body, at: t.updatedAt, by: t.updatedBy }],
      updatedBy: actorId ?? "us_1",
      updatedAt: now,
    });
  },
});

export default {
  resolvers: {
    template: tableResolver("message_templates", "name", {"channel":"channel"}),
  },
  actions: [createTemplate, getTemplate, searchTemplates, updateContent, archiveTemplate, duplicateTemplate, defineVariables, validateVariables, renderTemplate, restoreVersion],
} satisfies ModuleExports;
