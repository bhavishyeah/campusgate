import crypto from "node:crypto";
import Razorpay from "razorpay";

/**
 * Razorpay gateway service (design §D.6).
 *
 * The SDK (pinned `razorpay`, in dependencies) handles order creation and the
 * reconciliation reads (`orders.fetch`, `orders.fetchPayments`) — typed,
 * maintained HTTP + auth. BOTH signature verifications use Node built-in
 * `crypto` (`createHmac` + `timingSafeEqual`), NOT the SDK's
 * `validateWebhookSignature`, so the trust boundary is dependency-light,
 * auditable, and hashes the EXACT raw body bytes for the webhook.
 *
 * Secret-absence guard — mirrors the server.ts JWT_SECRET pattern EXACTLY
 * (§D.6, NIT-1): throw ONLY when `NODE_ENV === 'production'` and a required
 * secret is unset. In dev/test a mocked or absent secret MUST NOT crash module
 * import — the fast suites never hit the network and the service is
 * injectable/mockable (see RazorpayGateway constructor + the exported
 * singleton accessor).
 */

export interface CreateOrderInput {
  /** Integer paise (BigInt). The single guarded BigInt→Number coercion happens here. */
  amountPaise: bigint;
  currency: "INR";
  /** Internal reference (≤ 40 chars). */
  receipt?: string;
  /** Small scalar diagnostics only — NOT the authoritative charge set (§D.5, MEDIUM-3). */
  notes?: Record<string, string | number>;
}

/** The subset of the Razorpay order entity the fees flow consumes. */
export interface RazorpayOrderResult {
  id: string;
  status: "created" | "attempted" | "paid";
  amount_paid: number;
  amount_due: number;
  [key: string]: unknown;
}

/** The subset of the Razorpay payment entity reconciliation consumes. */
export interface RazorpayPaymentResult {
  id: string;
  order_id: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  amount: number;
  [key: string]: unknown;
}

/**
 * Refund request body — a structural subset of the SDK's
 * `Refunds.RazorpayRefundCreateRequestBody` (all fields optional there;
 * `receipt` is `string | null`). We send `idempotencyKey` as `receipt` (HIGH-2).
 */
export interface RazorpayRefundParams {
  amount?: number; // smallest unit (paise)
  speed?: "normal" | "optimum";
  notes?: Record<string, string | number>;
  receipt?: string | null;
}

/**
 * Refund response — the fields we consume off `Refunds.RazorpayRefund`. NOTE
 * (NIT-4): the real type has NO `[k]: unknown` index signature and its `amount`
 * is `number | undefined`, so the mapping MUST handle an undefined amount (fall
 * back to the requested amount). No `[k]: unknown` is declared here.
 */
export interface RazorpayRefundResult {
  id: string;
  payment_id: string;
  amount?: number;
  status: "pending" | "processed" | "failed";
  receipt?: string | null;
}

/** The result `refundPayment` returns (amount is always resolved to a number). */
export interface RefundPaymentResult {
  id: string;
  payment_id: string;
  amount: number;
  status: "pending" | "processed" | "failed";
  receipt?: string | null;
}

/**
 * The minimal SDK surface the gateway needs. Declared as an interface so the
 * fast suites can inject a stub without instantiating the real SDK/network.
 */
export interface RazorpaySdkLike {
  orders: {
    create(params: {
      amount: number | string;
      currency: string;
      receipt?: string;
      notes?: Record<string, string | number>;
    }): Promise<RazorpayOrderResult>;
    fetch(orderId: string): Promise<RazorpayOrderResult>;
    fetchPayments(orderId: string): Promise<{
      entity: string;
      count: number;
      items: RazorpayPaymentResult[];
    }>;
  };
  payments: {
    refund(paymentId: string, params: RazorpayRefundParams): Promise<RazorpayRefundResult>;
    fetchRefund?(paymentId: string, refundId: string): Promise<RazorpayRefundResult>;
  };
}

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

export class RazorpayGateway {
  readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly sdk: RazorpaySdkLike;

  constructor(opts?: {
    keyId?: string;
    keySecret?: string;
    webhookSecret?: string;
    sdk?: RazorpaySdkLike;
  }) {
    this.keyId = opts?.keyId ?? process.env.RAZORPAY_KEY_ID ?? "";
    this.keySecret = opts?.keySecret ?? process.env.RAZORPAY_KEY_SECRET ?? "";
    this.webhookSecret =
      opts?.webhookSecret ?? process.env.RAZORPAY_WEBHOOK_SECRET ?? "";

    // Mirror server.ts: fail hard ONLY in production when a required secret is
    // unset. Dev/test must import cleanly (mocked/absent secret is fine).
    if (isProd()) {
      if (!this.keySecret) {
        throw new Error("RAZORPAY_KEY_SECRET must be set in production");
      }
      if (!this.webhookSecret) {
        throw new Error("RAZORPAY_WEBHOOK_SECRET must be set in production");
      }
    }

    this.sdk =
      opts?.sdk ??
      (new Razorpay({
        key_id: this.keyId || "rzp_test_unset",
        key_secret: this.keySecret || "unset",
      }) as unknown as RazorpaySdkLike);
  }

