import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { call, registry } from "../testkit.js";
import { DEFAULT_NOW, frozenClock } from "./clock.js";
import { Store } from "./db.js";
import { Fixtures } from "./fixtures.js";
import { seed } from "./seed.js";

test("new domain state, email links and audit survive an actual SQLite close/reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ask-ai-m45-m47-"));
  let store: Store | undefined;
  try {
    const path = join(dir, "validation.db"),
      clock = frozenClock(DEFAULT_NOW),
      reg = await registry();
    store = new Store(path);
    seed(store, clock);
    const w = { store, clock, f: new Fixtures(store, clock) };
    const invoke = (id: string, args: Record<string, unknown>): any =>
      call(reg, w, id, args);
    const req = invoke("M45.A01", {
      contactId: "ct_35",
      subject: "Feedback",
      body: "How was the visit?",
    });
    const sent = invoke("M45.A02", { requestId: req.id });
    const review = invoke("M45.A05", {
      requestId: req.id,
      rating: 4,
      body: "Helpful service",
    });
    invoke("M45.A09", { reviewId: review.id, body: "Thank you" });
    const listing = invoke("M46.A01", {
      name: "Persistent Clinic",
      directory: "google",
      address: "12 File Road",
      phone: "+15550123456",
    });
    invoke("M46.A09", { listingId: listing.id });
    const ticket = invoke("M47.A01", {
      title: "Persistent issue",
      body: "Please help",
      contactId: "ct_35",
    });
    invoke("M47.A08", { ticketId: ticket.id, body: "We will help" });
    const audit = store.audit(),
      expected = store
        .tables()
        .map((table) => [table, store!.all(table)] as const);
    store.close();
    store = new Store(path);
    for (const [table, rows] of expected)
      assert.deepEqual(store.all(table), rows, table);
    assert.deepEqual(store.audit(), audit);
    assert.equal(
      store.get<any>("review_requests", req.id)!.status,
      "fulfilled",
    );
    assert.equal(
      store.get<any>("emails", sent.emailId)!.kind,
      "review_request",
    );
    assert.equal(store.get<any>("tickets", ticket.id)!.status, "in_progress");
    assert.equal(store.get<any>("listings", listing.id)!.publishedVersion, 1);
    assert.equal(
      new Fixtures(store, clock).ticket().id,
      `tic_${Number(ticket.id.split("_")[1]) + 1}`,
    );
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
