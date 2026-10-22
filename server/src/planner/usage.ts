import type { Usage } from "./types.js";

/** Unknown subscription cost must not silently become a zero-dollar total. */
export function sumUsd(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

export function formatCost(costUsd: number | null, billing?: Usage["billing"], digits = 5): string {
  if (billing === "subscription") return "subscription usage (USD unavailable)";
  if (costUsd === null) return "USD unavailable";
  return `$${costUsd.toFixed(digits)}${billing === "api_estimate" ? " (API estimate)" : ""}`;
}
