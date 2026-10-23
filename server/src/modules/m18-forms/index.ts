import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { contains, freshId, fullName, inDateRange, Limit, listOf, page, requireState, sameEmail } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Clock } from "../../store/clock.js";
import type { Store } from "../../store/db.js";
import type { Contact } from "../m01-contacts/schema.js";
import { FORM_FIELD_TYPES, Form, FormField, FormSubmission } from "./schema.js";

import "./fixtures.js";

// Forms collect answers and, when a field maps to email, match or create a contact. Submissions are
// accepted only after the form is published. Draft and archived forms refuse them.

const FormId = z.string().describe("form id (fm_…)");
const FieldId = z.string().describe("field id");
const emptyRules = { minLength: null, maxLength: null, pattern: null };
const TEXT_TYPES = new Set(["text", "email", "phone", "textarea"]);
const MapsTo = z.enum(["email", "phone", "firstName", "lastName", "company"]).describe("contact field this fills");

// A mapping the submit step would silently ignore (a typo) or fill twice (the last field wins) is refused when it is set.
function checkMapping(form: Form, fieldId: string | null, mapsTo: string | null): void {
  const clash = mapsTo && form.fields.find((field) => field.id !== fieldId && field.mapsTo === mapsTo);
  if (clash) throw new ActionError("CONFLICT", `Field "${clash.label}" already fills the contact's ${mapsTo}`);
}

const iso = (clock: Clock) => clock.now().toISOString();

function byName(store: Store, name: string): Form | undefined {
  const key = name.trim().toLowerCase();
  return store.find<Form>("forms", (form) => form.name.trim().toLowerCase() === key)[0];
}

function editable(form: Form): void {
  requireState(`Form "${form.name}"`, form.status, ["draft", "published"], "be edited");
}

function fieldOf(form: Form, fieldId: string): FormField {
  const field = form.fields.find((item) => item.id === fieldId);
  if (!field) throw new ActionError("NOT_FOUND", `No field with id ${fieldId} on form ${form.id}`, { id: fieldId });
  return field;
}

function checkPattern(pattern: string): void {
  try {
    new RegExp(pattern);
  } catch {
    throw new ActionError("INVALID", `Pattern ${pattern} is not a valid regular expression`);
  }
}

function checkRules(rules: { minLength: number | null; maxLength: number | null; pattern: string | null }): void {
  if (rules.minLength != null && rules.maxLength != null && rules.minLength > rules.maxLength) {
    throw new ActionError("INVALID", "minLength can't be greater than maxLength");
  }
  if (rules.pattern) checkPattern(rules.pattern);
}

