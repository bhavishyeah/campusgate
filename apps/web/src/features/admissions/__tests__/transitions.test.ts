import { describe, it, expect } from "vitest";
import { LEGAL_TRANSITIONS, staffActionsFor } from "../transitions";
import type { ApplicationStatus } from "../types";

const ALL_STATUSES = Object.keys(LEGAL_TRANSITIONS) as ApplicationStatus[];
const NEVER_OFFERED: ApplicationStatus[] = ["ACCEPTED", "ENROLLED", "OFFERED", "WITHDRAWN", "SUBMITTED", "DRAFT"];
const TERMINAL: ApplicationStatus[] = ["ENROLLED", "REJECTED", "WITHDRAWN"];

describe("staffActionsFor", () => {
  it("is always a subset of LEGAL_TRANSITIONS for that status", () => {
    for (const status of ALL_STATUSES) {
      const actions = staffActionsFor(status);
      for (const a of actions) {
        expect(LEGAL_TRANSITIONS[status]).toContain(a);
      }
    }
  });

  it("never offers a staff-forbidden target", () => {
    for (const status of ALL_STATUSES) {
      const actions = staffActionsFor(status);
      for (const forbidden of NEVER_OFFERED) {
        expect(actions).not.toContain(forbidden);
      }
    }
  });

  it("returns [] for terminal statuses", () => {
    for (const status of TERMINAL) {
      expect(staffActionsFor(status)).toEqual([]);
    }
  });

  it("returns only REJECTED for OFFERED and ACCEPTED", () => {
    expect(staffActionsFor("OFFERED")).toEqual(["REJECTED"]);
    expect(staffActionsFor("ACCEPTED")).toEqual(["REJECTED"]);
  });

  it("returns DOCUMENTS_REQUIRED, ELIGIBLE, REJECTED for UNDER_REVIEW", () => {
    expect(staffActionsFor("UNDER_REVIEW").sort()).toEqual(["DOCUMENTS_REQUIRED", "ELIGIBLE", "REJECTED"].sort());
  });
});
