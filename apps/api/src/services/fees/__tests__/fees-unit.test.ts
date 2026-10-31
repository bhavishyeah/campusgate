import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PaiseAmount } from "@campusgate/shared";
import {
  RazorpayGateway,
  type RazorpaySdkLike,
} from "../razorpay.js";
import {
  planAllocation,
  computeOutstanding,
  chargeOutstanding,
  nextChargeStatus,
  compareChargesForAllocation,
  formatReceiptNumber,
  institutionShort,
  type ChargeForAllocation,
} from "../allocation.js";

/**
 * FEAT-004 fast/mocked unit suite for the Phase-7 fees spine (design §D.17).
 * No DB, no network — every money value is BigInt in-process and a decimal
 * STRING on any JSON boundary. Runs under `npm test -w @campusgate/api`.
 */

const KEY_SECRET = "test_key_secret";
const WEBHOOK_SECRET = "test_webhook_secret";

function gatewayWithStub(sdk?: Partial<RazorpaySdkLike>): RazorpayGateway {
  const stub: RazorpaySdkLike = {
    orders: {
      create: sdk?.orders?.create ?? (vi.fn() as RazorpaySdkLike["orders"]["create"]),
      fetch: sdk?.orders?.fetch ?? (vi.fn() as RazorpaySdkLike["orders"]["fetch"]),
      fetchPayments:
        sdk?.orders?.fetchPayments ?? (vi.fn() as RazorpaySdkLike["orders"]["fetchPayments"]),
    },
  };
  return new RazorpayGateway({
    keyId: "rzp_test_key",
    keySecret: KEY_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    sdk: stub,
  });
}

// ─── HMAC signature verification (valid / invalid / constant-time) ────────────

describe("RazorpayGateway signature verification (Node crypto)", () => {
  const gw = gatewayWithStub();

  it("verifyPaymentSignature accepts a correct HMAC over order_id|payment_id", () => {
    const orderId = "order_abc";
    const paymentId = "pay_xyz";
    const good = crypto
      .createHmac("sha256", KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    expect(gw.verifyPaymentSignature(orderId, paymentId, good)).toBe(true);
  });

  it("verifyPaymentSignature rejects a tampered signature", () => {
    const orderId = "order_abc";
    const paymentId = "pay_xyz";
    const bad = crypto
      .createHmac("sha256", "wrong_secret")
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    expect(gw.verifyPaymentSignature(orderId, paymentId, bad)).toBe(false);
  });

  it("verifyPaymentSignature rejects a length-mismatched signature (constant-time guard)", () => {
    // A shorter string must not throw from timingSafeEqual — it is simply "not equal".
    expect(gw.verifyPaymentSignature("order", "pay", "deadbeef")).toBe(false);
    expect(gw.verifyPaymentSignature("order", "pay", "")).toBe(false);
  });

  it("verifyWebhookSignature accepts a correct HMAC over the exact raw body bytes", () => {
    const raw = Buffer.from(JSON.stringify({ event: "payment.captured" }), "utf8");
    const good = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    expect(gw.verifyWebhookSignature(raw, good)).toBe(true);
  });

  it("verifyWebhookSignature rejects a bad or absent signature", () => {
    const raw = Buffer.from("{}", "utf8");
    const wrong = crypto.createHmac("sha256", "nope").update(raw).digest("hex");
    expect(gw.verifyWebhookSignature(raw, wrong)).toBe(false);
    expect(gw.verifyWebhookSignature(raw, undefined)).toBe(false);
  });
});

// ─── Webhook field extraction from the nested payload + headers (HIGH-1) ──────

/** Mirror of the webhook's extraction logic (razorpay-webhook.ts §b). */
function extractWebhookFields(rawBody: Buffer) {
  const evt = JSON.parse(rawBody.toString("utf8"));
  const eventType: string = evt?.event ?? "";
  const paymentEntity = evt?.payload?.payment?.entity;
  const orderEntity = evt?.payload?.order?.entity;
  const razorpayOrderId: string | undefined = paymentEntity?.order_id ?? orderEntity?.id;
  const razorpayPaymentId: string | null = paymentEntity?.id ?? null;
  return { eventType, razorpayOrderId, razorpayPaymentId };
}

describe("webhook field extraction (HIGH-1 — nested entity, not top-level)", () => {
  it("payment event: order id from payload.payment.entity.order_id, payment id from .id", () => {
    const raw = Buffer.from(
      JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_1", order_id: "order_1" } } },
      }),
    );
    const f = extractWebhookFields(raw);
    expect(f.eventType).toBe("payment.captured");
    expect(f.razorpayOrderId).toBe("order_1");
    expect(f.razorpayPaymentId).toBe("pay_1");
  });

  it("order event: order id from payload.order.entity.id, payment id null", () => {
    const raw = Buffer.from(
      JSON.stringify({
        event: "order.paid",
        payload: { order: { entity: { id: "order_2" } } },
      }),
    );
    const f = extractWebhookFields(raw);
    expect(f.eventType).toBe("order.paid");
    expect(f.razorpayOrderId).toBe("order_2");
    expect(f.razorpayPaymentId).toBeNull();
  });

  it("unresolvable payload: order id is undefined (webhook 200-no-ops)", () => {
    const raw = Buffer.from(JSON.stringify({ event: "payment.failed", payload: {} }));
    const f = extractWebhookFields(raw);
    expect(f.razorpayOrderId).toBeUndefined();
  });
});

