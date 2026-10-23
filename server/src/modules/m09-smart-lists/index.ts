import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { Limit, listOf, page } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import { CustomField, CustomFieldValue } from "../m10-custom-fields/schema.js";
import { FILTER_OPS, FilterRule, SMART_LIST_TABLES, SMART_LIST_TARGETS, SmartList } from "./schema.js";
import "./fixtures.js";

// Saved AND filters over contacts, leads, opportunities and companies. cf.<key> reads custom field values.

const ListId = z.string().describe("smart list id (sl_…)");

const FIELDS: Record<(typeof SMART_LIST_TARGETS)[number], readonly string[]> = {
  contact: ["firstName", "lastName", "name", "email", "phone", "company", "companyId", "ownerId", "status", "tags"],
  lead: ["firstName", "lastName", "name", "email", "phone", "company", "source", "status", "score", "ownerId", "campaignId", "tags"],
  opportunity: ["name", "contactId", "leadId", "pipelineId", "stageId", "value", "ownerId", "status", "expectedCloseDate"],
  company: ["name", "domain", "industry", "size", "phone", "accountManagerId", "status"],
};

const RuleInput = z.strictObject({
  field: z.string().min(1),
  op: z.enum(FILTER_OPS),
  value: z.unknown().optional(),
});

type Row = { id: string; name?: string; status?: string } & Record<string, unknown>;

function title(name: string): string {
  const n = name.trim();
  if (!n) throw new ActionError("INVALID", "Give the list a name");
  return n;
}

function nameTaken(store: Store, name: string, exceptId?: string): SmartList | undefined {
  const n = name.trim().toLowerCase();
  return store.find<SmartList>("smart_lists", (s) => s.id !== exceptId && s.status !== "deleted" && s.name.trim().toLowerCase() === n)[0];
}

function usable(list: SmartList, doing: string): void {
  if (list.status === "deleted") throw new ActionError("CONFLICT", `Smart list "${list.name}" is deleted; create a new one instead of trying to ${doing}`);
}

function fieldDef(store: Store, target: SmartList["target"], key: string): CustomField | undefined {
  return store.find<CustomField>("custom_fields", (f) => f.module === target && f.key === key)[0];
}

function checkRule(store: Store, target: SmartList["target"], rule: FilterRule): void {
  if (rule.field.startsWith("cf.")) {
    const key = rule.field.slice(3);
    if (!key) throw new ActionError("INVALID", "Custom field filters look like cf.<key>");
    const def = fieldDef(store, target, key);
    if (!def) throw new ActionError("CONFLICT", `No ${target} custom field "${key}"; create it with M10.A01 first`);
    if (def.status !== "active") throw new ActionError("CONFLICT", `Custom field "${key}" is archived; pick an active field`);
  } else if (!FIELDS[target].includes(rule.field)) {
    throw new ActionError("INVALID", `${target} records have no field "${rule.field}". Use one of ${FIELDS[target].join(", ")}, or cf.<key>`);
  }
  if (rule.op === "is_empty" || rule.op === "is_not_empty") return;
  if (rule.value === undefined) throw new ActionError("INVALID", `Filter ${rule.field} ${rule.op} needs a value`);
  if (rule.op === "in" && !Array.isArray(rule.value)) throw new ActionError("INVALID", `Filter ${rule.field} with op in needs an array of values`);
}

function checkRules(store: Store, target: SmartList["target"], rules: FilterRule[]): void {
  for (const rule of rules) checkRule(store, target, rule);
}

function valueOf(store: Store, list: SmartList, row: Row, field: string): unknown {
  if (!field.startsWith("cf.")) return row[field];
  const def = fieldDef(store, list.target, field.slice(3));
  if (!def) return undefined;
  return store.find<CustomFieldValue>("custom_field_values", (v) => v.fieldId === def.id && v.recordId === row.id)[0]?.value;
}

