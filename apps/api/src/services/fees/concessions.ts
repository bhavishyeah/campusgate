import type { Prisma } from "@campusgate/db";
import { recordAuditEvent } from "../audit.js";
import { computeChargeOutstanding, computeChargeStatus } from "./ledger.js";
import { loadChargeLedger } from "./ledger-query.js";

/**
 * Concession / scholarship service (design §E.5). A concession is a CREDIT that
 * reduces a charge's outstanding, applied as append-only `concession_credits`
 * against one or more charges — NEVER by editing the original charge amount.
 *
 * `postConcession` MUST be called INSIDE a `withTenant(institutionId, tx)`
 * transaction. It caps each per-charge credit at that charge's CURRENT
 * outstanding (computed from the live ledger), inserts the StudentConcession
 * header + ConcessionCredit lines, recomputes each affected charge's status, and
 * audits `fees.concession.posted` under the approver — all in the same tx.
 */

export interface ConcessionDefinitionForResolve {
  type: "FIXED" | "PERCENT";
  amountPaise: bigint | null;
  percentBps: number | null;
}

/**
 * Resolve the concession amount for a charge: FIXED → the definition's
 * amountPaise; PERCENT → floor(charge.amountPaise * percentBps / 10000) in
 * integer paise. Pure BigInt (no float).
 */
export function resolveConcessionAmount(
  def: ConcessionDefinitionForResolve,
  charge: { amountPaise: bigint },
): bigint {
  if (def.type === "FIXED") {
    return def.amountPaise ?? 0n;
  }
  const bps = BigInt(def.percentBps ?? 0);
  return (charge.amountPaise * bps) / 10000n; // integer floor
}

export interface PostConcessionActor {
  actorUserId: string;
  actorRoleKey: string;
  actorMembershipId?: string | null;
  requestRef?: string | null;
}

export interface PostConcessionInput {
  institutionId: string;
  studentId: string;
  concessionDefinitionId: string;
  note?: string | null;
  /** When amountPaise is omitted, the amount is resolved from the definition. */
  allocations: { chargeId: string; amountPaise?: bigint }[];
  actor: PostConcessionActor;
}

export type PostConcessionResult =
  | { ok: true; studentConcessionId: string; totalPaise: bigint }
  | { ok: false; status: number; error: string };

export async function postConcession(
  tx: Prisma.TransactionClient,
  input: PostConcessionInput,
): Promise<PostConcessionResult> {
  const { institutionId, studentId, concessionDefinitionId } = input;

  const def = await tx.concessionDefinition.findFirst({
    where: { id: concessionDefinitionId, institutionId },
    select: { id: true, type: true, amountPaise: true, percentBps: true },
  });
  if (!def) return { ok: false, status: 404, error: "concession definition not found" };

  const student = await tx.studentProfile.findFirst({
    where: { id: studentId, institutionId },
    select: { id: true },
  });
  if (!student) return { ok: false, status: 404, error: "student not found" };

  // Resolve + cap each credit against the charge's current outstanding.
  const credits: { chargeId: string; amountPaise: bigint }[] = [];
  let total = 0n;
  for (const alloc of input.allocations) {
    const ledger = await loadChargeLedger(tx, institutionId, alloc.chargeId);
    if (!ledger) return { ok: false, status: 404, error: `charge ${alloc.chargeId} not found` };

    // The charge must belong to this student.
    const owned = await tx.studentCharge.findFirst({
      where: { id: alloc.chargeId, institutionId, studentId },
      select: { id: true },
    });
    if (!owned) return { ok: false, status: 404, error: `charge ${alloc.chargeId} not owned by student` };

    const outstanding = computeChargeOutstanding(ledger);
    const requested =
      alloc.amountPaise ??
      resolveConcessionAmount(
        { type: def.type, amountPaise: def.amountPaise, percentBps: def.percentBps },
        ledger.charge,
      );
    if (requested <= 0n) {
      return { ok: false, status: 400, error: `resolved concession amount for charge ${alloc.chargeId} is not positive` };
    }
    if (requested > outstanding) {
      return { ok: false, status: 409, error: "credit exceeds outstanding" };
    }
    credits.push({ chargeId: alloc.chargeId, amountPaise: requested });
    total += requested;
  }

  if (total <= 0n) return { ok: false, status: 400, error: "concession total must be positive" };

  const header = await tx.studentConcession.create({
    data: {
      institutionId,
      concessionDefinitionId: def.id,
      studentId,
      totalPaise: total,
      approvedByUserId: input.actor.actorUserId,
      note: input.note ?? null,
    },
  });

  for (const c of credits) {
    await tx.concessionCredit.create({
      data: {
        institutionId,
        studentConcessionId: header.id,
        studentChargeId: c.chargeId,
        amountPaise: c.amountPaise,
        currency: "INR",
      },
    });
    // Recompute the charge's effective status from the (now updated) ledger.
    const ledger = await loadChargeLedger(tx, institutionId, c.chargeId);
    if (ledger) {
      await tx.studentCharge.update({
        where: { id: c.chargeId },
        data: { status: computeChargeStatus(ledger) },
      });
    }
  }

  await recordAuditEvent(
    {
      action: "fees.concession.posted",
      result: "SUCCESS",
      actorUserId: input.actor.actorUserId,
      actorRoleKey: input.actor.actorRoleKey,
      actorMembershipId: input.actor.actorMembershipId ?? null,
      requestRef: input.actor.requestRef ?? null,
      institutionId,
      resourceType: "StudentConcession",
      resourceId: header.id,
      metadata: {
        concessionDefinitionId: def.id,
        studentId,
        totalPaise: total.toString(),
        creditCount: credits.length,
      },
    },
    tx,
  );

  return { ok: true, studentConcessionId: header.id, totalPaise: total };
}