// ─── BigInt→Number boundary guard (HIGH-2) ────────────────────────────────────

describe("createOrder BigInt→Number boundary guard (HIGH-2)", () => {
  it("rejects 0 paise", async () => {
    const gw = gatewayWithStub();
    await expect(gw.createOrder({ amountPaise: 0n, currency: "INR" })).rejects.toThrow(/out of range/);
  });

  it("rejects an amount > Number.MAX_SAFE_INTEGER", async () => {
    const gw = gatewayWithStub();
    const over = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    await expect(gw.createOrder({ amountPaise: over, currency: "INR" })).rejects.toThrow(/out of range/);
  });

  it("accepts a realistic amount and passes a lossless Number to the SDK", async () => {
    const create = vi.fn().mockResolvedValue({ id: "order_ok", status: "created", amount_paid: 0, amount_due: 5000000 });
    const gw = gatewayWithStub({ orders: { create } as unknown as RazorpaySdkLike["orders"] });
    const result = await gw.createOrder({ amountPaise: 5000000n, currency: "INR" });
    expect(result.id).toBe("order_ok");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ amount: 5000000, currency: "INR" }));
    // The amount passed is a Number exactly equal to the BigInt (lossless).
    const passed = create.mock.calls[0][0].amount;
    expect(typeof passed).toBe("number");
    expect(BigInt(passed)).toBe(5000000n);
  });

  it("accepts exactly Number.MAX_SAFE_INTEGER paise (boundary is inclusive)", async () => {
    const create = vi.fn().mockResolvedValue({ id: "order_max", status: "created", amount_paid: 0, amount_due: 0 });
    const gw = gatewayWithStub({ orders: { create } as unknown as RazorpaySdkLike["orders"] });
    await gw.createOrder({ amountPaise: BigInt(Number.MAX_SAFE_INTEGER), currency: "INR" });
    expect(create.mock.calls[0][0].amount).toBe(Number.MAX_SAFE_INTEGER);
  });
});

// ─── Allocation math in BigInt (oldest-due-first, partial/full, over/under) ───

function charge(
  id: string,
  amountPaise: bigint,
  allocatedPaise: bigint,
  dueDate: Date | null,
  postedAt: Date,
): ChargeForAllocation {
  return { id, amountPaise, allocatedPaise, dueDate, postedAt };
}

