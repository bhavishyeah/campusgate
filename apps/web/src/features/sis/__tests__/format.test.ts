import { describe, it, expect } from "vitest";
import { programLabel } from "../format";

describe("sis programLabel", () => {
  it("shows the free-text program from the LIST response (not a dash)", () => {
    // The LIST endpoint returns `program` but not the structured relation.
    expect(programLabel({ program: "BCA", structuredProgram: null })).toBe("BCA");
    expect(programLabel({ program: "B.Tech CSE", structuredProgram: undefined })).toBe(
      "B.Tech CSE",
    );
  });

  it("prefers the structured Program name when it is hydrated (detail view)", () => {
    expect(
      programLabel({
        program: "legacy label",
        structuredProgram: { id: "p1", name: "Bachelor of Computer Applications", code: "BCA" },
      }),
    ).toBe("Bachelor of Computer Applications");
  });

  it("falls back to a dash only when neither is present", () => {
    expect(programLabel({ program: "", structuredProgram: null })).toBe("—");
    expect(programLabel({ program: "   ", structuredProgram: null })).toBe("—");
  });
});
