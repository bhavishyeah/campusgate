import { describe, it, expect } from "vitest";
import { describeInsufficientBalance } from "../errors";

describe("describeInsufficientBalance", () => {
  it("formats numeric extras", () => {
    expect(describeInsufficientBalance({ error: "insufficient leave balance", remaining: 2, requested: 3 })).toBe(
      "Remaining 2 days, requested 3 days.",
    );
  });
  it("returns null when extras are missing or not numbers", () => {
    expect(describeInsufficientBalance({ error: "x" })).toBeNull();
    expect(describeInsufficientBalance({ remaining: "2", requested: 3 })).toBeNull();
    expect(describeInsufficientBalance(undefined)).toBeNull();
  });
});
