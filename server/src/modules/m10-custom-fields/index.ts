import { tableResolver } from "../../registry/lookup.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { atLeastOne, Limit, listOf, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { SmartList } from "../m09-smart-lists/schema.js";
import { CUSTOM_FIELD_MODULES, CUSTOM_FIELD_TABLES, CustomField, CustomFieldValue, FIELD_TYPES } from "./schema.js";
import "./fixtures.js";

// Typed fields kept off the records they extend. Values live in custom_field_values, which smart lists read as cf.<key>.

const FieldId = z.string().describe("custom field id (cf_…)");
const OptionInput = z.strictObject({ value: z.string().min(1), label: z.string().min(1) });

function title(name: string): string {
  const n = name.trim();
  if (!n) throw new ActionError("INVALID", "Give it a name");
  return n;
}

function keyOf(raw: string): string {
  const key = raw.trim();
  if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new ActionError("INVALID", `Key "${raw}" must be lowercase letters, numbers and underscores, starting with a letter`);
  return key;
}

function keyTaken(store: Store, module: CustomField["module"], key: string): CustomField | undefined {
  return store.find<CustomField>("custom_fields", (f) => f.module === module && f.key === key)[0];
}

function live(field: CustomField, doing: string): void {
  requireState(field.label, field.status, ["active"], doing);
}

function dropdown(field: CustomField, doing: string): void {
  if (field.type !== "dropdown") throw new ActionError("INVALID", `${field.label} is a ${field.type} field; only dropdowns can ${doing}`);
}

function compile(pattern: string): void {
  try {
    new RegExp(pattern);
  } catch {
    throw new ActionError("INVALID", `Pattern "${pattern}" is not a valid regular expression`);
  }
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function checkValue(field: CustomField, value: string | number | boolean | null): void {
  if (value === null) {
    if (field.validation.required) throw new ActionError("INVALID", `${field.label} is required`);
    return;
  }
  const { min, max, pattern } = field.validation;
  if (field.type === "text") {
    if (typeof value !== "string") throw new ActionError("INVALID", `${field.label} is a text field`);
    if (min != null && value.length < min) throw new ActionError("INVALID", `${field.label} must be at least ${min} characters`);
    if (max != null && value.length > max) throw new ActionError("INVALID", `${field.label} must be at most ${max} characters`);
    if (pattern && !new RegExp(pattern).test(value)) throw new ActionError("INVALID", `${field.label} doesn't match the required pattern`);
    return;
  }
  if (field.type === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) throw new ActionError("INVALID", `${field.label} is a number field`);
    if (min != null && value < min) throw new ActionError("INVALID", `${field.label} must be at least ${min}`);
    if (max != null && value > max) throw new ActionError("INVALID", `${field.label} must be at most ${max}`);
    return;
  }
  if (field.type === "date") {
    if (typeof value !== "string" || !isCalendarDate(value)) throw new ActionError("INVALID", `${field.label} must be a real date (YYYY-MM-DD)`);
    return;
  }
  if (field.type === "checkbox") {
    if (typeof value !== "boolean") throw new ActionError("INVALID", `${field.label} is a checkbox (true or false)`);
    return;
  }
  if (typeof value !== "string") throw new ActionError("INVALID", `${field.label} must be one of its options`);
  const opt = field.options.find((o) => o.value === value);
  if (!opt) throw new ActionError("INVALID", `${field.label} has no option "${value}"`);
  if (opt.retired) throw new ActionError("CONFLICT", `Option "${opt.label}" is retired and can't be chosen; pick an active option`);
}

const createField = defineAction({
  id: "M10.A01",
  description: "Add a typed custom field (text, number, date, checkbox or dropdown) to contacts, leads, deals or companies. The key is what smart lists call cf.<key>. This does not set a value on a record.",
  risk: "write",
  input: z.strictObject({
    key: z.string().min(1),
    label: z.string().min(1),
    module: z.enum(CUSTOM_FIELD_MODULES),
    type: z.enum(FIELD_TYPES),
    helpText: z.string().optional(),
    options: z.array(OptionInput).optional().describe("dropdown choices"),
    required: z.boolean().optional(),
  }),
  output: CustomField,
  entities: { produces: "custom_field" },
  example: () => ({ key: "favorite_color", label: "Favorite color", module: "contact", type: "text" }),
  handler: (a, { store, clock }) => {
    const key = keyOf(a.key);
    const dup = keyTaken(store, a.module, key);
    if (dup) throw new ActionError("DUPLICATE", `${a.module} already has a field with key ${key} (${dup.id})`, { existingId: dup.id });
    if (a.type !== "dropdown" && a.options?.length) throw new ActionError("INVALID", "Options are only for dropdown fields");
    const values = (a.options ?? []).map((o) => o.value);
    if (new Set(values).size !== values.length) throw new ActionError("DUPLICATE", "Dropdown option values have to be different");
    return store.insert("custom_fields", "cf", {
      key,
      label: title(a.label),
      helpText: a.helpText ?? null,
      module: a.module,
      type: a.type,
      options: (a.options ?? []).map((o) => ({ value: o.value, label: title(o.label), retired: false })),
      validation: { required: a.required ?? false, min: null, max: null, pattern: null },
      status: "active" as const,
      createdAt: clock.now().toISOString(),
    });
  },
});

