import { describe, it, expect } from "vitest";
import { filenameFromDisposition } from "../download";

describe("filenameFromDisposition", () => {
  it("reads a quoted filename", () => {
    expect(filenameFromDisposition('attachment; filename="leave-2026.xlsx"', "x.xlsx")).toBe("leave-2026.xlsx");
  });
  it("reads an unquoted filename", () => {
    expect(filenameFromDisposition("attachment; filename=report.xlsx", "x.xlsx")).toBe("report.xlsx");
  });
  it("falls back when the header is missing or has no filename", () => {
    expect(filenameFromDisposition(null, "x.xlsx")).toBe("x.xlsx");
    expect(filenameFromDisposition("attachment", "x.xlsx")).toBe("x.xlsx");
  });
});