function formErrors(form: Form): string[] {
  const errors: string[] = [];
  if (form.fields.length === 0) errors.push("Add at least one field");
  for (const field of form.fields) {
    if (field.type === "dropdown" && field.options.length === 0) errors.push(`Field "${field.label}" needs at least one option`);
    if (field.validation.minLength != null && field.validation.maxLength != null && field.validation.minLength > field.validation.maxLength) {
      errors.push(`Field "${field.label}" has minLength greater than maxLength`);
    }
    if (field.validation.pattern) {
      try {
        new RegExp(field.validation.pattern);
      } catch {
        errors.push(`Field "${field.label}" has a pattern that is not a valid regular expression`);
      }
    }
  }
  return errors;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function contactByEmail(store: Store, email: string): Contact | undefined {
  const matches = store.find<Contact>("contacts", (contact) => contact.status !== "merged" && sameEmail(contact.email, email));
  matches.sort((a, b) => Number(a.status !== "active") - Number(b.status !== "active") || a.id.localeCompare(b.id));
  return matches[0];
}

const createForm = defineAction({
  id: "M18.A01",
  description: "Creates a new empty form with a name so you can then add fields to it. Use before adding fields; it does not publish the form.",
  risk: "write",
  input: z.strictObject({ name: z.string().min(1) }),
  output: Form,
  entities: { produces: "form" },
  example: () => ({ name: "Website inquiry" }),
  handler: (a, { store, clock }) => {
    const name = a.name.trim();
    if (!name) throw new ActionError("INVALID", "Name can't be blank");
    const existing = byName(store, name);
    if (existing) throw new ActionError("DUPLICATE", `A form named "${name}" already exists (${existing.id})`, { existingId: existing.id });
    const now = iso(clock);
    return store.insert("forms", "fm", { name, fields: [], status: "draft" as const, createdAt: now, updatedAt: now, publishedAt: null });
  },
});

const getForm = defineAction({
  id: "M18.A02",
  description: "Shows the full definition of a form: its fields, order, validation rules and publish state. Use to inspect one form, unlike listing all forms.",
  risk: "read",
  input: z.strictObject({ formId: FormId }),
  output: Form,
  entities: { consumes: ["form"] },
  example: (f) => ({ formId: f.form().id }),
  handler: ({ formId }, { store }) => mustGet<Form>(store, "forms", formId, "form"),
});

const listForms = defineAction({
  id: "M18.A03",
  description: "Lists the forms that exist in the account, with names and status. Use to browse or find a form; for one form's fields use Get form definition.",
  risk: "read",
  input: z.strictObject({
    status: z.enum(["draft", "published", "archived"]).optional(),
    query: z.string().optional().describe("part of the name"),
    limit: Limit,
  }),
  output: listOf(Form),
  entities: { produces: "form" },
  example: (f) => {
    f.form({ name: "Inquiry" });
    return { query: "Inquiry" };
  },
  handler: (a, { store }) => {
    const items = store.find<Form>("forms", (form) => (!a.status || form.status === a.status) && (!a.query || contains(form.name, a.query)));
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const addField = defineAction({
  id: "M18.A04",
  description: "Adds a new field, such as a text box, email or dropdown, to an existing form. Use for new fields; to change an existing one use Update form field.",
  risk: "write",
  input: z.strictObject({
    formId: FormId,
    label: z.string().min(1),
    type: z.enum(FORM_FIELD_TYPES),
    required: z.boolean().optional(),
    options: z.array(z.string().min(1)).optional(),
    mapsTo: MapsTo.nullable().optional(),
  }),
  output: Form,
  entities: { consumes: ["form"] },
  example: (f) => ({ formId: f.form().id, label: "Work email", type: "email", mapsTo: "email" }),
  handler: (a, { store, clock }) => {
    const form = mustGet<Form>(store, "forms", a.formId, "form");
    editable(form);
    const label = a.label.trim();
    if (!label) throw new ActionError("INVALID", "Label can't be blank");
    if (form.fields.some((field) => field.label.toLowerCase() === label.toLowerCase())) {
      throw new ActionError("DUPLICATE", `This form already has a field named "${label}"`);
    }
    const options = a.options ?? [];
    if (a.type === "dropdown" && options.length === 0) throw new ActionError("INVALID", "Dropdown fields need at least one option");
    if (a.type !== "dropdown" && options.length > 0) throw new ActionError("INVALID", "Only dropdown fields have options");
    checkMapping(form, null, a.mapsTo ?? null);
    const field: FormField = {
      id: freshId(store, "fd", form.fields.map((item) => item.id)),
      label,
      type: a.type,
      required: a.required ?? false,
      options,
      validation: { ...emptyRules },
      mapsTo: a.mapsTo ?? null,
    };
    return store.update<Form>("forms", form.id, { fields: [...form.fields, field], updatedAt: iso(clock) });
  },
});

const updateField = defineAction({
  id: "M18.A05",
  description: "Changes an existing field on a form, such as its label, type, placeholder or required setting. Does not add new fields or change their order.",
  risk: "write",
  input: z.strictObject({
    formId: FormId,
    fieldId: FieldId,
    label: z.string().min(1).optional(),
    type: z.enum(FORM_FIELD_TYPES).optional(),
    required: z.boolean().optional(),
    options: z.array(z.string().min(1)).optional(),
    mapsTo: MapsTo.nullable().optional(),
  }),
  output: Form,
  entities: { consumes: ["form"] },
  example: (f) => {
    const form = f.form({
      fields: [{ id: "field_email", label: "Email", type: "email", required: true, options: [], validation: { ...emptyRules }, mapsTo: "email" }],
    });
    return { formId: form.id, fieldId: "field_email", label: "Work email" };
  },
  handler: (a, { store, clock }) => {
    if (a.label === undefined && a.type === undefined && a.required === undefined && a.options === undefined && a.mapsTo === undefined) {
      throw new ActionError("INVALID", "Nothing to change: give at least one of label, type, required, options, mapsTo");
    }
    const form = mustGet<Form>(store, "forms", a.formId, "form");
    const current = fieldOf(form, a.fieldId);
    editable(form);
    const next: FormField = { ...current, options: [...current.options], validation: { ...current.validation } };
    if (a.label !== undefined) {
      const label = a.label.trim();
      if (!label) throw new ActionError("INVALID", "Label can't be blank");
      if (form.fields.some((field) => field.id !== current.id && field.label.toLowerCase() === label.toLowerCase())) {
        throw new ActionError("DUPLICATE", `This form already has a field named "${label}"`);
      }
      next.label = label;
    }
    if (a.type !== undefined) next.type = a.type;
    if (a.required !== undefined) next.required = a.required;
    if (a.mapsTo !== undefined) {
      checkMapping(form, current.id, a.mapsTo);
      next.mapsTo = a.mapsTo;
    }
    if (a.options !== undefined) next.options = a.options;
    else if (next.type !== "dropdown") next.options = [];
    if (next.type === "dropdown" && next.options.length === 0) throw new ActionError("INVALID", "Dropdown fields need at least one option");
    if (next.type !== "dropdown" && next.options.length > 0) throw new ActionError("INVALID", "Only dropdown fields have options");
    if (JSON.stringify(next) === JSON.stringify(current)) throw new ActionError("CONFLICT", "The record already has that value");
    return store.update<Form>("forms", form.id, {
      fields: form.fields.map((field) => (field.id === current.id ? next : field)),
      updatedAt: iso(clock),
    });
  },
});

const reorderFields = defineAction({
  id: "M18.A06",
  description: "Changes the order in which fields appear on a form. Use to move fields up or down; it does not edit field content.",
  risk: "write",
  input: z.strictObject({ formId: FormId, fieldIds: z.array(z.string().min(1)) }),
  output: Form,
  entities: { consumes: ["form"] },
  example: (f) => {
    const form = f.form({
      fields: [
        { id: "field_a", label: "Name", type: "text", required: false, options: [], validation: { ...emptyRules }, mapsTo: "firstName" },
        { id: "field_b", label: "Email", type: "email", required: true, options: [], validation: { ...emptyRules }, mapsTo: "email" },
      ],
    });
    return { formId: form.id, fieldIds: ["field_b", "field_a"] };
  },
  handler: ({ formId, fieldIds }, { store, clock }) => {
    const form = mustGet<Form>(store, "forms", formId, "form");
    editable(form);
    if (fieldIds.length !== form.fields.length || new Set(fieldIds).size !== fieldIds.length) {
      throw new ActionError("INVALID", "fieldIds must list every field exactly once");
    }
    const byId = new Map(form.fields.map((field) => [field.id, field]));
    const next: FormField[] = [];
    for (const id of fieldIds) {
      const field = byId.get(id);
      if (!field) throw new ActionError("NOT_FOUND", `No field with id ${id} on form ${form.id}`, { id });
      next.push(field);
    }
    if (next.every((field, index) => field.id === form.fields[index]?.id)) throw new ActionError("CONFLICT", "The record already has that value");
    return store.update<Form>("forms", form.id, { fields: next, updatedAt: iso(clock) });
  },
});

const setValidation = defineAction({
  id: "M18.A07",
  description: "Sets rules that submitted answers must meet, like required fields, formats or length limits. Applies to the whole form's validation, not field content or layout.",
  risk: "write",
  input: z.strictObject({
    formId: FormId,
    fieldId: FieldId,
    minLength: z.number().int().min(0).nullable().optional(),
    maxLength: z.number().int().min(0).nullable().optional(),
    pattern: z.string().min(1).nullable().optional(),
  }),
  output: Form,
  entities: { consumes: ["form"] },
  example: (f) => {
    const form = f.form({
      fields: [{ id: "field_name", label: "Name", type: "text", required: true, options: [], validation: { ...emptyRules }, mapsTo: null }],
    });
    return { formId: form.id, fieldId: "field_name", minLength: 2 };
  },
  handler: (a, { store, clock }) => {
    if (a.minLength === undefined && a.maxLength === undefined && a.pattern === undefined) {
      throw new ActionError("INVALID", "Nothing to change: give at least one of minLength, maxLength, pattern");
    }
    const form = mustGet<Form>(store, "forms", a.formId, "form");
    const current = fieldOf(form, a.fieldId);
    editable(form);
    if (!TEXT_TYPES.has(current.type)) throw new ActionError("INVALID", "Validation rules apply to text, email, phone, and textarea fields");
    const validation = {
      minLength: a.minLength !== undefined ? a.minLength : current.validation.minLength,
      maxLength: a.maxLength !== undefined ? a.maxLength : current.validation.maxLength,
      pattern: a.pattern !== undefined ? a.pattern : current.validation.pattern,
    };
    checkRules(validation);
    if (JSON.stringify(validation) === JSON.stringify(current.validation)) throw new ActionError("CONFLICT", "The record already has that value");
    const fields = form.fields.map((field) => (field.id === current.id ? { ...field, validation } : field));
    return store.update<Form>("forms", form.id, { fields, updatedAt: iso(clock) });
  },
});

const publishForm = defineAction({
  id: "M18.A08",
  description: "Makes a form live so people can fill it out. Use once the fields and rules are ready; it does not collect responses itself.",
  risk: "external",
  input: z.strictObject({ formId: FormId }),
  output: Form,
  siblings: ["M37.A07", "M37.A09"],
  entities: { consumes: ["form"] },
  example: (f) => ({
    formId: f.form({
      fields: [{ id: "field_name", label: "Name", type: "text", required: false, options: [], validation: { ...emptyRules }, mapsTo: null }],
    }).id,
  }),
  handler: ({ formId }, { store, clock }) => {
    const form = mustGet<Form>(store, "forms", formId, "form");
    requireState(`Form "${form.name}"`, form.status, ["draft"], "be published");
    const errors = formErrors(form);
    if (errors.length) throw new ActionError("CONFLICT", `Fix the form before publishing: ${errors.join("; ")}`);
    const now = iso(clock);
    return store.update<Form>("forms", form.id, { status: "published", publishedAt: now, updatedAt: now });
  },
});

const submitForm = defineAction({
  id: "M18.A09",
  description: "Submits a test response to a form as if a visitor filled it in, for trying out the form. Creates a submission record.",
  risk: "write",
  input: z.strictObject({
    formId: FormId,
    values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  }),
  output: FormSubmission,
  entities: { consumes: ["form"], produces: "form_submission" },
  example: (f) => {
    const form = f.form({
      status: "published",
      publishedAt: f.now(),
      fields: [{ id: "field_email", label: "Email", type: "email", required: true, options: [], validation: { ...emptyRules }, mapsTo: "email" }],
    });
    return { formId: form.id, values: { field_email: "submit@example.com" } };
  },
  handler: (a, { store, clock }) => {
    const form = mustGet<Form>(store, "forms", a.formId, "form");
    requireState(`Form "${form.name}"`, form.status, ["published"], "take submissions");
    const known = new Set(form.fields.map((field) => field.id));
    for (const key of Object.keys(a.values)) {
      if (!known.has(key)) throw new ActionError("INVALID", `Unknown field ${key}`);
    }
    for (const field of form.fields) checkAnswer(field, a.values[field.id]);
    const now = iso(clock);
    const contactId = linkContact(store, form, a.values, now);
    return store.insert("form_submissions", "fms", { formId: form.id, values: a.values, contactId, submittedAt: now });
  },
});

function checkAnswer(field: FormField, value: string | number | boolean | undefined): void {
  const empty = value === undefined || value === "";
  if (empty) {
    if (field.required) throw new ActionError("INVALID", `Field "${field.label}" is required`);
    return;
  }
  if (field.type === "checkbox") {
    if (typeof value !== "boolean") throw new ActionError("INVALID", `Field "${field.label}" must be true or false`);
    return;
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new ActionError("INVALID", `Field "${field.label}" must be a number`);
    return;
  }
  if (field.type === "dropdown") {
    if (typeof value !== "string" || !field.options.includes(value)) throw new ActionError("INVALID", `Field "${field.label}" must be one of the options`);
    return;
  }
  if (typeof value !== "string") throw new ActionError("INVALID", `Field "${field.label}" must be text`);
  if (field.type === "email" && !isEmail(value.trim())) throw new ActionError("INVALID", `Field "${field.label}" must be an email address`);
  const rules = field.validation;
  if (rules.minLength != null && value.length < rules.minLength) throw new ActionError("INVALID", `Field "${field.label}" is shorter than ${rules.minLength}`);
  if (rules.maxLength != null && value.length > rules.maxLength) throw new ActionError("INVALID", `Field "${field.label}" is longer than ${rules.maxLength}`);
  if (rules.pattern) {
    checkPattern(rules.pattern);
    if (!new RegExp(rules.pattern).test(value)) throw new ActionError("INVALID", `Field "${field.label}" does not match the required pattern`);
  }
}

function linkContact(store: Store, form: Form, values: Record<string, string | number | boolean>, now: string): string | null {
  const mapped: Record<string, string> = {};
  for (const field of form.fields) {
    if (!field.mapsTo) continue;
    const raw = values[field.id];
    if (typeof raw !== "string" || !raw.trim()) continue;
    mapped[field.mapsTo] = field.mapsTo === "email" ? raw.trim().toLowerCase() : raw.trim();
  }
  const email = mapped.email;
  if (!email) return null;
  if (!isEmail(email)) throw new ActionError("INVALID", "The email field must be an email address");
  const existing = contactByEmail(store, email);
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (mapped.firstName && mapped.firstName !== existing.firstName) patch.firstName = mapped.firstName;
    if (mapped.lastName && mapped.lastName !== existing.lastName) patch.lastName = mapped.lastName;
    if (mapped.phone && mapped.phone !== existing.phone) patch.phone = mapped.phone;
    if (mapped.company && mapped.company !== existing.company) patch.company = mapped.company;
    if (patch.firstName !== undefined || patch.lastName !== undefined) {
      patch.name = fullName((patch.firstName as string | undefined) ?? existing.firstName, (patch.lastName as string | undefined) ?? existing.lastName);
    }
    if (Object.keys(patch).length) {
      patch.updatedAt = now;
      store.update<Contact>("contacts", existing.id, patch);
    }
    return existing.id;
  }
  const firstName = mapped.firstName || email.split("@")[0] || "Contact";
  const lastName = mapped.lastName ?? null;
  const created = store.insert("contacts", "ct", {
    firstName,
    lastName,
    name: fullName(firstName, lastName),
    email,
    phone: mapped.phone ?? null,
    company: mapped.company ?? null,
    companyId: null,
    ownerId: null,
    tags: [],
    preferences: { email: true, sms: true, call: true, dnd: false },
    relationships: [],
    status: "active" as const,
    mergedInto: null,
    createdAt: now,
    updatedAt: now,
  });
  return created.id;
}

const listSubmissions = defineAction({
  id: "M18.A10",
  description: "Lists the responses people have submitted to a form. Use to review collected answers; not for form structure or fields.",
  risk: "read",
  input: z.strictObject({
    formId: FormId,
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: Limit,
  }),
  output: listOf(FormSubmission),
  entities: { consumes: ["form"], produces: "form_submission" },
  example: (f) => ({ formId: f.form().id }),
  handler: (a, { store }) => {
    const form = mustGet<Form>(store, "forms", a.formId, "form");
    const items = store.find<FormSubmission>("form_submissions", (row) => row.formId === form.id && inDateRange(row.submittedAt, a.from, a.to));
    items.sort((x, y) => y.submittedAt.localeCompare(x.submittedAt) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

export default {
  actions: [createForm, getForm, listForms, addField, updateField, reorderFields, setValidation, publishForm, submitForm, listSubmissions],
} satisfies ModuleExports;
