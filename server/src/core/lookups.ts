import type { Step } from "../planner/submit-plan.js";
import type { JsonSchema, Registry } from "../registry/registry.js";
import { argumentAt, argumentEntities, scopedWhere } from "../registry/arguments.js";
import { collectRefs, parseRef, unwrap } from "./refs.js";

// A provider-independent shorthand, lowered to ordinary resolve steps BEFORE normal compilation.
// No reads or writes here, and no picking [0] from a list. The normal executor handles 0/1/many matches.
// { reportId: { $lookup: { entity: "report", name: "Monthly Revenue" } } }

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function lowerLookups(raw: Step[], registry: Registry): { steps: Step[]; errors: string[] } {
  const steps: Step[] = [], errors: string[] = [];
  const ids = new Set(raw.map((s) => s.id));
  // Generated identities must not shadow a reference to a missing/earlier read step either.
  for (const step of raw) {
    const encoded = step.kind === "action" ? [step.argsJson] : step.kind === "resolve" ? [step.whereJson] : [step.whereJson, ...(step.do ?? []).map((c) => c.argsJson)];
    const values: unknown[] = [step];
    for (const json of encoded) if (json) {
      try { values.push(JSON.parse(json)); } catch { /* The ordinary compiler reports malformed JSON. */ }
    }
    for (const value of values) for (const { ref } of collectRefs(value)) {
      const root = parseRef(ref)?.root;
      if (root) ids.add(root);
    }
  }
  let seq = 0;
  const nextId = () => { let id: string; do { id = `lookup_${++seq}`; } while (ids.has(id)); ids.add(id); return id; };
  const lowerCall = (action: string, argsJson: string, at: string): string => {
    let args: unknown;
    try { args = JSON.parse(argsJson); } catch { return argsJson; }
    if (!object(args)) return argsJson;
    const def = registry.get(action);
    if (!def) return argsJson;
    const parsedArgs = args;
    const walk = (value: unknown, schema: JsonSchema, path: string, children: boolean): unknown => {
      schema = unwrap(schema);
      const rule = def.argumentLookups?.[path.replace(/\[\d+\]/g, "[]")];
      if (object(value) && Object.hasOwn(value, "$lookup") && schema.type === "string" && argumentEntities(def, path).length) {
        if (!!rule !== children) return value;
        const lookup = value.$lookup;
        if (Object.keys(value).length !== 1 || !object(lookup) || Object.keys(lookup).some((k) => !["entity", "name", "where"].includes(k)) ||
            typeof lookup.entity !== "string" || typeof lookup.name !== "string" || !lookup.name.trim() ||
            !argumentEntities(def, path).includes(lookup.entity) ||
            (lookup.where !== undefined && (!object(lookup.where) || Object.values(lookup.where).some((v) => typeof v !== "string" || !v.trim())))) {
          errors.push(`${at} arg ${path}: invalid $lookup; use a matching entity and name for an ID field, with optional string-valued where qualifiers`);
          return value;
        }
        try {
          const where = scopedWhere(rule, (lookup.where ?? {}) as Record<string, string>, (parent) => {
            const v = argumentAt(def, parsedArgs, parent).value;
            if (typeof v !== "string" || !v.trim()) throw new Error(`Parent argument ${parent} must be an ID, a backward reference, or a named parent lookup`);
            if (/\$(item|rr)\b/.test(v)) throw new Error("Per-item child lookups cannot be hoisted outside forEach; resolve within a fixed parent instead");
            return v;
          });
          const id = nextId();
          steps.push({ id, kind: "resolve", entity: lookup.entity, name: lookup.name, whereJson: Object.keys(where).length ? JSON.stringify(where) : null });
          return `$${id}.id`;
        } catch (err) {
          errors.push(`${at} arg ${path}: ${(err as Error).message}`);
          return value;
        }
      }
      if (Array.isArray(value) && schema.type === "array") return value.map((v, i) => walk(v, schema.items as JsonSchema, `${path}[${i}]`, children));
      if (object(value) && schema.type === "object") {
        const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
        for (const key of Object.keys(value)) if (Object.hasOwn(props, key)) value[key] = walk(value[key], props[key]!, path ? `${path}.${key}` : key, children);
      }
      return value;
    };
    // Parents lower first regardless of JSON key order; children bind to those exact parent results.
    walk(parsedArgs, def.inputSchema, "", false);
    walk(parsedArgs, def.inputSchema, "", true);
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
