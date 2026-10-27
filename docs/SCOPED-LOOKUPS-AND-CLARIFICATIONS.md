# Scoped child lookup and argument-bound clarification

This page covers two follow-on changes. It makes the same interface easier for every planner provider; Luna is a validation model, not a special execution path. It does not add the proposed independent completion verifier, workflow retrieval bundles or broader conversation memory.

## 1. Find the right child under the right parent

**Problem.** A form's “Email” field, a community's “General” channel and a pipeline's “Qualified” stage are not global identities. The same label can exist under several parents. Models previously had to discover the child ID, preserve its relationship and sometimes manufacture an ID-keyed object.

**Change.** Actions can declare `argumentLookups`: the child entity for a concrete argument path and the arguments supplying its scope. Patterns use `[]` for array elements. The compiler resolves parents first, then binds each child to that exact parent, regardless of JSON key order. It lowers everything into the existing resolve/action grammar, rather than creating another executor.

Bindings cover form field update/removal/reorder/submission, community post creation and pipeline stage update/reorder/removal/win probability. New `form_field` and `community_channel` resolvers require a form or community qualifier; stage bindings reuse the existing resolver. Parent-required resolvers are deliberately excluded from global mention scans and wrong-entity hints.

For example, a form submission can now use typed entries:

```json
{
  "formId": {"$lookup": {"entity": "form", "name": "Website inquiry"}},
  "answers": [{
    "fieldId": {"$lookup": {"entity": "form_field", "name": "Email"}},
    "value": "person@example.com"
  }]
}
```

Code supplies the resolved `formId` qualifier for `Email`. It does not search all forms and choose the first result. Zero matches fail; multiple matches ask for clarification; an explicitly contradictory scope is rejected. Generated lookup step IDs reserve reference roots too, so they cannot accidentally shadow a missing or previous read's reference.

**Compatibility and safety.** M18.A09 still accepts the original ID-keyed `values` map. Callers must supply exactly one of `values` or `answers`; duplicate answer fields are refused. The handler normalizes entries into the original validation/contact-linking/storage path. Required fields, publication state, value types, membership rules, permissions, transactions and approval hashes are unchanged. There is no arbitrary dynamic JSON-key interpolation. Child lookups with a per-item variable parent cannot be hoisted out of a `forEach` and are rejected; use an explicit read/plan with a fixed parent instead.

Code: [argument metadata](../server/src/registry/define.ts), [argument utilities](../server/src/registry/arguments.ts), [lowering](../server/src/core/lookups.ts), [forms](../server/src/modules/m18-forms/index.ts), [communities](../server/src/modules/m43-communities/index.ts), [pipelines](../server/src/modules/m05-pipelines/index.ts). Tests: [child lookup](../server/src/core/child-lookups.test.ts), [metadata consistency](../server/src/registry/arguments.test.ts).

## 2. Ask about a missing input, not a model-chosen category

**Problem.** An identity check could be bypassed accidentally when a model labelled “which Sales team?” as a business choice or content question. Looking at the label does not establish whether the application already knows the answer.

**Change.** Every fresh `clarify` reply supplies:

```json
{
  "missing": {
    "action": "M49.A05",
    "argument": "teamId",
    "argsJson": "{\"userId\":\"us_5\"}"
  }
}
```

The action must be offered, the argument must exist in its schema, and it must actually be missing. A required input may be asked for. An unspecified optional field may not. A concrete supplied value needs inspection through the normal read/plan path, not another question. An optional identity explicitly named by the user can still need disambiguation.

`inputAlternatives` describes existing conditional routes, such as an email draft ID versus recipient/subject/body. This prevents questions about another route when a complete one was already supplied. SMS/email actions declare their real existing routes; handlers remain authoritative. Arbitrary conditional handler rules are not automatically inferred.

Named selectors are checked against the argument's entity and scope, irrespective of the old `identity`, `content` or `choice` display label. Real duplicates produce grounded options. A unique, missing or inactive match supplies account facts for one bounded replan. A child question first resolves its parent; ambiguous parents are clarified before any child selection.

If the model omits a selector for an ID question, code scans only that argument's entity for whole-word names in the user's message: first 64 words, spans up to six words and at most eight deduplicated candidate sets. This can ground lowercase names such as “sales” without a capital-letter heuristic. These facts are **not permission to choose a write target**, nor proof that the model understood the request. Long messages, aliases and implicit references remain limitations.

**Bounds and compatibility.** Fresh unbound/invalid clarifications use the existing one-repair allowance, then fail safely. Historical saved replies remain parseable, but old unbound questions are not a runtime bypass. Identity continuation retains its one-replan bound; the overall maximum remains five planner calls with search/read/repair allowances. No retry sends or writes. A clarification must name an applicable action input; this is not a new general-purpose intent-question mechanism. Approval and the user's ticket-subset consent policy are unchanged.

Code: [wire schema](../server/src/planner/submit-plan.ts), [clarification checks](../server/src/planner/clarification.ts), [turn routing](../server/src/planner/turn.ts), [shared instructions](../server/src/planner/prompt.ts). Tests: [clarification](../server/src/planner/clarification.test.ts), [turns](../server/src/planner/turn.test.ts), [HTTP](../server/src/server/app.test.ts).

## Verification and measurement boundaries

Typecheck and all **2,353 deterministic tests** pass; the web build passes. Tests include wrong-parent and duplicate labels, invalid qualifiers, array/nested arguments, lookup ID collisions, genuine ambiguity, optional/supplied inputs, conditional messaging routes, rollback, membership rules and changed-target approval invalidation. No assertions were weakened. Existing scripted clarification fixtures now name the actual required input; unrelated reset/retrieval fixtures use an answer rather than an unbound dummy question.

Seed records, natural-language scenario files/assertions, retrieval questions and frozen reporting data are unchanged. Development retrieval over 365 questions remains **97.6% R@15**, **96.9% all-needed**, **21.8 mean final cards**, zero in-scope false rejections ([raw](../eval/results/retrieval-scoped-inputs-dev-all-20261024.json)); that run records the dirty development checkpoint, not a clean committed-source benchmark. BGE-base, ranking and expansion rules are unchanged.

End-to-end results are in [BENCHMARK.md](../BENCHMARK.md). Existing inspected scenarios are regression/development sets, not a fresh holdout. Deterministic plumbing tests and retrieval recall are not evidence that every model completes every request.

The design follows the [function-calling guidance](https://developers.openai.com/api/docs/guides/function-calling#best-practices-for-defining-functions): explicit schemas and deterministic application-owned work, without provider-specific execution behavior.