describe("planAllocation (BigInt, oldest-due-first)", () => {
  const d1 = new Date("2026-01-01T00:00:00Z");
  const d2 = new Date("2026-02-01T00:00:00Z");
  const posted = new Date("2026-01-01T00:00:00Z");

  it("full payment covers a single charge → PAID, no remainder", () => {
    const plan = planAllocation(1000n, [charge("c1", 1000n, 0n, d1, posted)]);
    expect(plan.allocatedTotal).toBe(1000n);
    expect(plan.unallocatedRemainder).toBe(0n);
    expect(plan.allocations).toEqual([
      { studentChargeId: "c1", amountPaise: 1000n, nextStatus: "PAID" },
    ]);
  });

  it("partial payment on a single charge → PARTIALLY_PAID", () => {
    const plan = planAllocation(400n, [charge("c1", 1000n, 0n, d1, posted)]);
    expect(plan.allocatedTotal).toBe(400n);
    expect(plan.allocations[0]).toEqual({
      studentChargeId: "c1",
      amountPaise: 400n,
      nextStatus: "PARTIALLY_PAID",
    });
  });

  it("allocates oldest-due-first across multiple charges", () => {
    const plan = planAllocation(1500n, [
      charge("late", 1000n, 0n, d2, posted),
      charge("early", 1000n, 0n, d1, posted),
    ]);
    // 'early' (earlier dueDate) is filled first to PAID, then 'late' partial.
    expect(plan.allocations[0].studentChargeId).toBe("early");
    expect(plan.allocations[0].nextStatus).toBe("PAID");
    expect(plan.allocations[1].studentChargeId).toBe("late");
    expect(plan.allocations[1].amountPaise).toBe(500n);
    expect(plan.allocations[1].nextStatus).toBe("PARTIALLY_PAID");
  });

  it("overpayment leaves the remainder unallocated (slice-7.1 credit)", () => {
    const plan = planAllocation(1500n, [charge("c1", 1000n, 0n, d1, posted)]);
    expect(plan.allocatedTotal).toBe(1000n);
    expect(plan.unallocatedRemainder).toBe(500n);
    expect(plan.allocations).toHaveLength(1);
  });

  it("all targets already satisfied → allocate nothing, full remainder", () => {
    const plan = planAllocation(1000n, [charge("c1", 1000n, 1000n, d1, posted)]);
    expect(plan.allocations).toHaveLength(0);
    expect(plan.allocatedTotal).toBe(0n);
    expect(plan.unallocatedRemainder).toBe(1000n);
  });

  it("invariant: sum(allocations) <= amount for every plan", () => {
    const plan = planAllocation(1200n, [
      charge("c1", 500n, 0n, d1, posted),
      charge("c2", 500n, 0n, d2, posted),
    ]);
    expect(plan.allocatedTotal).toBeLessThanOrEqual(1200n);
    const sum = plan.allocations.reduce((a, x) => a + x.amountPaise, 0n);
    expect(sum).toBe(plan.allocatedTotal);
  });

  it("NULLS LAST: a dated charge is allocated before an undated one", () => {
    const plan = planAllocation(1000n, [
      charge("undated", 1000n, 0n, null, posted),
      charge("dated", 1000n, 0n, d1, posted),
    ]);
    expect(plan.allocations[0].studentChargeId).toBe("dated");
  });
});

