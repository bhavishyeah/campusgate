import { describe, expect, it, vi } from "vitest";
import { resolveConcessionAmount, postConcession } from "../concessions.js";

vi.mock("../../audit.js", () => ({ recordAuditEvent: vi.fn(async () => {}) }));

describe("resolveConcessionAmount", () => {
  it("FIXED returns the definition amount", () => {
    expect(
      resolveConcessionAmount({ type: "FIXED", amountPaise: 1_000_000n, percentBps: null }, { amountPaise: 5_000_000n }),
    ).toBe(1_000_000n);
  });

  it("PERCENT floors to integer paise", () => {
    // 2550 bps of 5,000,001 = 1,275,000.255 → floor 1,275,000
    expect(
      resolveConcessionAmount({ type: "PERCENT", amountPaise: null, percentBps: 2550 }, { amountPaise: 5_000_001n }),
    ).toBe(1_275_000n);
  });
});

/**
 * Build a minimal mock transaction client. A charge carries a fixed amount and
 * an allocations array so the ledger loader computes outstanding = amount −
 * allocations (no concessions/adjustments/reversals in these cases).
 */
function mockTx(opts: {
  def: { id: string; type: "FIXED" | "PERCENT"; amountPaise: bigint | null; percentBps: number | null } | null;
  student: boolean;
  charges: Record<string, { amountPaise: bigint; allocated: bigint; studentId: string }>;
  studentId: string;
}) {
  const created: { concessions: any[]; credits: any[]; updates: any[] } = {
    concessions: [],
    credits: [],
    updates: [],
  };
  const tx = {
    concessionDefinition: {
      findFirst: vi.fn(async () => opts.def),
    },
    studentProfile: {
      findFirst: vi.fn(async () => (opts.student ? { id: opts.studentId } : null)),
    },
    studentCharge: {
      findFirst: vi.fn(async ({ where }: any) => {
        const c = opts.charges[where.id];
        if (!c) return null;
        if (where.studentId && c.studentId !== where.studentId) return null;
        if ("studentId" in where && where.studentId === undefined) {
          /* ledger loader path */
        }
        return {
          id: where.id,
          amountPaise: c.amountPaise,
          allocations: c.allocated > 0n ? [{ amountPaise: c.allocated }] : [],
          concessionCredits: [],
          refundReversals: [],
          adjustments: [],
        };
      }),
      update: vi.fn(async (args: any) => {
        created.updates.push(args);
        return {};
      }),
    },
    studentConcession: {
      create: vi.fn(async (args: any) => {
        const row = { id: "sc_1", ...args.data };
        created.concessions.push(row);
        return row;
      }),
    },
    concessionCredit: {
      create: vi.fn(async (args: any) => {
        created.credits.push(args.data);
        return args.data;
      }),
    },
  } as any;
  return { tx, created };
}

describe("postConcession", () => {
  const actor = { actorUserId: "u1", actorRoleKey: "ACCOUNTANT" };

  it("posts a FIXED concession capped within outstanding and recomputes status", async () => {
    const { tx, created } = mockTx({
      def: { id: "def1", type: "FIXED", amountPaise: 1_000_000n, percentBps: null },
      student: true,
      studentId: "stu1",
      charges: { ch1: { amountPaise: 5_000_000n, allocated: 0n, studentId: "stu1" } },
    });
    const res = await postConcession(tx, {
      institutionId: "inst1",
      studentId: "stu1",
      concessionDefinitionId: "def1",
      allocations: [{ chargeId: "ch1" }],
      actor,
    });
    expect(res.ok).toBe(true);
    expect(created.credits).toHaveLength(1);
    expect(created.credits[0].amountPaise).toBe(1_000_000n);
    expect(created.updates).toHaveLength(1);
  });

  it("rejects a credit exceeding outstanding (409)", async () => {
    const { tx } = mockTx({
      def: { id: "def1", type: "FIXED", amountPaise: 9_000_000n, percentBps: null },
      student: true,
      studentId: "stu1",
      charges: { ch1: { amountPaise: 5_000_000n, allocated: 0n, studentId: "stu1" } },
    });
    const res = await postConcession(tx, {
      institutionId: "inst1",
      studentId: "stu1",
      concessionDefinitionId: "def1",
      allocations: [{ chargeId: "ch1" }],
      actor,
    });
    expect(res).toMatchObject({ ok: false, status: 409 });
  });

  it("404s a missing definition", async () => {
    const { tx } = mockTx({
      def: null,
      student: true,
      studentId: "stu1",
      charges: {},
    });
    const res = await postConcession(tx, {
      institutionId: "inst1",
      studentId: "stu1",
      concessionDefinitionId: "nope",
      allocations: [{ chargeId: "ch1" }],
      actor,
    });
    expect(res).toMatchObject({ ok: false, status: 404 });
  });
});
