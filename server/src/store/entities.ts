import type { ZodType } from "zod";
import { Appointment } from "../modules/m21-appointments/schema.js";
import { Availability } from "../modules/m22-availability/schema.js";
import { BlogPost } from "../modules/m38-blogs/schema.js";
import { BookingPage } from "../modules/m23-booking-pages/schema.js";
import { Calendar } from "../modules/m20-calendars/schema.js";
import { Campaign } from "../modules/m15-campaigns/schema.js";
import { Community, CommunityMember, CommunityPost } from "../modules/m43-communities/schema.js";
import { Company } from "../modules/m02-companies/schema.js";
import { Contact } from "../modules/m01-contacts/schema.js";
import { Conversation, OptOut } from "../modules/m11-conversations/schema.js";
import { Coupon } from "../modules/m31-coupons/schema.js";
import { Course } from "../modules/m40-courses/schema.js";
import { CustomField, CustomFieldValue } from "../modules/m10-custom-fields/schema.js";
import { Email } from "../modules/m13-email/schema.js";
import { Enrollment } from "../modules/m42-enrollments/schema.js";
import { Event, EventRegistration } from "../modules/m24-events/schema.js";
import { EventTrigger, TriggerFiring } from "../modules/m17-event-triggers/schema.js";
import { Form, FormSubmission } from "../modules/m18-forms/schema.js";
import { Funnel } from "../modules/m36-funnels/schema.js";
import { Invoice } from "../modules/m28-invoices/schema.js";
import { LandingPage } from "../modules/m37-landing-pages/schema.js";
import { Lead } from "../modules/m03-leads/schema.js";
import { Lesson } from "../modules/m41-lessons/schema.js";
import { Listing } from "../modules/m46-business-listings/schema.js";
import { MediaAsset } from "../modules/m39-media-assets/schema.js";
import { Membership, MembershipPlan } from "../modules/m44-memberships/schema.js";
import { MessageTemplate } from "../modules/m14-message-templates/schema.js";
import { Note } from "../modules/m07-notes/schema.js";
import { Opportunity, Pipeline } from "../modules/m04-opportunities/schema.js";
import { Order } from "../modules/m32-orders/schema.js";
import { Payment, PaymentRequest } from "../modules/m29-payments/schema.js";
import { Price } from "../modules/m26-prices/schema.js";
import { Product } from "../modules/m25-products/schema.js";
import { Quote } from "../modules/m27-quotes/schema.js";
import { Refund } from "../modules/m33-refunds/schema.js";
import { Review, ReviewRequest } from "../modules/m45-reviews/schema.js";
import { SavedReport } from "../modules/m50-reports/schema.js";
import { SmartList } from "../modules/m09-smart-lists/schema.js";
import { Sms } from "../modules/m12-sms/schema.js";
import { Subscription } from "../modules/m30-subscriptions/schema.js";
import { Survey, SurveyResponse } from "../modules/m19-surveys/schema.js";
import { Tag } from "../modules/m08-tags/schema.js";
import { Task } from "../modules/m06-tasks/schema.js";
import { TaxExemption, TaxRule } from "../modules/m34-tax-rules/schema.js";
import { Team } from "../modules/m49-teams/schema.js";
import { Ticket } from "../modules/m47-support-tickets/schema.js";
import { User } from "../modules/m48-users/schema.js";
import { Website } from "../modules/m35-websites/schema.js";
import { Workflow, WorkflowRun } from "../modules/m16-workflows/schema.js";

/**
 * Every table in the store: its id prefix, the module that owns it (the only module that creates its rows),
 * and the schema of a row. Two tables may never share a prefix; entities.test.ts enforces that, and that
 * every insert/make call in the code agrees with this map.
 */
export type EntityDef = { prefix: string; module: string; schema: ZodType };

const e = (prefix: string, module: string, schema: ZodType): EntityDef => ({ prefix, module, schema });

export const ENTITIES = {
  contacts: e("ct", "M01", Contact),
  companies: e("co", "M02", Company),
  leads: e("ld", "M03", Lead),
  opportunities: e("op", "M04", Opportunity),
  pipelines: e("pl", "M05", Pipeline),
  tasks: e("tk", "M06", Task),
  notes: e("nt", "M07", Note),
  tags: e("tg", "M08", Tag),
  smart_lists: e("sl", "M09", SmartList),
  custom_fields: e("cf", "M10", CustomField),
  custom_field_values: e("cfv", "M10", CustomFieldValue),
  conversations: e("cv", "M11", Conversation),
  opt_outs: e("oo", "M11", OptOut),
  sms: e("sm", "M12", Sms),
  emails: e("em", "M13", Email),
  message_templates: e("tpl", "M14", MessageTemplate),
  campaigns: e("cp", "M15", Campaign),
  workflows: e("wf", "M16", Workflow),
  workflow_runs: e("wfr", "M16", WorkflowRun),
  event_triggers: e("trg", "M17", EventTrigger),
  trigger_firings: e("trf", "M17", TriggerFiring),
  forms: e("fm", "M18", Form),
  form_submissions: e("fms", "M18", FormSubmission),
  surveys: e("sv", "M19", Survey),
  survey_responses: e("svr", "M19", SurveyResponse),
  calendars: e("cal", "M20", Calendar),
  appointments: e("ap", "M21", Appointment),
  availability: e("avl", "M22", Availability),
  booking_pages: e("bkp", "M23", BookingPage),
  events: e("ev", "M24", Event),
  event_registrations: e("evr", "M24", EventRegistration),
  products: e("prd", "M25", Product),
  prices: e("prc", "M26", Price),
  quotes: e("qt", "M27", Quote),
  invoices: e("inv", "M28", Invoice),
  payments: e("pay", "M29", Payment),
  payment_requests: e("prq", "M29", PaymentRequest),
  subscriptions: e("sub", "M30", Subscription),
  coupons: e("cou", "M31", Coupon),
  orders: e("ord", "M32", Order),
  refunds: e("rf", "M33", Refund),
  tax_rules: e("tx", "M34", TaxRule),
  tax_exemptions: e("txe", "M34", TaxExemption),
  websites: e("ws", "M35", Website),
  funnels: e("fn", "M36", Funnel),
  landing_pages: e("lp", "M37", LandingPage),
  blog_posts: e("blg", "M38", BlogPost),
  media_assets: e("md", "M39", MediaAsset),
  courses: e("crs", "M40", Course),
  lessons: e("lsn", "M41", Lesson),
  enrollments: e("enr", "M42", Enrollment),
  communities: e("com", "M43", Community),
  community_members: e("cmm", "M43", CommunityMember),
  community_posts: e("cmp", "M43", CommunityPost),
  membership_plans: e("mpl", "M44", MembershipPlan),
  memberships: e("mbr", "M44", Membership),
  review_requests: e("rrq", "M45", ReviewRequest),
  reviews: e("rv", "M45", Review),
  listings: e("bl", "M46", Listing),
  tickets: e("tic", "M47", Ticket),
  users: e("us", "M48", User),
  teams: e("tm", "M49", Team),
  saved_reports: e("rpt", "M50", SavedReport),
} as const satisfies Record<string, EntityDef>;

export type EntityName = keyof typeof ENTITIES;

/** Prefixes used by the store itself. */
export const INTERNAL_PREFIXES = ["fx"] as const;
