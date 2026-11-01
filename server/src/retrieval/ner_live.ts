/**
 * Gate for the tests that talk to a real NER sidecar. They run only with NER_LIVE_TESTS=1, and only against a sidecar
 * that is ready (/health/ready) and runs this checkout's sidecar code (versions.code starts with the
 * `__version__` in ner-sidecar/service.py). Anything else on NER_SIDECAR_URL is skipped, with the reason.
 */
import { readFileSync } from "node:fs";
import { nerSidecarUrl } from "./ner_client.js";

/** The sidecar code version this checkout ships, e.g. "0.3.0". */
export const expectedSidecarVersion = () => /^__version__ = "([^"]+)"/m.exec(readFileSync(new URL("../../ner-sidecar/service.py", import.meta.url), "utf8"))?.[1] ?? "?";

/** undefined when the live tests may run, else why they are skipped. */
export async function liveSidecarSkip(env: NodeJS.ProcessEnv = process.env, url = nerSidecarUrl(env)): Promise<string | undefined> {
  if (env.NER_LIVE_TESTS !== "1") return "set NER_LIVE_TESTS=1 to run against a live NER sidecar";
  let body: { ready?: boolean; versions?: { code?: string } };
  try {
    const r = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(2000) });
    body = (await r.json()) as typeof body;
    if (!r.ok) return `NER sidecar at ${url} is not ready`;
  } catch (err) {
    return `no NER sidecar at ${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const code = body.versions?.code ?? "";
  const want = expectedSidecarVersion();
  if (code !== want && !code.startsWith(`${want}+`)) return `NER sidecar at ${url} runs code ${code || "(unknown)"}, not ${want}: restart it from this checkout`;
  return undefined;
}
