import { describe, it, expect } from "vitest";
import { assignmentRoleLabel, changeTypeLabel, qualificationKindLabel } from "../labels";

describe("faculty labels", () => {
  it("covers every enum value", () => {
    expect(Object.keys(assignmentRoleLabel).sort()).toEqual(["ASSISTANT", "PRIMARY", "SUBSTITUTE"]);
    expect(Object.keys(changeTypeLabel).sort()).toEqual(["ASSIGNED", "ENDED"]);
    expect(Object.keys(qualificationKindLabel).sort()).toEqual(["CERTIFICATION", "DEGREE", "DIPLOMA", "OTHER"]);
  });
  it("uses human text", () => {
    expect(assignmentRoleLabel.PRIMARY).toBe("Primary");
    expect(changeTypeLabel.ENDED).toBe("Ended");
  });
});