function matches(value: unknown, rule: FilterRule): boolean {
  if (rule.op === "is_empty") return value == null || value === "" || (Array.isArray(value) && value.length === 0);
  if (rule.op === "is_not_empty") return !(value == null || value === "" || (Array.isArray(value) && value.length === 0));
  if (value == null || value === "") return rule.op === "neq";
  if (Array.isArray(value)) {
    const tags = value.map(String);
    if (rule.op === "eq") return tags.includes(String(rule.value));
    if (rule.op === "neq") return !tags.includes(String(rule.value));
    if (rule.op === "contains") return tags.some((t) => t.toLowerCase().includes(String(rule.value).toLowerCase()));
    if (rule.op === "in") return tags.some((t) => (rule.value as unknown[]).map(String).includes(t));
    throw new ActionError("INVALID", `Filter op ${rule.op} doesn't apply to a list of tags`);
  }
  if (rule.op === "eq") return value === rule.value;
  if (rule.op === "neq") return value !== rule.value;
  if (rule.op === "contains") return typeof value === "string" && value.toLowerCase().includes(String(rule.value).toLowerCase());
  if (rule.op === "gt" || rule.op === "lt") {
    if (typeof value === "number" && typeof rule.value === "number") return rule.op === "gt" ? value > rule.value : value < rule.value;
    if (typeof value === "string" && typeof rule.value === "string") return rule.op === "gt" ? value > rule.value : value < rule.value;
    throw new ActionError("INVALID", `Filter op ${rule.op} on ${rule.field} needs two numbers or two text values`);
  }
  if (rule.op === "in") return (rule.value as unknown[]).some((v) => v === value);
  return false;
}

function matching(store: Store, list: SmartList): Row[] {
  checkRules(store, list.target, list.rules);
  const items = store.find<Row>(SMART_LIST_TABLES[list.target], (row) => list.rules.every((rule) => matches(valueOf(store, list, row, rule.field), rule)));
  items.sort((x, y) => (x.name ?? "").localeCompare(y.name ?? "") || x.id.localeCompare(y.id));
  return items;
}

function summary(row: Row): { id: string; name: string; status: string | null } {
  return { id: row.id, name: row.name ?? row.id, status: row.status ?? null };
}

const createList = defineAction({
  id: "M09.A01",
  description: "Save an AND filter over contacts, leads, deals or companies. cf.<key> reads a custom field (M10). This stores the rules; it does not search once the way M01.A03 does.",
  risk: "write",
  input: z.strictObject({
    name: z.string().min(1),
    target: z.enum(SMART_LIST_TARGETS),
    rules: z.array(RuleInput).optional(),
  }),
  output: SmartList,
  siblings: ["M01.A03"],
  entities: { produces: "smart_list" },
  example: () => ({ name: "Hot contacts", target: "contact", rules: [{ field: "status", op: "eq", value: "active" }] }),
  handler: (a, { store, clock, actorId }) => {
    const name = title(a.name);
    const dup = nameTaken(store, name);
    if (dup) throw new ActionError("DUPLICATE", `A smart list named "${dup.name}" already exists (${dup.id})`, { existingId: dup.id });
    const rules = a.rules ?? [];
    checkRules(store, a.target, rules);
    const now = clock.now().toISOString();
    return store.insert("smart_lists", "sl", { name, target: a.target, rules, createdBy: actorId ?? "us_1", status: "active" as const, createdAt: now, updatedAt: now });
  },
});

const getList = defineAction({
  id: "M09.A02",
  description: "Get one smart list: its name, the record type it filters and every rule. Deleted lists are still returned.",
  risk: "read",
  input: z.strictObject({ smartListId: ListId }),
  output: SmartList,
  entities: { consumes: ["smart_list"] },
  example: (f) => ({ smartListId: f.smartList().id }),
  handler: ({ smartListId }, { store }) => mustGet<SmartList>(store, "smart_lists", smartListId, "smart list"),
});