const getField = defineAction({
  id: "M10.A02",
  description: "Get one custom field: its key, label, type, options, validation and whether it is archived.",
  risk: "read",
  input: z.strictObject({ fieldId: FieldId }),
  output: CustomField,
  entities: { consumes: ["custom_field"] },
  example: (f) => ({ fieldId: f.customField().id }),
  handler: ({ fieldId }, { store }) => mustGet<CustomField>(store, "custom_fields", fieldId, "custom field"),
});

const listFields = defineAction({
  id: "M10.A03",
  description: "List the custom fields defined for one module (contact, lead, opportunity or company), by key. This is the schema, not the values on records.",
  risk: "read",
  input: z.strictObject({ module: z.enum(CUSTOM_FIELD_MODULES), status: z.enum(["active", "archived"]).optional(), limit: Limit }),
  output: listOf(CustomField),
  entities: { produces: "custom_field" },
  example: () => ({ module: "contact" }),
  handler: (a, { store }) => {
    const items = store.find<CustomField>("custom_fields", (f) => f.module === a.module && (!a.status || f.status === a.status));
    items.sort((x, y) => x.key.localeCompare(y.key) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const renameLabel = defineAction({
  id: "M10.A04",
  description: "Change the label people see. The key stays put, so cf.<key> filters keep working. To change help text, use M10.A05.",
  risk: "write",
  input: z.strictObject({ fieldId: FieldId, label: z.string().min(1) }),
  output: CustomField,
  entities: { consumes: ["custom_field"] },
  example: (f) => ({ fieldId: f.customField().id, label: "Renamed field" }),
  handler: ({ fieldId, label }, { store }) => {
    const field = mustGet<CustomField>(store, "custom_fields", fieldId, "custom field");
    live(field, "be renamed");
    const next = title(label);
    if (next === field.label) throw new ActionError("CONFLICT", `${field.label} is already called that`);
    return store.update<CustomField>("custom_fields", field.id, { label: next });
  },
});

const updateHelp = defineAction({
  id: "M10.A05",
  description: "Set or clear the help text shown next to a custom field. Pass null to clear it. The label has its own action (M10.A04).",
  risk: "write",
  input: z.strictObject({ fieldId: FieldId, helpText: z.string().nullable() }),
  output: CustomField,
  entities: { consumes: ["custom_field"] },
  example: (f) => ({ fieldId: f.customField().id, helpText: "Shown on the form" }),
  handler: ({ fieldId, helpText }, { store }) => {
    const field = mustGet<CustomField>(store, "custom_fields", fieldId, "custom field");
    live(field, "have its help text changed");
    const next = helpText?.trim() || null;
    if (next === field.helpText) throw new ActionError("CONFLICT", `${field.label} already has that help text`);
    return store.update<CustomField>("custom_fields", field.id, { helpText: next });
  },
});

const setValidation = defineAction({
  id: "M10.A06",
  description: "Set whether a field is required, and for text or number fields a min, max and (text only) pattern. min and max are character counts for text and bounds for numbers.",
  risk: "write",
  input: z.strictObject({
    fieldId: FieldId,
    required: z.boolean().optional(),
    min: z.number().nullable().optional(),
    max: z.number().nullable().optional(),
    pattern: z.string().nullable().optional(),
  }),
  output: CustomField,
  entities: { consumes: ["custom_field"] },
  example: (f) => ({ fieldId: f.customField().id, required: true }),
  handler: (a, { store }) => {
    const field = mustGet<CustomField>(store, "custom_fields", a.fieldId, "custom field");
    live(field, "have its validation changed");
    atLeastOne(a, ["required", "min", "max", "pattern"]);
    const next = {
      required: a.required ?? field.validation.required,
      min: a.min === undefined ? field.validation.min : a.min,
      max: a.max === undefined ? field.validation.max : a.max,
      pattern: a.pattern === undefined ? field.validation.pattern : a.pattern?.trim() || null,
    };
    if (next.pattern) compile(next.pattern);
    if (next.min != null && next.max != null && next.min > next.max) throw new ActionError("CONFLICT", `min (${next.min}) is greater than max (${next.max}); swap them`);
    if (field.type !== "text" && field.type !== "number" && (next.min != null || next.max != null || next.pattern)) {
      throw new ActionError("INVALID", `min, max and pattern apply to text and number fields; ${field.label} is a ${field.type}`);
    }
    if (field.type === "number" && next.pattern) throw new ActionError("INVALID", "Patterns apply to text fields only");
    if (JSON.stringify(next) === JSON.stringify(field.validation)) throw new ActionError("CONFLICT", `${field.label} already has those validation rules`);
    return store.update<CustomField>("custom_fields", field.id, { validation: next });
  },
});

const addOption = defineAction({
  id: "M10.A07",
  description: "Add a choice to a dropdown. The value is what gets stored; the label is what people see. To stop offering a choice, use M10.A08 Retire dropdown option.",
  risk: "write",
  input: z.strictObject({ fieldId: FieldId, value: z.string().min(1), label: z.string().min(1) }),
  output: CustomField,
  entities: { consumes: ["custom_field"] },
  example: (f) => ({ fieldId: f.customField({ type: "dropdown" }).id, value: "gold", label: "Gold" }),
  handler: (a, { store }) => {
    const field = mustGet<CustomField>(store, "custom_fields", a.fieldId, "custom field");
    live(field, "have an option added");
    dropdown(field, "have options added");
    const existing = field.options.find((o) => o.value === a.value);
    if (existing?.retired) throw new ActionError("CONFLICT", `Option "${existing.label}" is retired and can't be added again`);
    if (existing) throw new ActionError("DUPLICATE", `${field.label} already has an option "${a.value}"`);
    return store.update<CustomField>("custom_fields", field.id, { options: [...field.options, { value: a.value, label: title(a.label), retired: false }] });
  },
});

const retireOption = defineAction({
  id: "M10.A08",
  description: "Retire a dropdown choice so it can't be selected anymore. Records that already use it keep the value. There is no way to un-retire it.",
  risk: "destructive",
  input: z.strictObject({ fieldId: FieldId, value: z.string().min(1) }),
  output: CustomField,
  entities: { consumes: ["custom_field"] },
  example: (f) => ({ fieldId: f.customField({ type: "dropdown", options: [{ value: "old", label: "Old", retired: false }] }).id, value: "old" }),
  handler: (a, { store }) => {
    const field = mustGet<CustomField>(store, "custom_fields", a.fieldId, "custom field");
    live(field, "have an option retired");
    dropdown(field, "have options retired");
    const opt = field.options.find((o) => o.value === a.value);
    if (!opt) throw new ActionError("NOT_FOUND", `${field.label} has no option "${a.value}"`);
    if (opt.retired) throw new ActionError("CONFLICT", `Option "${opt.label}" is already retired`);
    return store.update<CustomField>("custom_fields", field.id, { options: field.options.map((o) => (o.value === opt.value ? { ...o, retired: true } : o)) });
  },
});

const setValue = defineAction({
  id: "M10.A09",
  description: "Set one custom field's value on one record. Checks the field's type, its validation, and refuses a retired dropdown option. To filter on the value later, use a smart list rule cf.<key> (M09.A05). Unlike M01.A04 Update contact details, this sets a custom field the account defined rather than a built-in contact property.",
  risk: "write",
  input: z.strictObject({
    fieldId: FieldId,
    recordId: z.string().describe("id of the contact, lead, deal or company the field belongs to"),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  output: CustomFieldValue,
  siblings: ["M09.A05", "M01.A04"],
  entities: { consumes: ["custom_field"] },
  example: (f) => ({ fieldId: f.customField().id, recordId: f.contact().id, value: "hello" }),
  handler: (a, { store, clock }) => {
    const field = mustGet<CustomField>(store, "custom_fields", a.fieldId, "custom field");
    live(field, "be set");
    mustGet(store, CUSTOM_FIELD_TABLES[field.module], a.recordId, field.module);
    checkValue(field, a.value);
    const now = clock.now().toISOString();
    const existing = store.find<CustomFieldValue>("custom_field_values", (v) => v.fieldId === field.id && v.recordId === a.recordId)[0];
    if (existing && JSON.stringify(existing.value) === JSON.stringify(a.value)) {
      throw new ActionError("CONFLICT", `${field.label} is already set to ${JSON.stringify(a.value)} on that record`);
    }
    if (existing) return store.update<CustomFieldValue>("custom_field_values", existing.id, { value: a.value, updatedAt: now });
    return store.insert("custom_field_values", "cfv", { fieldId: field.id, recordType: field.module, recordId: a.recordId, value: a.value, updatedAt: now });
  },
});

const archiveField = defineAction({
  id: "M10.A10",
  description: "Archive a custom field so new values can't be set and smart lists can't start filtering on it. Values already stored are kept.",
  risk: "destructive",
  input: z.strictObject({ fieldId: FieldId }),
  output: CustomField,
  entities: { consumes: ["custom_field"] },
  example: (f) => ({ fieldId: f.customField().id }),
  handler: ({ fieldId }, { store }) => {
    const field = mustGet<CustomField>(store, "custom_fields", fieldId, "custom field");
    live(field, "be archived");
    const filter = store.find<SmartList>("smart_lists", (s) => s.status === "active" && s.target === field.module && s.rules.some((r) => r.field === `cf.${field.key}`))[0];
    if (filter) throw new ActionError("CONFLICT", `Smart list "${filter.name}" filters on cf.${field.key}; change its rules (M09.A05) before archiving the field`);
    return store.update<CustomField>("custom_fields", field.id, { status: "archived" });
  },
});

export default {
  resolvers: {
    custom_field: tableResolver("custom_fields", "label", {"module":"module","key":"key"}),
  },
  actions: [createField, getField, listFields, renameLabel, updateHelp, setValidation, addOption, retireOption, setValue, archiveField],
} satisfies ModuleExports;
