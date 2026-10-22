import { Fixtures, type Input } from "../../store/fixtures.js";
import { Workflow, WorkflowRun } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    workflow(o?: Input<Workflow>): Workflow;
    workflowRun(o?: Input<WorkflowRun>): WorkflowRun;
  }
}

Fixtures.prototype.workflow = function (this: Fixtures, o: Input<Workflow> = {}): Workflow {
  const n = this.seq();
  return this.make("workflows", "wf", Workflow, {
    name: `Workflow ${n}`,
    description: null,
    status: "draft",
    steps: [],
    createdBy: "us_1",
    createdAt: this.now(),
    updatedAt: this.now(),
    publishedAt: null,
    ...o,
  });
};

Fixtures.prototype.workflowRun = function (this: Fixtures, o: Input<WorkflowRun> = {}): WorkflowRun {
  return this.make("workflow_runs", "wfr", WorkflowRun, {
    workflowId: o.workflowId ?? this.workflow().id,
    triggerId: null,
    subject: { type: "contact", id: "ct_1" },
    status: "completed",
    stepResults: [],
    startedAt: this.now(),
    finishedAt: this.now(),
    ...o,
  });
};
