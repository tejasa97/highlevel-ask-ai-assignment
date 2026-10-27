// The provider boundary. Everything else (retrieval, validation, execution) is app code.

export type Tier = "fast" | "strong";

export interface PlanRequest {
  tier: Tier;
  system: string; // static; keep byte-identical across requests so prefix caching can hit
  user: string; // rebuilt every turn: <now><context><recent_turns><actions><message>
  schema: object; // JSON Schema the reply must match (submit_plan)
  signal?: AbortSignal; // aborted when the caller stops waiting; the provider should drop the call
}

export interface Usage {
  input: number; // all prompt tokens, cached ones included
  cachedRead: number;
  cacheWrite: number;
  output: number; // visible output
  thinking: number; // reasoning tokens, when the provider reports them apart from output
  billing: "api" | "subscription" | "api_estimate" | "none";
  costUsd: number | null; // list-price estimate, or unknown for subscription usage
}

export interface PlanResult {
  model: string;
  json: unknown; // parsed reply; still unvalidated
  text: string;
  usage: Usage;
  latencyMs: number; // wall clock, as the caller waited
  /** Requests sent to the model provider, the provider's own retries included; defaults to 1. */
  attempts?: number;
  /** Model requests behind this reply, when the provider makes more than one (an agent CLI's tool turns). */
  modelCalls?: number;
  /** Time the provider spent in model requests, when it reports it: latencyMs minus this is client overhead. */
  apiMs?: number;
}

export interface Planner {
  readonly name: string;
  readonly billing?: Usage["billing"]; // how every reply bills; "subscription" means USD stays unknown
  readonly models?: Record<Tier, string>; // the model per tier, when the provider fixes it up front
  plan(req: PlanRequest): Promise<PlanResult>;
}

export class PlannerError extends Error {
  constructor(
    message: string,
    readonly kind: "rate_limited" | "bad_json" | "provider" | "timeout",
    readonly text?: string,
  ) {
    super(message);
  }
}
