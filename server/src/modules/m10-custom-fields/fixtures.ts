import { Fixtures, type Input } from "../../store/fixtures.js";
import { CustomField, CustomFieldValue } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    customField(o?: Input<CustomField>): CustomField;
    customFieldValue(o?: Input<CustomFieldValue>): CustomFieldValue;
  }
}

Fixtures.prototype.customField = function (this: Fixtures, o: Input<CustomField> = {}): CustomField {
  const n = this.seq();
  return this.make("custom_fields", "cf", CustomField, {
    key: `field_${n}`,
    label: `Field ${n}`,
    helpText: null,
    module: "contact",
    type: "text",
    options: [],
    validation: { required: false, min: null, max: null, pattern: null },
    status: "active",
    createdAt: this.now(),
    ...o,
  });
};

Fixtures.prototype.customFieldValue = function (this: Fixtures, o: Input<CustomFieldValue> = {}): CustomFieldValue {
  const field = o.fieldId ? this.store.get<CustomField>("custom_fields", o.fieldId) : this.customField();
  const recordType = o.recordType ?? field?.module ?? "contact";
  const recordId = o.recordId ?? (recordType === "lead" ? this.lead().id : recordType === "opportunity" ? this.opportunity().id : recordType === "company" ? this.company().id : this.contact().id);
  return this.make("custom_field_values", "cfv", CustomFieldValue, {
    fieldId: field?.id ?? o.fieldId!,
    recordType,
    recordId,
    value: "sample",
    updatedAt: this.now(),
    ...o,
  });
};
