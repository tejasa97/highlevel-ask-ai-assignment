import { Fixtures, type Input } from "../../store/fixtures.js";
import { MessageTemplate } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    messageTemplate(o?: Input<MessageTemplate>): MessageTemplate;
  }
}

Fixtures.prototype.messageTemplate = function (this: Fixtures, o: Input<MessageTemplate> = {}): MessageTemplate {
  const n = this.seq();
  return this.make("message_templates", "tpl", MessageTemplate, {
    name: `Template ${n}`,
    channel: "email",
    subject: "Hello",
    body: "Hi {{firstName}}",
    variables: [{ name: "firstName", required: true, sample: "Ada" }],
    version: 1,
    versions: [],
    status: "active",
    createdBy: "us_1",
    updatedBy: "us_1",
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};
