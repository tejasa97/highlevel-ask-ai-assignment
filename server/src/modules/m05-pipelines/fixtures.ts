import { Fixtures } from "../../store/fixtures.js";

// `pipeline()` already lives on the shared fixtures (deals and this module both build pipelines).
// Re-declaring it here would change those defaults, so this module keeps that builder.

void Fixtures;
