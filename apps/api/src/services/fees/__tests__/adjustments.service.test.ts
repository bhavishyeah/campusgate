import { describe, expect, it, vi } from "vitest";
import { postAdjustment } from "../adjustments.js";

vi.mock("../../audit.js", () => ({ recordAuditEvent: vi.fn(async () => {}) }));

function mockTx(charge: { amountPaise: bigint; allocated: bigint } | null) {
  const created: any[] = [];
  const updates: any[] = [];
  const tx = {
    studentCharge: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (!charge) return null;
        // ownership probe returns {id}; ledger loader returns the full shape.
        if (where.studentId) return { id: where.id };
        return {
          id: where.id,
          amountPaise: charge.amountPaise,
          allocations: charge.allocated > 0n ? [{ amountPaise: charge.allocated }] : [],
          concessionCredits: [],
          refundReversals: [],
          adjustments: [],
        };
      }),
      update: vi.fn(async (args: any) => {
        updates.push(args);
        return {};
      }),
    },
    adjustment: {
      create: vi.fn(async (args: any) => {
        const row = { id: "adj_1", ...args.data };
        created.push(row);
        return row;
      }),
    },
  } as any;
  return { tx, created, updates };
}

const actor = { actorUserId: "u1", actorRoleKey: "ACCOUNTANT" };

describe("postAdjustment", () => {
  it("WAIVER (CREDIT) within outstanding succeeds and recomputes status", async () => {
    const { tx, created, updates } = mockTx({ amountPaise: 5_000_000n, allocated: 0n });
    const res = await postAdjustment(tx, {
      institutionId: "inst1",
      studentId: "stu1",
      chargeId: "ch1",
      type: "WAIVER",
      amountPaise: 2_000_000n,
      reason: "hardship",
      actor,
    });
    expect(res.ok).toBe(true);
    expect(created[0].direction).toBe("CREDIT");
    expect(updates).toHaveLength(1);
  });

  it("CREDIT exceeding outstanding is 409", async () => {
    const { tx } = mockTx({ amountPaise: 5_000_000n, allocated: 3_000_000n });
    const res = await postAdjustment(tx, {
      institutionId: "inst1",
      studentId: "stu1",
      chargeId: "ch1",
      type: "WRITE_OFF",
      amountPaise: 3_000_000n, // outstanding is only 2,000,000
      reason: "writeoff",
      actor,
    });
    expect(res).toMatchObject({ ok: false, status: 409 });
  });

  it("WAIVER is forced to CREDIT even if DEBIT is passed (schema refine is the 400 gate)", async () => {
    // The route's zod refine rejects DEBIT+non-CORRECTION with a 400; the service
    // is defensive and forces WAIVER/WRITE_OFF to CREDIT regardless of input.
    const { tx, created } = mockTx({ amountPaise: 5_000_000n, allocated: 0n });
    const res = await postAdjustment(tx, {
      institutionId: "inst1",
      studentId: "stu1",
      chargeId: "ch1",
      type: "WAIVER",
      direction: "DEBIT",
      amountPaise: 1_000_000n,
      reason: "x",
      actor,
    });
    expect(res.ok).toBe(true);
    expect(created[0].direction).toBe("CREDIT");
  });

  it("CORRECTION DEBIT bounded by snapshot headroom", async () => {
    // amount 5,000,000, fully paid → outstanding 0, headroom 5,000,000.
    const { tx, created } = mockTx({ amountPaise: 5_000_000n, allocated: 5_000_000n });
    const ok = await postAdjustment(tx, {
      institutionId: "inst1",
      studentId: "stu1",
      chargeId: "ch1",
      type: "CORRECTION",
      direction: "DEBIT",
      amountPaise: 3_000_000n,
      reason: "correction",
      actor,
    });
    expect(ok.ok).toBe(true);
    expect(created[0].direction).toBe("DEBIT");

    // A debit beyond headroom is rejected.
    const { tx: tx2 } = mockTx({ amountPaise: 5_000_000n, allocated: 0n });
    const bad = await postAdjustment(tx2, {
      institutionId: "inst1",
      studentId: "stu1",
      chargeId: "ch1",
      type: "CORRECTION",
      direction: "DEBIT",
      amountPaise: 1n, // outstanding already == amount, headroom 0
      reason: "correction",
      actor,
    });
    expect(bad).toMatchObject({ ok: false, status: 409 });
  });
});
