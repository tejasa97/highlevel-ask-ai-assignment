import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import {
  contains,
  inDateRange,
  Limit,
  listOf,
  page,
  person,
  personName,
  requirePermission,
  requireState,
} from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import { sendOwnedEmail } from "../m13-email/owned.js";
import { Review, ReviewRequest, REQUEST_STATUSES } from "./schema.js";

const Text = z.string().trim().min(1);
const RequestId = Text.describe("review request id (rrq_…)");
const ReviewId = Text.describe("review id (rv_…)");
const ContactId = Text.describe("contact id (ct_…)");
const request = (s: Store, id: string) =>
  mustGet<ReviewRequest>(s, "review_requests", id, "review request");
const review = (s: Store, id: string) =>
  mustGet<Review>(s, "reviews", id, "review");
const named = <T extends { contactId: string }>(store: Store, r: T) => ({
  ...r,
  reviewerName: personName(store, { contactId: r.contactId, leadId: null }),
});
const Detail = Review.extend({ reviewerName: z.string().nullable() });
const RequestDetail = ReviewRequest.extend({
  reviewerName: z.string().nullable(),
});

const create = defineAction({
  id: "M45.A01",
  description:
    "Create a draft customer review request for a contact. Give subject and body; this does not send an email. Send with M45.A02.",
  risk: "write",
  input: z.strictObject({ contactId: ContactId, subject: Text, body: Text }),
  output: ReviewRequest,
  entities: { produces: "review_request", consumes: ["contact"] },
  example: (f) => ({
    contactId: f.contact().id,
    subject: "Your feedback",
    body: "How did we do?",
  }),
  handler: (a, { store, clock }) => {
    person(store, { contactId: a.contactId }, "receive review requests");
    return store.insert("review_requests", "rrq", {
      ...a,
      status: "draft" as const,
      emailId: null,
      createdAt: clock.now().toISOString(),
      sentAt: null,
      cancelledAt: null,
      fulfilledAt: null,
      reviewId: null,
    });
  },
});
const send = defineAction({
  id: "M45.A02",
  description:
    "Send an existing draft review request by email. Requires requestId from Create/list review requests. Marketing preferences and do-not-disturb apply. This is the only send path for review requests.",
  risk: "external",
  input: z.strictObject({ requestId: RequestId }),
  output: ReviewRequest,
  entities: { produces: "review_request", consumes: ["review_request"] },
  example: (f) => ({ requestId: f.reviewRequest().id }),
  handler: ({ requestId }, ctx) => {
    requirePermission(ctx.store, ctx.actorId, "reputation.manage");
    requirePermission(ctx.store, ctx.actorId, "messaging.send");
    const r = request(ctx.store, requestId);
    requireState("Review request", r.status, ["draft"], "be sent");
    const e = sendOwnedEmail(ctx, { ...r, kind: "review_request" });
    return ctx.store.update<ReviewRequest>("review_requests", r.id, {
      status: "sent",
      emailId: e.id,
      sentAt: ctx.clock.now().toISOString(),
    });
  },
});
const cancel = defineAction({
  id: "M45.A03",
  description:
    "Cancel an unsent draft review request. A sent or fulfilled request cannot be cancelled.",
  risk: "destructive",
  input: z.strictObject({ requestId: RequestId }),
  output: ReviewRequest,
  entities: { consumes: ["review_request"] },
  example: (f) => ({ requestId: f.reviewRequest().id }),
  handler: ({ requestId }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "reputation.manage");
    const r = request(store, requestId);
    requireState("Review request", r.status, ["draft"], "be cancelled");
    return store.update<ReviewRequest>("review_requests", r.id, {
      status: "cancelled",
      cancelledAt: clock.now().toISOString(),
    });
  },
});
const list = defineAction({
  id: "M45.A04",
  description:
    "List customer review requests by contact or draft/sent/cancelled/fulfilled status, newest first. Includes request ids needed to send or cancel.",
  risk: "read",
  input: z.strictObject({
    contactId: ContactId.optional(),
    status: z.enum(REQUEST_STATUSES).optional(),
    limit: Limit,
  }),
  output: listOf(RequestDetail),
  entities: { produces: "review_request" },
  example: () => ({}),
  handler: (a, { store }) =>
    page(
      store
        .find<ReviewRequest>(
          "review_requests",
          (r) =>
            (!a.contactId || r.contactId === a.contactId) &&
            (!a.status || r.status === a.status),
        )
        .sort(
          (x, y) =>
            y.createdAt.localeCompare(x.createdAt) || x.id.localeCompare(y.id),
        )
        .map((r) => named(store, r)),
      a.limit,
    ),
});
const record = defineAction({
  id: "M45.A05",
  description:
    "Record a simulated customer review with an integer rating from 1 to 5 and body. Give a sent requestId, or contactId for an independent review. A request may be fulfilled only once.",
  risk: "write",
  input: z.strictObject({
    requestId: RequestId.optional(),
    contactId: ContactId.optional(),
    rating: z.number().int().min(1).max(5),
    body: Text,
  }),
  output: Review,
  entities: { produces: "review", consumes: ["review_request", "contact"] },
  example: (f) => ({
    contactId: f.contact().id,
    rating: 5,
    body: "Excellent service",
  }),
  handler: (a, { store, clock }) => {
    const r = a.requestId ? request(store, a.requestId) : undefined;
    if (r) {
      requireState("Review request", r.status, ["sent"], "be fulfilled");
      if (
        r.reviewId ||
        store.find<Review>("reviews", (v) => v.requestId === r.id).length
      )
        throw new ActionError("DUPLICATE", "This request already has a review");
    }
    if (r && a.contactId && r.contactId !== a.contactId)
      throw new ActionError(
        "INVALID",
        "The request belongs to another contact",
      );
    const contactId = r?.contactId ?? a.contactId;
    if (!contactId)
      throw new ActionError("INVALID", "Give requestId or contactId");
    person(store, { contactId }, "leave reviews");
    const at = clock.now().toISOString();
    const out = store.insert("reviews", "rv", {
      contactId,
      requestId: r?.id ?? null,
      rating: a.rating,
      body: a.body,
      responseDraft: null,
      publishedResponse: null,
      publishedAt: null,
      createdAt: at,
    });
    if (r)
      store.update("review_requests", r.id, {
        status: "fulfilled",
        reviewId: out.id,
        fulfilledAt: at,
      });
    return out;
  },
});
const search = defineAction({
  id: "M45.A06",
  description:
    "Search customer reviews by contact/reviewer, rating range, date or text. Reviews are not uniquely named; use this to find the right review before responding.",
  risk: "read",
  input: z.strictObject({
    contactId: ContactId.optional(),
    minRating: z.number().int().min(1).max(5).optional(),
    maxRating: z.number().int().min(1).max(5).optional(),
    query: Text.optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: Limit,
  }),
  output: listOf(Detail),
  entities: { produces: "review" },
  example: () => ({ maxRating: 3 }),
  handler: (a, { store }) => {
    if (a.minRating && a.maxRating && a.minRating > a.maxRating)
      throw new ActionError("INVALID", "minRating must not exceed maxRating");
    const rows = store.find<Review>(
      "reviews",
      (r) =>
        (!a.contactId || r.contactId === a.contactId) &&
        (!a.minRating || r.rating >= a.minRating) &&
        (!a.maxRating || r.rating <= a.maxRating) &&
        (!a.query || contains(r.body, a.query)) &&
        inDateRange(r.createdAt, a.from, a.to),
    );
    return page(
      rows
        .sort(
          (x, y) =>
            y.createdAt.localeCompare(x.createdAt) || x.id.localeCompare(y.id),
        )
        .map((r) => named(store, r)),
      a.limit,
    );
  },
});
const get = defineAction({
  id: "M45.A07",
  description:
    "Get one customer review with reviewer, rating, body, response draft and published response.",
  risk: "read",
  input: z.strictObject({ reviewId: ReviewId }),
  output: Detail,
  entities: { consumes: ["review"] },
  example: (f) => ({ reviewId: f.review().id }),
  handler: ({ reviewId }, { store }) => named(store, review(store, reviewId)),
});
const draft = defineAction({
  id: "M45.A08",
  description:
    "Save supplied response text privately on a customer review. Does not publish it; use M45.A09 to make the response public.",
  risk: "write",
  input: z.strictObject({ reviewId: ReviewId, body: Text }),
  output: Review,
  entities: { consumes: ["review"] },
  example: (f) => ({ reviewId: f.review().id, body: "Thank you!" }),
  handler: ({ reviewId, body }, { store }) => {
    const r = review(store, reviewId);
    if (r.publishedAt)
      throw new ActionError(
        "CONFLICT",
        "This review already has a published response",
      );
    if (r.responseDraft === body)
      throw new ActionError("CONFLICT", "The response draft is unchanged");
    return store.update<Review>("reviews", r.id, { responseDraft: body });
  },
});
const publish = defineAction({
  id: "M45.A09",
  description:
    "Publish a customer review response: give reviewId and optional body, or publish its saved response draft. This responds to a review, not a business listing.",
  risk: "external",
  input: z.strictObject({ reviewId: ReviewId, body: Text.optional() }),
  output: Review,
  entities: { consumes: ["review"] },
  example: (f) => ({ reviewId: f.review({ responseDraft: "Thank you!" }).id }),
  handler: ({ reviewId, body }, { store, actorId, clock }) => {
    requirePermission(store, actorId, "reputation.manage");
    const r = review(store, reviewId);
    if (r.publishedAt)
      throw new ActionError(
        "CONFLICT",
        "This review already has a published response",
      );
    const text = body ?? r.responseDraft;
    if (!text)
      throw new ActionError(
        "INVALID",
        "Give body or save a response draft first",
      );
    return store.update<Review>("reviews", r.id, {
      responseDraft: text,
      publishedResponse: text,
      publishedAt: clock.now().toISOString(),
    });
  },
});
const summary = defineAction({
  id: "M45.A10",
  description:
    "Get customer review count, average rating and rating distribution, optionally for one contact. An empty set has count 0 and averageRating null.",
  risk: "read",
  input: z.strictObject({ contactId: ContactId.optional() }),
  output: z.object({
    count: z.number(),
    averageRating: z.number().nullable(),
    distribution: z.array(z.object({ rating: z.number(), count: z.number() })),
  }),
  example: () => ({}),
  handler: ({ contactId }, { store }) => {
    const rows = store.find<Review>(
      "reviews",
      (r) => !contactId || r.contactId === contactId,
    );
    return {
      count: rows.length,
      averageRating: rows.length
        ? Math.round(
            (rows.reduce((s, r) => s + r.rating, 0) / rows.length) * 100,
          ) / 100
        : null,
      distribution: [1, 2, 3, 4, 5].map((rating) => ({
        rating,
        count: rows.filter((r) => r.rating === rating).length,
      })),
    };
  },
});
export default {
  actions: [
    create,
    send,
    cancel,
    list,
    record,
    search,
    get,
    draft,
    publish,
    summary,
  ],
} satisfies ModuleExports;
