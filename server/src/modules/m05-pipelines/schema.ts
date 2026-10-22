// Pipelines live in the `pipelines` table and are typed by M04 (opportunities reference them by pipelineId/stageId).
// M05 is the configuration side. A stage that any opportunity still sits in can't be removed.
export { Pipeline } from "../m04-opportunities/schema.js";
