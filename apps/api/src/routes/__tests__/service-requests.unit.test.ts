/**
 * Phase-9.6 Service Requests FAST unit specs (no DB, no Fastify). These cover
 * the PURE pieces of the design the live-DB suites would be wasteful to re-prove:
 *   - the FIXED enumerated lifecycle transition-legality predicate (design §5;
 *     mirrors the DB guard service_request_status_guard; terminal states have no
 *     outgoing edge);
 *   - validateFieldValues (required-missing / wrong-typed NUMBER/DATE /
 *     out-of-range SELECT / unknown-key / happy path; design §6);
 *   - the derived SLA breach predicate (design FR-11) + dueAt computation (FR-6);
 *   - the exported Zod schemas (envelope accept/reject, incl. statusPatch
 *     excluding RESOLVED, the SELECT/options refinement, defaultAssigneeRole
 *     regex; design §10).
 *
 * The transition logic mirrors service-requests.ts EXACTLY so drift would be
 * caught by the behavioral suite that drives the real handler.
 */
import { describe, expect, it } from "vitest";
import {
  createServiceRequestTypeSchema,
  patchServiceRequestTypeSchema,
  createServiceRequestFieldSchema,
  raiseServiceRequestSchema,
  assignServiceRequestSchema,
  serviceRequestStatusPatchSchema,
  resolveServiceRequestSchema,
  serviceRequestCommentSchema,
  serviceRequestFeedbackSchema,
  serviceRequestListQuerySchema,
} from "@campusgate/shared";
import {
  STATUS_TRANSITIONS,
  TERMINAL_STATUSES,
  isLegalTransition,
  computeDueAt,
  isBreached,
  validateFieldValues,
  type FieldDefForValidation,
} from "../service-requests.js";

