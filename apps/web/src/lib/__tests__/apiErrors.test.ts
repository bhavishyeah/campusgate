import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";

afterEach(() => vi.restoreAllMocks());

describe("describeApiError", () => {
  it("returns a string server error verbatim", () => {
    expect(describeApiError(new ApiError(409, { error: "borrowing limit reached" }))).toBe(
      "borrowing limit reached",
    );
  });

  it("uses the first zod field error", () => {
    const e = new ApiError(400, { error: { formErrors: [], fieldErrors: { isbn: ["isbn must be 10 or 13 digits"] } } });
    expect(describeApiError(e)).toBe("isbn must be 10 or 13 digits");
  });

  it("falls back to the first form error", () => {
    const e = new ApiError(400, { error: { formErrors: ["bad body"], fieldErrors: {} } });
    expect(describeApiError(e)).toBe("bad body");
  });

  it("handles a missing body", () => {
    expect(describeApiError(new ApiError(400, {}))).toBe("Invalid request.");
  });

  it("uses a plain Error message", () => {
    expect(describeApiError(new Error("boom"))).toBe("boom");
  });

  it("maps TypeError to the network message", () => {
    expect(describeApiError(new TypeError("Failed to fetch"))).toBe(
      "Network error, check your connection.",
    );
  });

  it("applies an override by exact string", () => {
    const e = new ApiError(409, { error: "copy not available" });
    expect(describeApiError(e, { "copy not available": "Gone." })).toBe("Gone.");
    expect(describeApiError(new ApiError(409, { error: "other" }), { "copy not available": "Gone." })).toBe("other");
  });

  it("maps module-inactive 403", () => {
    const e = new ApiError(403, { error: "Module not active: library" });
    expect(describeApiError(e)).toBe("This module isn't enabled for your institution.");
  });

  it("maps any other 403", () => {
    const e = new ApiError(403, { error: "Forbidden: missing permission x" });
    expect(describeApiError(e)).toBe("You don't have permission to do that.");
  });

  it("logs once for 5xx and returns the server text", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(describeApiError(new ApiError(500, { error: "db down" }))).toBe(
      "Server error, please try again.",
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not log for 400, 409, 403 or TypeError", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    describeApiError(new ApiError(400, { error: "x" }));
    describeApiError(new ApiError(409, { error: "x" }));
    describeApiError(new ApiError(403, { error: "x" }));
    describeApiError(new TypeError("x"));
    expect(spy).not.toHaveBeenCalled();
  });
});
