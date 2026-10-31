import { describe, expect, it, vi } from "vitest";
import { confirmCapture } from "../confirmation.js";

vi.mock("../../audit.js", () => ({ recordAuditEvent: vi.fn(async () => {}) }));
vi.mock("../../notifications.js", () => ({ notifyUser: vi.fn(async () => {}) }));

/**
 * Prove the §E.5 change: confirmCapture now recomputes post-capture status via
 * computeChargeStatus (the full ledger), so a charge that already carried a
 * concession credit lands on PAID when capture + concession together clear the
 * outstanding — not PARTIALLY_PAID (which a plain allocation-only nextStatus
 * would wrongly produce for a partial capture).
 */
describe("confirmCapture: capture-after-concession status", () => {
  it("a 4,000,000 capture on a 5,000,000 charge with a 1,000,000 concession credit → PAID", async () => {
    const statusWrites: Record<string, string> = {};
    const charge = {
      id: "ch1",
      amountPaise: 5_000_000n,
      dueDate: null as Date | null,
      postedAt: new Date("2026-01-01T00:00:00Z"),
      // allocations BEFORE this capture: none.
      allocations: [] as { amountPaise: bigint }[],
      concessionCredits: [{ amountPaise: 1_000_000n }],
      refundReversals: [] as { amountPaise: bigint }[],
      adjustments: [] as { amountPaise: bigint; direction: string }[],
    };

    const tx = {
      studentProfile: {
        findFirst: vi.fn(async () => ({ userId: "payer1" })),
      },
      paymentTransaction: {
        update: vi.fn(async () => ({})),
      },
      studentCharge: {
        findMany: vi.fn(async () => [
          {
            id: charge.id,
            amountPaise: charge.amountPaise,
            dueDate: charge.dueDate,
            postedAt: charge.postedAt,
            allocations: charge.allocations,
          },
        ]),
        findFirst: vi.fn(async ({ where }: any) => {
          // ledger loader — reflect the allocation this capture just created.
          return {
            id: where.id,
            amountPaise: charge.amountPaise,
            allocations: charge.allocations,
            concessionCredits: charge.concessionCredits,
            refundReversals: charge.refundReversals,
            adjustments: charge.adjustments,
          };
        }),
        update: vi.fn(async (args: any) => {
          statusWrites[args.where.id] = args.data.status;
          return {};
        }),
      },
      paymentAllocation: {
        create: vi.fn(async (args: any) => {
          // record the allocation so the subsequent ledger load reflects it.
          charge.allocations = [...charge.allocations, { amountPaise: args.data.amountPaise }];
          return {};
        }),
      },
      receipt: {
        create: vi.fn(async () => ({ id: "rcpt1" })),
      },
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => [{ max: 0 }]),
    } as any;

    const result = await confirmCapture(tx, {
      institutionId: "inst1",
      transaction: {
        id: "txn1",
        studentId: "stu1",
        amountPaise: 4_000_000n, // capture covers 4,000,000; 1,000,000 was conceded
        status: "AUTHORIZED",
        razorpayOrderId: "order_1",
        razorpayPaymentId: "pay_1",
        targetChargeIds: ["ch1"],
        initiatedByUserId: "payer1",
      },
      razorpayPaymentId: "pay_1",
      actor: { actorUserId: "payer1", actorRoleKey: "STUDENT" },
      captureAuditAction: "fees.payment.captured",
    });

    expect(result.captured).toBe(true);
    // outstanding = 5,000,000 − 4,000,000 (alloc) − 1,000,000 (concession) = 0 → PAID
    expect(statusWrites["ch1"]).toBe("PAID");
  });
});
