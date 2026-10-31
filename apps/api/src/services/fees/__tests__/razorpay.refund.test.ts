import { describe, expect, it, vi } from "vitest";
import {
  RazorpayGateway,
  type RazorpaySdkLike,
  type RazorpayRefundParams,
  type RazorpayRefundResult,
} from "../razorpay.js";

function gatewayWithRefundStub(
  impl: (paymentId: string, params: RazorpayRefundParams) => Promise<RazorpayRefundResult>,
) {
  const refund = vi.fn(impl);
  const sdk = {
    orders: {
      create: vi.fn(),
      fetch: vi.fn(),
      fetchPayments: vi.fn(),
    },
    payments: { refund },
  } as unknown as RazorpaySdkLike;
  const gateway = new RazorpayGateway({
    keyId: "rzp_test_x",
    keySecret: "secret",
    webhookSecret: "whsec",
    sdk,
  });
  return { gateway, refund };
}

describe("RazorpayGateway.refundPayment", () => {
  it("rejects amount <= 0", async () => {
    const { gateway } = gatewayWithRefundStub(async () => {
      throw new Error("should not be called");
    });
    await expect(gateway.refundPayment("pay_1", 0n, { receipt: "r" })).rejects.toThrow(
      /out of range/,
    );
  });

  it("rejects amount > Number.MAX_SAFE_INTEGER", async () => {
    const { gateway } = gatewayWithRefundStub(async () => {
      throw new Error("should not be called");
    });
    const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    await expect(gateway.refundPayment("pay_1", tooBig, { receipt: "r" })).rejects.toThrow(
      /out of range/,
    );
  });

  it("calls the SDK with amount, speed:normal and receipt=idempotencyKey", async () => {
    const { gateway, refund } = gatewayWithRefundStub(async (paymentId, params) => ({
      id: "rfnd_1",
      payment_id: paymentId,
      amount: params.amount,
      status: "processed",
      receipt: params.receipt,
    }));
    const result = await gateway.refundPayment("pay_1", 2_000_000n, {
      receipt: "idem_abc",
      notes: { ref: "x" },
    });
    expect(refund).toHaveBeenCalledWith("pay_1", {
      amount: 2_000_000,
      speed: "normal",
      receipt: "idem_abc",
      notes: { ref: "x" },
    });
    expect(result).toEqual({
      id: "rfnd_1",
      payment_id: "pay_1",
      amount: 2_000_000,
      status: "processed",
      receipt: "idem_abc",
    });
  });

  it("falls back to the requested amount when the SDK result amount is undefined (NIT-4)", async () => {
    const { gateway } = gatewayWithRefundStub(async (paymentId) => ({
      id: "rfnd_2",
      payment_id: paymentId,
      amount: undefined,
      status: "pending",
      receipt: "idem_def",
    }));
    const result = await gateway.refundPayment("pay_9", 1_234_000n, { receipt: "idem_def" });
    expect(result.amount).toBe(1_234_000);
    expect(result.status).toBe("pending");
  });
});