// ─── The FIXED enumerated lifecycle (design §5) ──────────────────────────────
describe("STATUS_TRANSITIONS (fixed enumerated lifecycle)", () => {
  const legalEdges: Array<[string, string]> = [
    ["OPEN", "ASSIGNED"],
    ["OPEN", "CANCELLED"],
    ["ASSIGNED", "IN_PROGRESS"],
    ["ASSIGNED", "ASSIGNED"],
    ["ASSIGNED", "CANCELLED"],
    ["IN_PROGRESS", "PENDING_APPROVAL"],
    ["IN_PROGRESS", "RESOLVED"],
    ["IN_PROGRESS", "CANCELLED"],
    ["PENDING_APPROVAL", "RESOLVED"],
    ["PENDING_APPROVAL", "REJECTED"],
    ["RESOLVED", "CLOSED"],
  ];

  it("accepts every legal edge", () => {
    for (const [from, to] of legalEdges) {
      expect(isLegalTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it("accepts the no-op self transition for every state", () => {
    for (const s of Object.keys(STATUS_TRANSITIONS)) {
      expect(isLegalTransition(s, s), `${s} -> ${s}`).toBe(true);
    }
  });

  it("rejects representative illegal edges (incl. OPEN -> RESOLVED)", () => {
    const illegal: Array<[string, string]> = [
      ["OPEN", "RESOLVED"],
      ["OPEN", "IN_PROGRESS"],
      ["OPEN", "PENDING_APPROVAL"],
      ["ASSIGNED", "RESOLVED"],
      ["ASSIGNED", "PENDING_APPROVAL"],
      ["IN_PROGRESS", "CLOSED"],
      ["PENDING_APPROVAL", "CLOSED"],
      ["RESOLVED", "REJECTED"],
    ];
    for (const [from, to] of illegal) {
      expect(isLegalTransition(from, to), `${from} -> ${to}`).toBe(false);
    }
  });

  it("terminal states have no outgoing edge (other than the self no-op)", () => {
    for (const t of TERMINAL_STATUSES) {
      expect(STATUS_TRANSITIONS[t]).toEqual([]);
      // No real target is legal (only the self no-op, excluded here).
      for (const to of ["OPEN", "ASSIGNED", "IN_PROGRESS", "RESOLVED", "CLOSED"]) {
        if (to === t) continue;
        expect(isLegalTransition(t, to), `${t} -> ${to}`).toBe(false);
      }
    }
  });
});

// ─── dueAt computation (design FR-6) ─────────────────────────────────────────
describe("computeDueAt", () => {
  it("= raisedAt + slaTargetHours", () => {
    const raised = new Date("2027-01-24T00:00:00.000Z");
    expect(computeDueAt(raised, 24).toISOString()).toBe("2027-01-25T00:00:00.000Z");
    expect(computeDueAt(raised, 1).toISOString()).toBe("2027-01-24T01:00:00.000Z");
  });
});

// ─── Derived SLA breach (design FR-11) ───────────────────────────────────────
describe("isBreached (derived, no stored flag)", () => {
  const now = new Date("2027-01-24T12:00:00.000Z");
  const past = new Date("2027-01-24T11:00:00.000Z");
  const future = new Date("2027-01-24T13:00:00.000Z");

  it("true when non-terminal and now > dueAt", () => {
    expect(isBreached("OPEN", past, now)).toBe(true);
    expect(isBreached("IN_PROGRESS", past, now)).toBe(true);
    expect(isBreached("PENDING_APPROVAL", past, now)).toBe(true);
  });

  it("false when dueAt is in the future", () => {
    expect(isBreached("OPEN", future, now)).toBe(false);
  });

  it("false for every terminal status regardless of dueAt", () => {
    for (const t of ["RESOLVED", "CLOSED", "REJECTED", "CANCELLED"]) {
      expect(isBreached(t, past, now), t).toBe(false);
    }
  });
});

// ─── validateFieldValues (design §6) ─────────────────────────────────────────
describe("validateFieldValues", () => {
  const defs: FieldDefForValidation[] = [
    { fieldKey: "summary", dataType: "TEXT", required: true, options: [] },
    { fieldKey: "qty", dataType: "NUMBER", required: false, options: [] },
    { fieldKey: "when", dataType: "DATE", required: false, options: [] },
    { fieldKey: "severity", dataType: "SELECT", required: true, options: ["LOW", "HIGH"] },
  ];

  it("passes a fully valid value set", () => {
    const errors = validateFieldValues(defs, {
      summary: "broken AC",
      qty: "3",
      when: "2027-01-24",
      severity: "HIGH",
    });
    expect(errors).toEqual({});
  });

  it("flags a missing required field", () => {
    const errors = validateFieldValues(defs, { severity: "LOW" });
    expect(errors.summary).toBe("required");
  });

  it("flags an empty-string required field", () => {
    const errors = validateFieldValues(defs, { summary: "   ", severity: "LOW" });
    expect(errors.summary).toBe("required");
  });

  it("flags a wrong-typed NUMBER", () => {
    const errors = validateFieldValues(defs, { summary: "x", qty: "abc", severity: "LOW" });
    expect(errors.qty).toBe("invalid_type");
  });

  it("flags a wrong-typed DATE", () => {
    const errors = validateFieldValues(defs, { summary: "x", when: "not-a-date", severity: "LOW" });
    expect(errors.when).toBe("invalid_type");
  });

  it("flags an out-of-range SELECT", () => {
    const errors = validateFieldValues(defs, { summary: "x", severity: "CRITICAL" });
    expect(errors.severity).toBe("invalid_option");
  });

  it("flags an unknown key", () => {
    const errors = validateFieldValues(defs, { summary: "x", severity: "LOW", bogus: "1" });
    expect(errors.bogus).toBe("unknown");
  });

  it("allows an optional field to be absent", () => {
    const errors = validateFieldValues(defs, { summary: "x", severity: "LOW" });
    expect(errors).toEqual({});
  });
});

// ─── Zod schemas (design §10) ────────────────────────────────────────────────
describe("createServiceRequestTypeSchema", () => {
  it("accepts a minimal valid type", () => {
    const r = createServiceRequestTypeSchema.safeParse({
      name: "Maintenance",
      code: "MAINT",
      category: "facilities",
      slaTargetHours: 24,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a lowercase code", () => {
    const r = createServiceRequestTypeSchema.safeParse({
      name: "x",
      code: "maint",
      category: "c",
      slaTargetHours: 24,
    });
    expect(r.success).toBe(false);
  });

  it("rejects slaTargetHours < 1", () => {
    const r = createServiceRequestTypeSchema.safeParse({
      name: "x",
      code: "X",
      category: "c",
      slaTargetHours: 0,
    });
    expect(r.success).toBe(false);
  });

  it("accepts SERVICE_AGENT as a defaultAssigneeRole free string (NIT-1)", () => {
    const r = createServiceRequestTypeSchema.safeParse({
      name: "x",
      code: "X",
      category: "c",
      slaTargetHours: 24,
      defaultAssigneeRole: "SERVICE_AGENT",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a defaultAssigneeRole with illegal chars", () => {
    const r = createServiceRequestTypeSchema.safeParse({
      name: "x",
      code: "X",
      category: "c",
      slaTargetHours: 24,
      defaultAssigneeRole: "lower-case!",
    });
    expect(r.success).toBe(false);
  });
});

describe("patchServiceRequestTypeSchema", () => {
  it("rejects unknown keys (strict)", () => {
    const r = patchServiceRequestTypeSchema.safeParse({ bogus: 1 });
    expect(r.success).toBe(false);
  });
});

describe("createServiceRequestFieldSchema (SELECT/options refinement)", () => {
  it("accepts SELECT with non-empty options", () => {
    const r = createServiceRequestFieldSchema.safeParse({
      fieldKey: "sev",
      label: "Severity",
      dataType: "SELECT",
      options: ["LOW", "HIGH"],
    });
    expect(r.success).toBe(true);
  });

  it("rejects SELECT with empty/absent options", () => {
    const r = createServiceRequestFieldSchema.safeParse({
      fieldKey: "sev",
      label: "Severity",
      dataType: "SELECT",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-SELECT field carrying options", () => {
    const r = createServiceRequestFieldSchema.safeParse({
      fieldKey: "note",
      label: "Note",
      dataType: "TEXT",
      options: ["a"],
    });
    expect(r.success).toBe(false);
  });

  it("accepts a TEXT field with no options", () => {
    const r = createServiceRequestFieldSchema.safeParse({
      fieldKey: "note",
      label: "Note",
      dataType: "TEXT",
    });
    expect(r.success).toBe(true);
  });
});

describe("serviceRequestStatusPatchSchema (NIT-2: toStatus excludes RESOLVED)", () => {
  it("accepts IN_PROGRESS and PENDING_APPROVAL", () => {
    expect(serviceRequestStatusPatchSchema.safeParse({ toStatus: "IN_PROGRESS" }).success).toBe(true);
    expect(serviceRequestStatusPatchSchema.safeParse({ toStatus: "PENDING_APPROVAL" }).success).toBe(
      true,
    );
  });

  it("rejects RESOLVED / CLOSED / CANCELLED / OPEN / ASSIGNED", () => {
    for (const s of ["RESOLVED", "CLOSED", "CANCELLED", "OPEN", "ASSIGNED", "REJECTED"]) {
      expect(serviceRequestStatusPatchSchema.safeParse({ toStatus: s }).success, s).toBe(false);
    }
  });
});

describe("raiseServiceRequestSchema", () => {
  it("defaults priority to NORMAL and fieldValues to {}", () => {
    const r = raiseServiceRequestSchema.safeParse({ requestTypeId: "t1", title: "Help" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.priority).toBe("NORMAL");
      expect(r.data.fieldValues).toEqual({});
    }
  });

  it("rejects an empty title", () => {
    expect(raiseServiceRequestSchema.safeParse({ requestTypeId: "t1", title: "" }).success).toBe(false);
  });
});

describe("assign/resolve/comment/feedback/list schemas", () => {
  it("assign requires assigneeUserId", () => {
    expect(assignServiceRequestSchema.safeParse({}).success).toBe(false);
    expect(assignServiceRequestSchema.safeParse({ assigneeUserId: "u1" }).success).toBe(true);
  });

  it("resolve requires a non-empty note", () => {
    expect(resolveServiceRequestSchema.safeParse({ resolutionNote: "" }).success).toBe(false);
    expect(resolveServiceRequestSchema.safeParse({ resolutionNote: "fixed" }).success).toBe(true);
  });

  it("comment requires a non-empty body", () => {
    expect(serviceRequestCommentSchema.safeParse({ body: "" }).success).toBe(false);
    expect(serviceRequestCommentSchema.safeParse({ body: "hi" }).success).toBe(true);
  });

  it("feedback rating must be an int 1..5", () => {
    expect(serviceRequestFeedbackSchema.safeParse({ rating: 0 }).success).toBe(false);
    expect(serviceRequestFeedbackSchema.safeParse({ rating: 6 }).success).toBe(false);
    expect(serviceRequestFeedbackSchema.safeParse({ rating: 3 }).success).toBe(true);
  });

  it("list query defaults page=1 pageSize=20 atRiskHours=24", () => {
    const r = serviceRequestListQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(1);
      expect(r.data.pageSize).toBe(20);
      expect(r.data.atRiskHours).toBe(24);
    }
  });
});
