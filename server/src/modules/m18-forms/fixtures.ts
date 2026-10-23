import { Fixtures, type Input } from "../../store/fixtures.js";
import { Form, FormSubmission } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    form(o?: Input<Form>): Form;
    formSubmission(o?: Input<FormSubmission>): FormSubmission;
  }
}

Fixtures.prototype.form = function (this: Fixtures, o: Input<Form> = {}): Form {
  const n = this.seq();
  return this.make("forms", "fm", Form, {
    name: `Form ${n}`,
    fields: [],
    status: "draft",
    createdAt: this.now(),
    updatedAt: this.now(),
    publishedAt: null,
    ...o,
  });
};

Fixtures.prototype.formSubmission = function (this: Fixtures, o: Input<FormSubmission> = {}): FormSubmission {
  return this.make("form_submissions", "fms", FormSubmission, {
    formId: o.formId ?? this.form().id,
    values: {},
    contactId: null,
    submittedAt: this.now(),
    ...o,
  });
};
