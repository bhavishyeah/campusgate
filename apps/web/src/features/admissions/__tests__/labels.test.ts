import { describe, it, expect } from "vitest";
import { applicationStatusLabel, canActOnOffer, offeredPrograms } from "../labels";
import type { ApplicationStatus } from "../types";

const ALL_STATUSES: ApplicationStatus[] = [
  "DRAFT", "SUBMITTED", "UNDER_REVIEW", "DOCUMENTS_REQUIRED", "ELIGIBLE",
  "SHORTLISTED", "OFFERED", "ACCEPTED", "ENROLLED", "REJECTED", "WITHDRAWN",
];

describe("applicationStatusLabel", () => {
  it("labels every status with no invented words", () => {
    for (const s of ALL_STATUSES) {
      const label = applicationStatusLabel[s];
      expect(label).toBeTruthy();
      expect(label.toLowerCase()).not.toContain("approve");
      expect(label.toLowerCase()).not.toContain("waitlist");
    }
  });
});

describe("offeredPrograms", () => {
  const progA = { id: "a", name: "Arts", code: "A" };
  const progB = { id: "b", name: "Biology", code: "B" };

  it("dedupes a target also present in the join rows", () => {
    const result = offeredPrograms({ targetProgram: progA, programs: [{ programId: "a", program: progA }, { programId: "b", program: progB }] });
    expect(result).toEqual([progA, progB]);
  });

  it("includes a target-only campaign", () => {
    expect(offeredPrograms({ targetProgram: progA, programs: [] })).toEqual([progA]);
  });

  it("handles a null target", () => {
    expect(offeredPrograms({ targetProgram: null, programs: [{ programId: "b", program: progB }] })).toEqual([progB]);
  });
});

describe("canActOnOffer", () => {
  it("is true only for application OFFERED + offer ISSUED", () => {
    expect(canActOnOffer({ status: "OFFERED" }, { status: "ISSUED" })).toBe(true);
    for (const status of ["REJECTED", "WITHDRAWN", "ELIGIBLE"] as ApplicationStatus[]) {
      expect(canActOnOffer({ status }, { status: "ISSUED" })).toBe(false);
    }
    for (const offerStatus of ["ACCEPTED", "DECLINED", "EXPIRED"] as const) {
      expect(canActOnOffer({ status: "OFFERED" }, { status: offerStatus })).toBe(false);
    }
  });
});
