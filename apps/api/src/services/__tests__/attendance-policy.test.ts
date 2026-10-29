import { describe, expect, it } from "vitest";
import type { AttendanceStatus } from "@campusgate/db";
import {
  attendancePolicy,
  attendanceRate,
  crossedBelowThreshold,
} from "../attendance-policy.js";

const r = (status: AttendanceStatus) => ({ status });

describe("attendancePolicy (defaults + overrides)", () => {
  it("returns documented defaults when settings is absent/invalid", () => {
    for (const input of [null, undefined, 42, "x", []]) {
      const p = attendancePolicy(input);
      expect(p.presentStatuses).toEqual(["PRESENT", "LATE"]);
      expect(p.lowAttendanceThresholdPercent).toBe(75);
      expect(p.allowSelfCorrectionBeforeFinalize).toBe(true);
    }
  });

  it("applies valid overrides and ignores invalid keys", () => {
    const p = attendancePolicy({
      presentStatuses: ["PRESENT"],
      lowAttendanceThresholdPercent: 60,
      allowSelfCorrectionBeforeFinalize: false,
    });
    expect(p.presentStatuses).toEqual(["PRESENT"]);
    expect(p.lowAttendanceThresholdPercent).toBe(60);
    expect(p.allowSelfCorrectionBeforeFinalize).toBe(false);
  });

  it("falls back when overrides are invalid (empty array, out-of-range, bad type)", () => {
    const p = attendancePolicy({
      presentStatuses: ["NOPE", 3],
      lowAttendanceThresholdPercent: 150,
      allowSelfCorrectionBeforeFinalize: "yes",
    });
    expect(p.presentStatuses).toEqual(["PRESENT", "LATE"]);
    expect(p.lowAttendanceThresholdPercent).toBe(75);
    expect(p.allowSelfCorrectionBeforeFinalize).toBe(true);
  });
});

describe("attendanceRate (EXCUSED excluded from numerator AND denominator)", () => {
  const policy = attendancePolicy(null); // present = PRESENT|LATE, threshold 75

  it("counts PRESENT + LATE as present over non-EXCUSED denominator", () => {
    // 3 present-ish (PRESENT, LATE) out of 4 non-EXCUSED => 75
    const records = [r("PRESENT"), r("LATE"), r("PRESENT"), r("ABSENT")];
    expect(attendanceRate(records, policy)).toBe(75);
  });

  it("excludes EXCUSED from both numerator and denominator", () => {
    // EXCUSED dropped entirely: 1 PRESENT out of 2 non-EXCUSED => 50
    const records = [r("PRESENT"), r("ABSENT"), r("EXCUSED"), r("EXCUSED")];
    expect(attendanceRate(records, policy)).toBe(50);
  });

  it("returns null when there are no non-EXCUSED records", () => {
    expect(attendanceRate([], policy)).toBeNull();
    expect(attendanceRate([r("EXCUSED"), r("EXCUSED")], policy)).toBeNull();
  });

  it("respects a presentStatuses override (LATE not counted)", () => {
    const strict = attendancePolicy({ presentStatuses: ["PRESENT"] });
    // only PRESENT counts: 1 of 3 => 33.33...
    const records = [r("PRESENT"), r("LATE"), r("ABSENT")];
    expect(attendanceRate(records, strict)).toBeCloseTo((1 / 3) * 100, 6);
  });
});

describe("crossedBelowThreshold (downward crossing only)", () => {
  it("fires when prior >= threshold and post < threshold", () => {
    expect(crossedBelowThreshold(80, 70, 75)).toBe(true);
  });

  it("fires on first finalize (no prior history) if post < threshold", () => {
    expect(crossedBelowThreshold(null, 50, 75)).toBe(true);
  });

  it("does NOT re-fire when already below threshold before", () => {
    expect(crossedBelowThreshold(60, 55, 75)).toBe(false);
  });

  it("does NOT fire when post is at/above threshold", () => {
    expect(crossedBelowThreshold(90, 80, 75)).toBe(false);
    expect(crossedBelowThreshold(null, 75, 75)).toBe(false);
  });

  it("does NOT fire when post is null (no countable records)", () => {
    expect(crossedBelowThreshold(80, null, 75)).toBe(false);
  });
});
