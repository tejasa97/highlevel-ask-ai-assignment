// A plan step in words a person would use: the actions' names, not step ids.
const calls = (cs) => cs.map((c) => `${c.name}${c.args?.title || c.args?.name ? `: ${c.args.title ?? c.args.name}` : ""}`).join(" + ");

export function describeStep(s) {
  switch (s.kind) {
    case "action": return calls(s.calls);
    case "forEach": return `For each: ${calls(s.calls)}`;
    case "resolve": return `Find ${s.entity.replaceAll("_", " ")} "${s.name}"`;
    case "filter": return "Keep the matching records";
    case "exclude": return "Leave out the records that match";
    default: return null;
  }
}

export const STEP_DONE = new Set(["done", "failed", "skipped"]);
