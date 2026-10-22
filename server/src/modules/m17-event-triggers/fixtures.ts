import { Fixtures, type Input } from "../../store/fixtures.js";
import { EventTrigger, TriggerFiring } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    eventTrigger(o?: Input<EventTrigger>): EventTrigger;
    triggerFiring(o?: Input<TriggerFiring>): TriggerFiring;
  }
}

Fixtures.prototype.eventTrigger = function (this: Fixtures, o: Input<EventTrigger> = {}): EventTrigger {
  const n = this.seq();
  return this.make("event_triggers", "trg", EventTrigger, {
    name: `Trigger ${n}`,
    eventType: "contact.created",
    conditions: [],
    workflowId: null,
    enabled: false,
    createdBy: "us_1",
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};

Fixtures.prototype.triggerFiring = function (this: Fixtures, o: Input<TriggerFiring> = {}): TriggerFiring {
  return this.make("trigger_firings", "trf", TriggerFiring, {
    triggerId: o.triggerId ?? this.eventTrigger().id,
    eventType: "contact.created",
    payload: {},
    matched: false,
    workflowRunId: null,
    test: true,
    at: this.now(),
    ...o,
  });
};