describe("outstanding + status helpers (BigInt)", () => {
  it("chargeOutstanding floors at 0 (overpaid charge)", () => {
    expect(chargeOutstanding({ amountPaise: 1000n, allocatedPaise: 1200n })).toBe(0n);
    expect(chargeOutstanding({ amountPaise: 1000n, allocatedPaise: 300n })).toBe(700n);
  });

  it("computeOutstanding = sum(charges) - sum(allocations), floored at 0", () => {
    const out = computeOutstanding(
      [
        { id: "c1", amountPaise: 1000n },
        { id: "c2", amountPaise: 2000n },
      ],
      [
        { studentChargeId: "c1", amountPaise: 1000n },
        { studentChargeId: "c2", amountPaise: 500n },
      ],
    );
    expect(out).toBe(1500n);
  });

  it("nextChargeStatus maps outstanding to the forward-only status", () => {
    expect(nextChargeStatus(0n)).toBe("PAID");
    expect(nextChargeStatus(-5n)).toBe("PAID");
    expect(nextChargeStatus(1n)).toBe("PARTIALLY_PAID");
  });

  it("compareChargesForAllocation sorts dueDate ASC, then postedAt ASC, then id", () => {
    const d1 = new Date("2026-01-01");
    const d2 = new Date("2026-02-01");
    const p = new Date("2026-01-01");
    const list = [
      charge("b", 1n, 0n, d2, p),
      charge("a", 1n, 0n, d1, p),
      charge("c", 1n, 0n, null, p),
    ];
    const sorted = [...list].sort(compareChargesForAllocation);
    expect(sorted.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});

// ─── Money-as-string JSON serialization ───────────────────────────────────────

describe("money crosses JSON as a decimal string of paise (§D.1)", () => {
  const money = (v: bigint): string => v.toString();

  it("serializes a BigInt amount to a decimal string, never a JSON number", () => {
    const body = { amountPaise: money(5000000n), currency: "INR" };
    const json = JSON.stringify(body);
    expect(json).toContain('"amountPaise":"5000000"');
    const parsed = JSON.parse(json);
    expect(typeof parsed.amountPaise).toBe("string");
    expect(BigInt(parsed.amountPaise)).toBe(5000000n);
  });

  it("preserves a large value beyond Number precision as a string", () => {
    const big = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    const s = money(big);
    expect(BigInt(s)).toBe(big);
  });
});

// ─── Charge-status transition logic (slice-1 historical / superseded by 7.1) ──
// This exercises a PURE in-test mirror of the ORIGINAL slice-1 forward-only
// student_charges_guard rule. Slice 7.1 (design §E.1) RELAXED that guard: status
// is now a pure projection of the append-only ledger (a refund legitimately
// moves a charge PAID→PARTIALLY_PAID/PENDING), so the DB no longer enforces
// forward-only. The mirror is KEPT, re-documented, as a record of why slice 1
// chose forward-only and why 7.1 supersedes it. It does NOT hit the DB and is
// not the live rule — see ledger.computeChargeStatus for the current authority.

/** Mirror of the HISTORICAL slice-1 forward-only rule (superseded by §E.1). */
function isLegalChargeTransition(oldS: string, newS: string): boolean {
  if (oldS === newS) return true;
  if (oldS === "PENDING") return newS === "PARTIALLY_PAID" || newS === "PAID";
  if (oldS === "PARTIALLY_PAID") return newS === "PAID";
  return false;
}

describe("charge-status transition logic (slice-1 historical / superseded by 7.1 ledger projection)", () => {
  it("allows PENDING→PARTIALLY_PAID→PAID and self-transitions", () => {
    expect(isLegalChargeTransition("PENDING", "PARTIALLY_PAID")).toBe(true);
    expect(isLegalChargeTransition("PENDING", "PAID")).toBe(true);
    expect(isLegalChargeTransition("PARTIALLY_PAID", "PAID")).toBe(true);
    expect(isLegalChargeTransition("PAID", "PAID")).toBe(true);
  });

  it("rejects reverse transitions", () => {
    expect(isLegalChargeTransition("PAID", "PENDING")).toBe(false);
    expect(isLegalChargeTransition("PAID", "PARTIALLY_PAID")).toBe(false);
    expect(isLegalChargeTransition("PARTIALLY_PAID", "PENDING")).toBe(false);
  });
});

// ─── Receipt number / sequence format ─────────────────────────────────────────

describe("receipt-number / sequence format (§D.2 NIT-3)", () => {
  it("formats RCPT-<short>-<YYYY>-<zero-padded 6>", () => {
    const n = formatReceiptNumber("ESCAPE_TEST_inst_A", 2026, 7);
    expect(n).toMatch(/^RCPT-[A-Z0-9]+-2026-000007$/);
  });

  it("institutionShort is a stable uppercase token of the last chars", () => {
    expect(institutionShort("cuid_abc123def")).toBe(institutionShort("cuid_abc123def"));
    expect(institutionShort("cuid_abc123def")).toMatch(/^[A-Z0-9]+$/);
  });

  it("the padded sequence preserves monotonic ordering as a number", () => {
    const a = formatReceiptNumber("inst", 2026, 1);
    const b = formatReceiptNumber("inst", 2026, 2);
    expect(a < b).toBe(true); // lexicographic order matches numeric order (zero-padded)
  });
});

// ─── PaiseAmount Zod schema ────────────────────────────────────────────────────

describe("PaiseAmount schema (single money-input rule, §D.1)", () => {
  it("accepts a positive integer-paise string and transforms to BigInt", () => {
    const parsed = PaiseAmount.parse("5000000");
    expect(parsed).toBe(5000000n);
    expect(typeof parsed).toBe("bigint");
  });

  it('rejects "0"', () => {
    expect(PaiseAmount.safeParse("0").success).toBe(false);
  });

  it("rejects a leading zero", () => {
    expect(PaiseAmount.safeParse("0500").success).toBe(false);
  });

  it("rejects a decimal", () => {
    expect(PaiseAmount.safeParse("100.50").success).toBe(false);
  });

  it("rejects a signed value", () => {
    expect(PaiseAmount.safeParse("-100").success).toBe(false);
    expect(PaiseAmount.safeParse("+100").success).toBe(false);
  });

  it("rejects non-numeric input", () => {
    expect(PaiseAmount.safeParse("abc").success).toBe(false);
    expect(PaiseAmount.safeParse("1e5").success).toBe(false);
  });

  it("rejects a value > Number.MAX_SAFE_INTEGER", () => {
    const over = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
    expect(PaiseAmount.safeParse(over).success).toBe(false);
  });

  it("rejects a JSON-number input (money is never a JSON number)", () => {
    expect(PaiseAmount.safeParse(5000000 as unknown).success).toBe(false);
  });
});

// ─── Razorpay service with a mocked SDK (order create + reconcile reads) ──────

describe("RazorpayGateway with a mocked SDK (order create + reconcile reads)", () => {
  it("createOrder forwards currency/receipt/notes to the SDK", async () => {
    const create = vi.fn().mockResolvedValue({ id: "order_z", status: "created", amount_paid: 0, amount_due: 100 });
    const gw = gatewayWithStub({ orders: { create } as unknown as RazorpaySdkLike["orders"] });
    await gw.createOrder({ amountPaise: 100n, currency: "INR", receipt: "r1", notes: { a: "b" } });
    expect(create).toHaveBeenCalledWith({
      amount: 100,
      currency: "INR",
      receipt: "r1",
      notes: { a: "b" },
    });
  });

  it("fetchOrder returns the order entity", async () => {
    const fetch = vi.fn().mockResolvedValue({ id: "order_z", status: "paid", amount_paid: 100, amount_due: 0 });
    const gw = gatewayWithStub({ orders: { fetch } as unknown as RazorpaySdkLike["orders"] });
    const o = await gw.fetchOrder("order_z");
    expect(o.status).toBe("paid");
  });

  it("fetchOrderPayments returns the items array", async () => {
    const fetchPayments = vi.fn().mockResolvedValue({
      entity: "collection",
      count: 1,
      items: [{ id: "pay_1", order_id: "order_z", status: "captured", amount: 100 }],
    });
    const gw = gatewayWithStub({ orders: { fetchPayments } as unknown as RazorpaySdkLike["orders"] });
    const items = await gw.fetchOrderPayments("order_z");
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("captured");
  });
});

// ─── Fail-closed role probe (webhook lookup client must bypass RLS) ───────────

describe("webhook fail-closed role probe (§D.8 MEDIUM-2)", () => {
  it("throws when the lookup client is an RLS-subject role (rolbypassrls = false)", async () => {
    const Fastify = (await import("fastify")).default;
    const { razorpayWebhookRoutes } = await import("../../../routes/razorpay-webhook.js");

    const rawBody = Buffer.from(
      JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_1", order_id: "order_1" } } },
      }),
    );
    const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");

    // A lookup client that reports it does NOT bypass RLS → the probe must throw,
    // and the handler returns 500 (fail CLOSED, never a silent "unknown order").
    const lookupClient = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ rolbypassrls: false }]),
      paymentTransaction: { findFirst: vi.fn() },
    } as unknown as import("@campusgate/db").DbClient;

    const app = Fastify();
    await app.register(razorpayWebhookRoutes, {
      prefix: "/api/webhooks",
      lookupClient,
      gateway: gatewayWithStub(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/razorpay",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": signature,
        "x-razorpay-event-id": "evt_probe",
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(500);
    // The order-lookup was never reached — the probe failed closed first.
    expect(
      (lookupClient as unknown as { paymentTransaction: { findFirst: ReturnType<typeof vi.fn> } })
        .paymentTransaction.findFirst,
    ).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an invalid webhook signature with 401 before any DB access", async () => {
    const Fastify = (await import("fastify")).default;
    const { razorpayWebhookRoutes } = await import("../../../routes/razorpay-webhook.js");

    const rawBody = Buffer.from(JSON.stringify({ event: "payment.captured" }));
    const lookupClient = {
      $queryRawUnsafe: vi.fn(),
      paymentTransaction: { findFirst: vi.fn() },
    } as unknown as import("@campusgate/db").DbClient;

    const app = Fastify();
    await app.register(razorpayWebhookRoutes, {
      prefix: "/api/webhooks",
      lookupClient,
      gateway: gatewayWithStub(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/razorpay",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": "deadbeef",
        "x-razorpay-event-id": "evt_bad",
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(401);
    expect(
      (lookupClient as unknown as { $queryRawUnsafe: ReturnType<typeof vi.fn> }).$queryRawUnsafe,
    ).not.toHaveBeenCalled();
    await app.close();
  });
});