const listLists = defineAction({
  id: "M09.A03",
  description: "List saved smart lists by name. Active ones are the default; pass status to include deleted lists. This is the catalog of filters, not the records they match.",
  risk: "read",
  input: z.strictObject({ target: z.enum(SMART_LIST_TARGETS).optional(), status: z.enum(["active", "deleted"]).optional(), limit: Limit }),
  output: listOf(SmartList),
  entities: { produces: "smart_list" },
  example: () => ({}),
  handler: (a, { store }) => {
    const status = a.status ?? "active";
    const items = store.find<SmartList>("smart_lists", (s) => s.status === status && (!a.target || s.target === a.target));
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const renameList = defineAction({
  id: "M09.A04",
  description: "Rename an active smart list. The rules stay the same. To change who it matches, use M09.A05 Update filter rules.",
  risk: "write",
  input: z.strictObject({ smartListId: ListId, name: z.string().min(1) }),
  output: SmartList,
  entities: { consumes: ["smart_list"] },
  example: (f) => ({ smartListId: f.smartList().id, name: "Renamed list" }),
  handler: ({ smartListId, name }, { store, clock }) => {
    const list = mustGet<SmartList>(store, "smart_lists", smartListId, "smart list");
    usable(list, "rename it");
    const next = title(name);
    if (next.toLowerCase() === list.name.trim().toLowerCase()) throw new ActionError("CONFLICT", `"${list.name}" is already called that`);
    const dup = nameTaken(store, next, list.id);
    if (dup) throw new ActionError("DUPLICATE", `A smart list named "${dup.name}" already exists (${dup.id})`, { existingId: dup.id });
    return store.update<SmartList>("smart_lists", list.id, { name: next, updatedAt: clock.now().toISOString() });
  },
});

const updateRules = defineAction({
  id: "M09.A05",
  description: "Replace a smart list's filter rules (they AND together). cf.<key> reads custom field values. To write a value onto a record, use M10.A09 Set record field value.",
  risk: "write",
  input: z.strictObject({ smartListId: ListId, rules: z.array(RuleInput) }),
  output: SmartList,
  siblings: ["M10.A09"],
  entities: { consumes: ["smart_list", "custom_field"] },
  example: (f) => ({ smartListId: f.smartList().id, rules: [{ field: "status", op: "eq", value: "active" }] }),
  handler: ({ smartListId, rules }, { store, clock }) => {
    const list = mustGet<SmartList>(store, "smart_lists", smartListId, "smart list");
    usable(list, "change its rules");
    checkRules(store, list.target, rules);
    if (JSON.stringify(rules) === JSON.stringify(list.rules)) throw new ActionError("CONFLICT", `"${list.name}" already has those rules`);
    return store.update<SmartList>("smart_lists", list.id, { rules, updatedAt: clock.now().toISOString() });
  },
});

const Hit = z.object({ id: z.string(), name: z.string(), status: z.string().nullable() });

const preview = defineAction({
  id: "M09.A06",
  description: "Show the records that match a smart list right now, by name. The total counts every match, not just the page. Unlike M01.A03, the rules are the ones saved on the list.",
  risk: "read",
  input: z.strictObject({ smartListId: ListId, limit: Limit }),
  output: z.object({ listId: z.string(), target: z.enum(SMART_LIST_TARGETS), items: z.array(Hit), total: z.number() }),
  siblings: ["M01.A03"],
  entities: { consumes: ["smart_list"] },
  example: (f) => ({ smartListId: f.smartList({ rules: [{ field: "status", op: "eq", value: "active" }] }).id }),
  handler: ({ smartListId, limit }, { store }) => {
    const list = mustGet<SmartList>(store, "smart_lists", smartListId, "smart list");
    usable(list, "preview it");
    const items = matching(store, list).map(summary);
    const paged = page(items, limit);
    return { listId: list.id, target: list.target, ...paged };
  },
});

const countMatches = defineAction({
  id: "M09.A07",
  description: "Count how many records match a smart list right now, without returning them. Use M09.A06 Preview matching records to see who they are.",
  risk: "read",
  input: z.strictObject({ smartListId: ListId }),
  output: z.object({ listId: z.string(), count: z.number() }),
  entities: { consumes: ["smart_list"] },
  example: (f) => ({ smartListId: f.smartList({ rules: [{ field: "status", op: "eq", value: "active" }] }).id }),
  handler: ({ smartListId }, { store }) => {
    const list = mustGet<SmartList>(store, "smart_lists", smartListId, "smart list");
    usable(list, "count it");
    return { listId: list.id, count: matching(store, list).length };
  },
});

const exportMatches = defineAction({
  id: "M09.A08",
  description: "Return the records that match a smart list, with the fields the filter can see (including cf.<key> values). Nothing is emailed. The total counts every match.",
  risk: "read",
  input: z.strictObject({ smartListId: ListId, limit: Limit }),
  output: z.object({
    listId: z.string(),
    target: z.enum(SMART_LIST_TARGETS),
    items: z.array(z.object({ id: z.string(), name: z.string(), fields: z.record(z.string(), z.unknown()) })),
    total: z.number(),
  }),
  entities: { consumes: ["smart_list"] },
  example: (f) => ({ smartListId: f.smartList({ rules: [{ field: "status", op: "eq", value: "active" }] }).id }),
  handler: ({ smartListId, limit }, { store }) => {
    const list = mustGet<SmartList>(store, "smart_lists", smartListId, "smart list");
    usable(list, "export it");
    const rows = matching(store, list);
    const defs = store.find<CustomField>("custom_fields", (f) => f.module === list.target);
    const items = rows.map((row) => {
      const fields: Record<string, unknown> = {};
      for (const key of FIELDS[list.target]) fields[key] = row[key] ?? null;
      for (const def of defs) {
        const value = store.find<CustomFieldValue>("custom_field_values", (v) => v.fieldId === def.id && v.recordId === row.id)[0]?.value;
        if (value !== undefined) fields[`cf.${def.key}`] = value;
      }
      return { id: row.id, name: row.name ?? row.id, fields };
    });
    const paged = page(items, limit);
    return { listId: list.id, target: list.target, ...paged };
  },
});

const duplicateList = defineAction({
  id: "M09.A09",
  description: "Copy an existing smart list's rules into a new active list. The original is left alone. Pass a name when \"Copy of …\" is already taken.",
  risk: "write",
  input: z.strictObject({ smartListId: ListId, name: z.string().min(1).optional() }),
  output: SmartList,
  entities: { consumes: ["smart_list"], produces: "smart_list" },
  example: (f) => ({ smartListId: f.smartList().id }),
  handler: ({ smartListId, name }, { store, clock, actorId }) => {
    const list = mustGet<SmartList>(store, "smart_lists", smartListId, "smart list");
    const next = title(name ?? `Copy of ${list.name}`);
    const dup = nameTaken(store, next);
    if (dup) throw new ActionError("DUPLICATE", `A smart list named "${dup.name}" already exists (${dup.id}); pass a different name`, { existingId: dup.id });
    const now = clock.now().toISOString();
    return store.insert("smart_lists", "sl", {
      name: next,
      target: list.target,
      rules: list.rules,
      createdBy: actorId ?? "us_1",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const deleteList = defineAction({
  id: "M09.A10",
  description: "Delete a smart list. The records it matched are not touched. A deleted list can still be read, but not renamed or previewed.",
  risk: "destructive",
  input: z.strictObject({ smartListId: ListId }),
  output: SmartList,
  entities: { consumes: ["smart_list"] },
  example: (f) => ({ smartListId: f.smartList().id }),
  handler: ({ smartListId }, { store, clock }) => {
    const list = mustGet<SmartList>(store, "smart_lists", smartListId, "smart list");
    usable(list, "delete it");
    return store.update<SmartList>("smart_lists", list.id, { status: "deleted", updatedAt: clock.now().toISOString() });
  },
});

export default {
  actions: [createList, getList, listLists, renameList, updateRules, preview, countMatches, exportMatches, duplicateList, deleteList],
} satisfies ModuleExports;
