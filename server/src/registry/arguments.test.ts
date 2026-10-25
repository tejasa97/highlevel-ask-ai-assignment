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
    for (const [path, entities] of Object.entries(action.idTypes ?? {})) {
      assert.equal(argumentAt(action, {}, path).schema.type, "string", `${action.id}: ${path}`);
      for (const entity of entities) assert.ok(registry.resolver(entity), `${action.id}: ${path} → ${entity}`);
    }
    for (const group of action.inputAlternatives ?? []) {
      assert.ok(group.length);
      for (const field of group) assert.ok(Object.hasOwn(action.inputSchema.properties as object, field), `${action.id}: ${field}`);
    }
  }
});

test("ID arguments named for their role (keepId, hostId) name their record type", async () => {
  const registry = await loadRegistry();
  assert.deepEqual(argumentEntities(registry.get("M01.A06")!, "keepId"), ["contact"]);
  assert.deepEqual(argumentEntities(registry.get("M02.A09")!, "duplicateId"), ["company"]);
  assert.deepEqual(argumentEntities(registry.get("M08.A09")!, "targetTagId"), ["tag"]);
  assert.deepEqual(argumentEntities(registry.get("M21.A01")!, "hostId"), ["user"]);
  assert.deepEqual(argumentEntities(registry.get("M07.A03")!, "recordId", { recordType: "lead" }), ["lead"]);
});