  /**
   * Create a Razorpay order. The amount arrives as integer paise (BigInt); the
   * ONLY BigInt→Number coercion in the slice happens here and is guarded
   * immediately before the call (HIGH-2, §D.1): reject out-of-range so the
   * `Number()` is provably lossless.
   */
  async createOrder(input: CreateOrderInput): Promise<RazorpayOrderResult> {
    const { amountPaise } = input;
    if (amountPaise <= 0n || amountPaise > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        "createOrder: amountPaise out of range (must be > 0 and <= Number.MAX_SAFE_INTEGER)",
      );
    }
    const amount = Number(amountPaise); // provably lossless after the guard
    return this.sdk.orders.create({
      amount,
      currency: input.currency,
      ...(input.receipt !== undefined ? { receipt: input.receipt } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
  }

  /**
   * Verify the checkout callback payment signature (Stage 2, optimistic UX):
   * expected = HMAC_SHA256(order_id + "|" + payment_id, KEY_SECRET), compared
   * constant-time. Returns false on any shape/length mismatch (never throws on
   * a bad client signature).
   */
  verifyPaymentSignature(
    orderId: string,
    paymentId: string,
    signature: string,
  ): boolean {
    const expected = crypto
      .createHmac("sha256", this.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    return timingSafeEqualHex(expected, signature);
  }

  /**
   * Verify the webhook HMAC over the EXACT raw body bytes (§D.8):
   * HMAC_SHA256(rawBody, WEBHOOK_SECRET), compared constant-time. `rawBody` is
   * the raw Buffer captured by the encapsulated content-type parser.
   */
  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = crypto
      .createHmac("sha256", this.webhookSecret)
      .update(rawBody)
      .digest("hex");
    return timingSafeEqualHex(expected, signature);
  }

  /**
   * Issue a refund against a CAPTURED payment (§E.7). The amount arrives as
   * integer paise (BigInt); the ONLY BigInt→Number coercion for refunds happens
   * here and is guarded immediately before the call exactly like `createOrder`
   * (reject out-of-range so the `Number()` is provably lossless). `opts.receipt`
   * carries the server-minted idempotencyKey (HIGH-2). A missing `amount` on the
   * SDK result falls back to the requested amount (NIT-4).
   */
  async refundPayment(
    paymentId: string,
    amountPaise: bigint,
    opts: { receipt: string; notes?: Record<string, string | number> },
  ): Promise<RefundPaymentResult> {
    if (amountPaise <= 0n || amountPaise > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        "refundPayment: amountPaise out of range (must be > 0 and <= Number.MAX_SAFE_INTEGER)",
      );
    }
    const amount = Number(amountPaise); // provably lossless after the guard
    const result = await this.sdk.payments.refund(paymentId, {
      amount,
      speed: "normal",
      receipt: opts.receipt,
      ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
    });
    return {
      id: result.id,
      payment_id: result.payment_id,
      amount: result.amount ?? amount,
      status: result.status,
      receipt: result.receipt,
    };
  }

  /** Reconciliation read: fetch the order entity. */
  fetchOrder(orderId: string): Promise<RazorpayOrderResult> {
    return this.sdk.orders.fetch(orderId);
  }

  /** Reconciliation read: fetch the payments made against the order. */
  async fetchOrderPayments(orderId: string): Promise<RazorpayPaymentResult[]> {
    const res = await this.sdk.orders.fetchPayments(orderId);
    return res.items ?? [];
  }
}

/**
 * Constant-time hex compare. `crypto.timingSafeEqual` throws on unequal buffer
 * lengths, so guard the length first (a length mismatch is simply "not equal").
 */
function timingSafeEqualHex(expectedHex: string, actualHex: string): boolean {
  if (typeof actualHex !== "string" || expectedHex.length !== actualHex.length) {
    return false;
  }
  const a = Buffer.from(expectedHex, "utf8");
  const b = Buffer.from(actualHex, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Lazy singleton ──────────────────────────────────────────────────────────
// Constructed on first access (not at import) so a dev/test import never trips
// the production secret guard and never instantiates the SDK until actually
// used. Routes call `getRazorpayGateway()`; tests inject their own instance.
let singleton: RazorpayGateway | null = null;

export function getRazorpayGateway(): RazorpayGateway {
  if (!singleton) singleton = new RazorpayGateway();
  return singleton;
}

/** Test seam: override (or reset with `null`) the process-wide gateway. */
export function setRazorpayGateway(gateway: RazorpayGateway | null): void {
  singleton = gateway;
}
