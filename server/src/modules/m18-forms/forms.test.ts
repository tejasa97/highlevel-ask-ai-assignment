import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";
import type { Contact } from "../m01-contacts/schema.js";
import type { Form, FormSubmission } from "./schema.js";

const rules = { minLength: null, maxLength: null, pattern: null };

test("unknown input field is INVALID", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M18.A01", { name: "Inquiry", madeUp: 1 })).code, "INVALID");
});

test("write actions refuse a bad call", async () => {
  const w = await testWorld();
  const form = w.f.form({
    name: "Guard",
    fields: [{ id: "field_name", label: "Name", type: "text", required: false, options: [], validation: rules, mapsTo: null }],
  });
  assert.equal(failure(() => w.call("M18.A01", { name: "Guard" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M18.A04", { formId: form.id, label: "Name", type: "text" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M18.A05", { formId: form.id, fieldId: "field_name", label: "Name" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M18.A06", { formId: form.id, fieldIds: ["field_name"] })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M18.A07", { formId: form.id, fieldId: "field_name", minLength: null })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M18.A08", { formId: w.f.form({ name: "Empty" }).id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M18.A09", { formId: form.id, values: { field_name: "Ada" } })).code, "CONFLICT");
});

test("submit accepts only a published form, and an email field matches or creates a contact", async () => {
  const w = await testWorld();
  const fields = [
    { id: "field_email", label: "Email", type: "email" as const, required: true, options: [], validation: rules, mapsTo: "email" },
    { id: "field_first", label: "First", type: "text" as const, required: true, options: [], validation: { ...rules, minLength: 2 }, mapsTo: "firstName" },
    { id: "field_last", label: "Last", type: "text" as const, required: false, options: [], validation: rules, mapsTo: "lastName" },
    { id: "field_phone", label: "Phone", type: "phone" as const, required: false, options: [], validation: rules, mapsTo: "phone" },
  ];
  const draft = w.f.form({ name: "Draft intake", fields });
  const beforeContacts = w.store.all("contacts").length;
  const beforeSubs = w.store.all("form_submissions").length;
  const refused = failure(() => w.call("M18.A09", { formId: draft.id, values: { field_email: "new.person@acme.example", field_first: "New" } }));
  assert.equal(refused.code, "CONFLICT");
  assert.match(refused.message, /draft/);
  assert.equal(w.store.all("contacts").length, beforeContacts);
  assert.equal(w.store.all("form_submissions").length, beforeSubs);

  const published = w.call("M18.A08", { formId: w.f.form({ name: "Intake", fields }).id }) as Form;
  assert.equal(published.status, "published");
  assert.equal(failure(() => w.call("M18.A09", { formId: published.id, values: { field_email: "new.person@acme.example" } })).code, "INVALID");
  assert.equal(failure(() => w.call("M18.A09", { formId: published.id, values: { field_email: "new.person@acme.example", field_first: "N" } })).code, "INVALID");

  const created = w.call("M18.A09", {
    formId: published.id,
    values: { field_email: "New.Person@Acme.example", field_first: "New", field_last: "Person", field_phone: "+15551212" },
  }) as FormSubmission;
  assert.equal(created.formId, published.id);
  assert.ok(created.contactId?.startsWith("ct_"));
  const contact = w.call("M01.A02", { contactId: created.contactId }) as Contact;
  assert.equal(contact.email, "new.person@acme.example");
  assert.equal(contact.firstName, "New");
  assert.equal(contact.lastName, "Person");
  assert.equal(contact.name, "New Person");
  assert.equal(contact.phone, "+15551212");
  assert.equal(contact.company, null);
  assert.equal(contact.companyId, null);
  assert.equal(contact.ownerId, null);
  assert.equal(contact.status, "active");
  assert.equal(contact.mergedInto, null);
  assert.deepEqual(contact.tags, []);
  assert.deepEqual(contact.relationships, []);
  assert.deepEqual(contact.preferences, { email: true, sms: true, call: true, dnd: false });

  const existing = w.f.contact({ email: "Pat@Example.com", firstName: "Pat", lastName: "Old", phone: null });
  const count = w.store.all("contacts").length;
  const matched = w.call("M18.A09", {
    formId: published.id,
    values: { field_email: "pat@example.com", field_first: "Patricia", field_phone: "+15550001" },
  }) as FormSubmission;
  assert.equal(matched.contactId, existing.id);
  assert.equal(w.store.all("contacts").length, count);
  const updated = w.call("M01.A02", { contactId: existing.id }) as Contact;
  assert.equal(updated.firstName, "Patricia");
  assert.equal(updated.name, "Patricia Old");
  assert.equal(updated.phone, "+15550001");

  const listed = w.call("M18.A10", { formId: published.id }) as { total: number; items: { id: string }[] };
  assert.equal(listed.total, 2);
  assert.deepEqual(listed.items.map((item) => item.id).sort(), [created.id, matched.id].sort());
});
