import { describe, expect, it } from "vitest";
import {
  computeChargeOutstanding,
  computeChargeStatus,
  planRefundReversal,
  type LedgerInputs,
} from "../ledger.js";

const EMPTY: Omit<LedgerInputs, "charge"> = {
  allocations: [],
  concessionCredits: [],
  adjustmentCredits: [],
  adjustmentDebits: [],
  refundReversals: [],
};

function inputs(amount: bigint, over: Partial<LedgerInputs> = {}): LedgerInputs {
  return { charge: { amountPaise: amount }, ...EMPTY, ...over };
}

describe("ledger: computeChargeOutstanding (five streams)", () => {
  it("no entries → outstanding is the full amount", () => {
    expect(computeChargeOutstanding(inputs(5_000_000n))).toBe(5_000_000n);
  });

  it("payment allocations reduce outstanding", () => {
    expect(
      computeChargeOutstanding(inputs(5_000_000n, { allocations: [{ amountPaise: 2_000_000n }] })),
    ).toBe(3_000_000n);
  });

  it("concession credits reduce outstanding", () => {
    expect(
      computeChargeOutstanding(inputs(5_000_000n, { concessionCredits: [{ amountPaise: 1_000_000n }] })),
    ).toBe(4_000_000n);
  });

  it("adjustment CREDITs reduce, DEBITs increase (bounded by amount)", () => {
    expect(
      computeChargeOutstanding(
        inputs(5_000_000n, {
          allocations: [{ amountPaise: 1_000_000n }],
          adjustmentCredits: [{ amountPaise: 500_000n }],
          adjustmentDebits: [{ amountPaise: 200_000n }],
        }),
      ),
    ).toBe(5_000_000n - 1_000_000n - 500_000n + 200_000n);
  });

  it("refund reversals add back to outstanding", () => {
    expect(
      computeChargeOutstanding(
        inputs(5_000_000n, {
          allocations: [{ amountPaise: 5_000_000n }],
          refundReversals: [{ amountPaise: 2_000_000n }],
        }),
      ),
    ).toBe(2_000_000n);
  });

  it("clamps at 0 when credits exceed amount", () => {
    expect(
      computeChargeOutstanding(
        inputs(1_000_000n, {
          allocations: [{ amountPaise: 1_000_000n }],
          concessionCredits: [{ amountPaise: 500_000n }],
        }),
      ),
    ).toBe(0n);
  });

  it("clamps at amount when debits/reversals would exceed it", () => {
    expect(
      computeChargeOutstanding(
        inputs(1_000_000n, { refundReversals: [{ amountPaise: 5_000_000n }] }),
      ),
    ).toBe(1_000_000n);
  });
});

describe("ledger: computeChargeStatus (boundaries)", () => {
  it("full outstanding → PENDING", () => {
    expect(computeChargeStatus(inputs(5_000_000n))).toBe("PENDING");
  });

  it("partial → PARTIALLY_PAID", () => {
    expect(
      computeChargeStatus(inputs(5_000_000n, { allocations: [{ amountPaise: 2_000_000n }] })),
    ).toBe("PARTIALLY_PAID");
  });

  it("zero outstanding → PAID", () => {
    expect(
      computeChargeStatus(inputs(5_000_000n, { allocations: [{ amountPaise: 5_000_000n }] })),
    ).toBe("PAID");
  });

  it("PAID charge whose payment is refunded moves back toward PENDING", () => {
    // Fully paid then fully reversed → PENDING.
    expect(
      computeChargeStatus(
        inputs(5_000_000n, {
          allocations: [{ amountPaise: 5_000_000n }],
          refundReversals: [{ amountPaise: 5_000_000n }],
        }),
      ),
    ).toBe("PENDING");
    // Fully paid then partially reversed → PARTIALLY_PAID.
    expect(
      computeChargeStatus(
        inputs(5_000_000n, {
          allocations: [{ amountPaise: 5_000_000n }],
          refundReversals: [{ amountPaise: 2_000_000n }],
        }),
      ),
    ).toBe("PARTIALLY_PAID");
  });
});

describe("ledger: planRefundReversal", () => {
  it("distributes newest-first, clamped to original allocation and headroom", () => {
    const plan = planRefundReversal(3_000_000n, [
      { studentChargeId: "c2", amountPaise: 2_000_000n, currentHeadroom: 2_000_000n },
      { studentChargeId: "c1", amountPaise: 2_000_000n, currentHeadroom: 2_000_000n },
    ]);
    expect(plan.reversals).toEqual([
      { studentChargeId: "c2", amountPaise: 2_000_000n },
      { studentChargeId: "c1", amountPaise: 1_000_000n },
    ]);
    expect(plan.remainder).toBe(0n);
  });

  it("refund-after-concession: headroom shortfall surfaces as remainder (unreversiblePaise)", () => {
    // The charge was captured at 5,000,000 then concession-zeroed afterwards, so
    // its current headroom is only 1,000,000 (4,000,000 consumed by a credit).
    const plan = planRefundReversal(5_000_000n, [
      { studentChargeId: "c1", amountPaise: 5_000_000n, currentHeadroom: 1_000_000n },
    ]);
    expect(plan.reversals).toEqual([{ studentChargeId: "c1", amountPaise: 1_000_000n }]);
    // 4,000,000 refunded paise could not be restored → unreversible.
    expect(plan.remainder).toBe(4_000_000n);
  });

  it("unallocated overpayment refund has no charge to restore → all remainder", () => {
    const plan = planRefundReversal(1_000_000n, []);
    expect(plan.reversals).toEqual([]);
    expect(plan.remainder).toBe(1_000_000n);
  });

  it("BigInt edges: 1 paise and MAX_SAFE_INTEGER", () => {
    const one = planRefundReversal(1n, [
      { studentChargeId: "c1", amountPaise: 1n, currentHeadroom: 1n },
    ]);
    expect(one.reversals).toEqual([{ studentChargeId: "c1", amountPaise: 1n }]);
    expect(one.remainder).toBe(0n);

    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const big = planRefundReversal(max, [
      { studentChargeId: "c1", amountPaise: max, currentHeadroom: max },
    ]);
    expect(big.reversals).toEqual([{ studentChargeId: "c1", amountPaise: max }]);
    expect(big.remainder).toBe(0n);
  });
});
