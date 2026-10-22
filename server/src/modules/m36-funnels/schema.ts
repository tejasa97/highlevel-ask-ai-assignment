import { z } from "zod";

export const FunnelStep = z.object({
  id: z.string(),
  name: z.string(),
  /** The landing page (M37) shown at this step. */
  landingPageId: z.string().nullable(),
  /** Simulated traffic: sessions that reached the step and sessions that moved on to the next (or converted, for the last). */
  visits: z.number().int().min(0),
  advanced: z.number().int().min(0),
});
export type FunnelStep = z.infer<typeof FunnelStep>;

export const Funnel = z.object({
  id: z.string(),
  name: z.string(),
  /** In journey order. */
  steps: z.array(FunnelStep),
  goal: z.object({ type: z.enum(["form_submit", "purchase", "booking"]), stepId: z.string() }).nullable(),
  status: z.enum(["draft", "published"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
});
export type Funnel = z.infer<typeof Funnel>;
