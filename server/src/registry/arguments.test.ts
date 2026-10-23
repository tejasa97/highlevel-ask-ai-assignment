import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRef, typeAt, unwrap } from "../core/refs.js";
import { argumentAt, argumentEntities } from "./arguments.js";
import { loadRegistry } from "./registry.js";

test("all module argument bindings and input groups point at implemented schema fields", async () => {
  const registry = await loadRegistry();
  for (const action of registry.list()) {
    for (const [path, binding] of Object.entries(action.argumentLookups ?? {})) {
      const ref = parseRef(`$args.${path.replaceAll("[]", "[0]")}`)!;
      const result = typeAt(action.inputSchema, ref.path, action.id);
      assert.ok("type" in result, `${action.id}: ${path}`);
      assert.equal(unwrap(result.type).type, "string");
      assert.ok(registry.resolver(binding.entity), binding.entity);
      for (const [qualifier, parent] of Object.entries(binding.scope ?? {})) {
        assert.ok(registry.resolver(binding.entity)!.qualifiers?.includes(qualifier));
        assert.equal(argumentAt(action, {}, parent).schema.type, "string");
        assert.ok(argumentEntities(action, parent).some((e) => registry.resolver(e)));
      }
    }
    for (const group of action.inputAlternatives ?? []) {
      assert.ok(group.length);
      for (const field of group) assert.ok(Object.hasOwn(action.inputSchema.properties as object, field), `${action.id}: ${field}`);
    }
  }
});
