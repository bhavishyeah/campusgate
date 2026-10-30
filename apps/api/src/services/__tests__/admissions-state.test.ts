/**
 * Pure admissions state-machine unit tests (design §3). No I/O, no DB — these
 * pin the ONE legal-transition table every status move is checked against:
 * every legal edge is allowed, a sample of illegal ones is rejected, terminal
 * states have no outgoing edges, and REJECTED/WITHDRAWN can never reach ENROLLED.
 */
import { describe, expect, it } from "vitest";
import {
  LEGAL_TRANSITIONS,
  TERMINAL_STATUSES,
  isTerminal,
  canTransition,
  assertTransition,
  illegalTransitionMessage,
  type ApplicationStatus,
} from "../admissions-state.js";

const ALL_STATUSES: ApplicationStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "DOCUMENTS_REQUIRED",
  "ELIGIBLE",
  "SHORTLISTED",
  "OFFERED",
  "ACCEPTED",
  "ENROLLED",
  "REJECTED",
  "WITHDRAWN",
];

describe("admissions-state: legal edges", () => {
  it("allows every edge declared in the legal-transition table", () => {
    for (const from of ALL_STATUSES) {
      for (const to of LEGAL_TRANSITIONS[from]) {
        expect(canTransition(from, to)).toBe(true);
        expect(assertTransition(from, to)).toEqual({ ok: true });
      }
    }
  });

  it("encodes the DRAFT / review / OFFERED / ACCEPTED edges from §3", () => {
    expect(LEGAL_TRANSITIONS.DRAFT).toEqual(["SUBMITTED", "WITHDRAWN"]);
    // OFFERED → ACCEPTED | ELIGIBLE | SHORTLISTED | REJECTED | WITHDRAWN
    expect(new Set(LEGAL_TRANSITIONS.OFFERED)).toEqual(
      new Set(["ACCEPTED", "ELIGIBLE", "SHORTLISTED", "REJECTED", "WITHDRAWN"]),
    );
    // ACCEPTED → ENROLLED | REJECTED | WITHDRAWN
    expect(new Set(LEGAL_TRANSITIONS.ACCEPTED)).toEqual(new Set(["ENROLLED", "REJECTED", "WITHDRAWN"]));
  });

  it("only ACCEPTED can reach ENROLLED", () => {
    for (const from of ALL_STATUSES) {
      expect(canTransition(from, "ENROLLED")).toBe(from === "ACCEPTED");
    }
  });
});

describe("admissions-state: illegal edges rejected", () => {
  const illegalSamples: Array<[ApplicationStatus, ApplicationStatus]> = [
    ["DRAFT", "ACCEPTED"],
    ["DRAFT", "ENROLLED"],
    ["SUBMITTED", "OFFERED"],
    ["UNDER_REVIEW", "ACCEPTED"],
    ["ELIGIBLE", "ENROLLED"],
    ["OFFERED", "ENROLLED"],
    ["SHORTLISTED", "ACCEPTED"],
    ["DOCUMENTS_REQUIRED", "ELIGIBLE"],
  ];

  it.each(illegalSamples)("rejects %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(assertTransition(from, to)).toEqual({
      ok: false,
      message: illegalTransitionMessage(from, to),
    });
  });

  it("rejects a no-op (status -> same status)", () => {
    for (const s of ALL_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });
});

describe("admissions-state: terminal states", () => {
  it("ENROLLED / REJECTED / WITHDRAWN have no outgoing edges", () => {
    for (const t of TERMINAL_STATUSES) {
      expect(LEGAL_TRANSITIONS[t]).toEqual([]);
      expect(isTerminal(t)).toBe(true);
      for (const to of ALL_STATUSES) {
        expect(canTransition(t, to)).toBe(false);
      }
    }
  });

  it("REJECTED and WITHDRAWN can never reach ENROLLED", () => {
    expect(canTransition("REJECTED", "ENROLLED")).toBe(false);
    expect(canTransition("WITHDRAWN", "ENROLLED")).toBe(false);
  });

  it("non-terminal states are not reported terminal", () => {
    const nonTerminal = ALL_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s));
    for (const s of nonTerminal) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});
