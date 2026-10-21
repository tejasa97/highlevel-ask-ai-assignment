// The provider boundary. Everything else (retrieval, validation, execution) is app code.

export type Tier = "fast" | "strong";

export interface PlanRequest {
  tier: Tier;
  system: string; // static; keep byte-identical across requests so prefix caching can hit
  user: string; // rebuilt every turn: <now><context><recent_turns><actions><message>
  schema: object; // JSON Schema the reply must match (submit_plan)
}

export interface Usage {
  input: number; // all prompt tokens, cached ones included
  cachedRead: number;
  cacheWrite: number;
  output: number; // visible output
  thinking: number; // reasoning tokens, when the provider reports them apart from output
  costUsd: number; // at list price
}

export interface PlanResult {
  model: string;
  json: unknown; // parsed reply; still unvalidated
  text: string;
  usage: Usage;
  latencyMs: number;
}

export interface Planner {
  readonly name: string;
  plan(req: PlanRequest): Promise<PlanResult>;
}

export class PlannerError extends Error {
  constructor(
    message: string,
    readonly kind: "rate_limited" | "bad_json" | "provider",
    readonly text?: string,
  ) {
    super(message);
  }
}
