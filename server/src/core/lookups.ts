import type { Step } from "../planner/submit-plan.js";
import type { Registry } from "../registry/registry.js";
import { unwrap } from "./refs.js";

// A provider-independent shorthand, lowered to ordinary resolve steps BEFORE normal compilation.
// No reads or writes here, and no picking [0] from a list. The normal executor handles 0/1/many matches.
// { reportId: { $lookup: { entity: "report", name: "Monthly Revenue" } } }

const ALIASES: Record<string, string[]> = {
  ownerId: ["user"], assigneeId: ["user"], accountManagerId: ["user"], authorId: ["user"], instructorId: ["user"],
  fieldId: ["custom_field"], assetId: ["media_asset"], planId: ["membership_plan"],
  postId: ["blog_post", "community_post"], pageId: ["landing_page"],
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function lowerLookups(raw: Step[], registry: Registry): { steps: Step[]; errors: string[] } {
  const steps: Step[] = [], errors: string[] = [];
  const ids = new Set(raw.map((s) => s.id));
  let seq = 0;
  const nextId = () => { let id: string; do { id = `lookup_${++seq}`; } while (ids.has(id)); ids.add(id); return id; };
  const lowerCall = (action: string, argsJson: string, at: string): string => {
    let args: unknown;
    try { args = JSON.parse(argsJson); } catch { return argsJson; }
    if (!object(args)) return argsJson;
    const def = registry.get(action);
    const fields = (def?.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, value] of Object.entries(args)) {
      if (!object(value) || !Object.hasOwn(value, "$lookup")) continue;
      const lookup = value.$lookup;
      const expected = ALIASES[key] ?? [key.replace(/Id$/, "").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
      if (Object.keys(value).length !== 1 || !object(lookup) || Object.keys(lookup).some((k) => !["entity", "name", "where"].includes(k)) ||
          typeof lookup.entity !== "string" || typeof lookup.name !== "string" || !lookup.name.trim() ||
          (lookup.where !== undefined && (!object(lookup.where) || Object.values(lookup.where).some((v) => typeof v !== "string" || !v.trim()))) ||
          !key.endsWith("Id") || !fields[key] || unwrap(fields[key]!).type !== "string" || !expected.includes(lookup.entity)) {
        errors.push(`${at} arg ${key}: invalid $lookup; use a matching entity and name for an ID field, with optional string-valued where qualifiers`);
        continue;
      }
      const id = nextId();
      steps.push({ id, kind: "resolve", entity: lookup.entity, name: lookup.name, whereJson: lookup.where ? JSON.stringify(lookup.where) : null });
      args[key] = `$${id}.id`;
    }
    return JSON.stringify(args);
  };
  for (const step of raw) {
    if (step.kind === "action") steps.push({ ...step, argsJson: lowerCall(step.action, step.argsJson, `step ${step.id}`) });
    else if (step.kind === "op" && step.do) {
      const calls = step.do.map((c, i) => ({ ...c, argsJson: lowerCall(c.action, c.argsJson, `step ${step.id} do[${i}]`) }));
      steps.push({ ...step, do: calls });
    } else steps.push(step);
  }
  return { steps, errors };
}
