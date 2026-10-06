import type { PassStatus, AuditAction } from "@campusgate/db";

type GateEventLike = {
  eventType: "EXIT" | "RETURN";
  timestamp: Date;
  gate?: { name: string } | null;
};

type AuditLogLike = {
  action: AuditAction;
  timestamp: Date;
  metadata?: any;
};

type PassLike = {
  id: string;
  passNumber: string;
  status: PassStatus;
  createdAt: Date;
  approvedAt: Date | null;
  updatedAt: Date;
  requestedExit: Date;
  expectedReturn: Date;
  actualExit: Date | null;
  actualReturn: Date | null;
  rejectionReason: string | null;
  gateEvents: GateEventLike[];
};

export type TimelineItem = {
  at: Date;
  code: string;
  title: string;
  detail?: string;
};

export function buildPassTimeline(pass: PassLike, logs: AuditLogLike[]): TimelineItem[] {
  const items: TimelineItem[] = [];

  items.push({
    at: pass.createdAt,
    code: "REQUEST_CREATED",
    title: "Request Created",
  });

  if (pass.approvedAt) {
    items.push({
      at: pass.approvedAt,
      code: "APPROVED",
      title: "Approved by HOD",
    });
  }

  const sortedGateEvents = [...pass.gateEvents].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
  );

  for (const event of sortedGateEvents) {
    if (event.eventType === "EXIT") {
      items.push({
        at: event.timestamp,
        code: "EXIT_RECORDED",
        title: "Exit Verified",
        detail: event.gate?.name ? `Gate: ${event.gate.name}` : undefined,
      });
    } else if (event.eventType === "RETURN") {
      items.push({
        at: event.timestamp,
        code: "RETURN_RECORDED",
        title: "Return Verified",
        detail: event.gate?.name ? `Gate: ${event.gate.name}` : undefined,
      });
    }
  }

  if (pass.status === "REJECTED") {
    items.push({
      at: pass.updatedAt,
      code: "REJECTED",
      title: "Request Rejected",
      detail: pass.rejectionReason || undefined,
    });
  }

  if (pass.status === "CANCELLED") {
    items.push({
      at: pass.updatedAt,
      code: "CANCELLED",
      title: "Request Cancelled",
    });
  }

  if (pass.status === "REVOKED") {
    const revokeLog = logs
      .filter((l) => l.action === "PASS_REVOKED")
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];

    items.push({
      at: revokeLog?.timestamp ?? pass.updatedAt,
      code: "REVOKED",
      title: "Pass Revoked",
      detail: revokeLog?.metadata?.reason || undefined,
    });
  }

  if (pass.status === "EXPIRED") {
    items.push({
      at: pass.updatedAt,
      code: "EXPIRED",
      title: "Pass Expired",
    });
  }

  if (pass.status === "COMPLETED" && pass.actualReturn) {
    items.push({
      at: pass.actualReturn,
      code: "COMPLETED",
      title: "Pass Completed",
    });
  }

  return items.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function computeOutsideDurationMinutes(actualExit: Date | null, actualReturn: Date | null): number | null {
  if (!actualExit || !actualReturn) return null;
  const ms = actualReturn.getTime() - actualExit.getTime();
  if (ms <= 0) return null;
  return Math.floor(ms / (1000 * 60));
}
