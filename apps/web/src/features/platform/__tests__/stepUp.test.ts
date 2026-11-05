import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { PlatformStepUpError, postWithStepUp } from "../stepUp";

const SUPPORT_GRANT_CREATE = "support_grant.create";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("postWithStepUp", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    useAuthStore.setState({ token: "session-token" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("attaches x-step-up ONLY when a token is passed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: "g-1" }));
    await postWithStepUp("/api/platform/support-grants", { purpose: "x" }, "stepup-123");

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-step-up"]).toBe("stepup-123");
    expect(headers["Authorization"]).toBe("Bearer session-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("omits x-step-up when no token is passed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: "g-1" }));
    await postWithStepUp("/api/platform/support-grants", { purpose: "x" });

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-step-up"]).toBeUndefined();
  });

  it("documents the caller's step-up action string as 'support_grant.create'", () => {
    // The only step-up-gated platform route; the dialog passes this action.
    expect(SUPPORT_GRANT_CREATE).toBe("support_grant.create");
  });

  it("returns the parsed body on 2xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: "g-9", status: "ACTIVE" }));
    const result = await postWithStepUp<{ id: string }>(
      "/api/platform/support-grants",
      { purpose: "x" },
      "stepup-123",
    );
    expect(result).toEqual({ id: "g-9", status: "ACTIVE" });
  });

  it("throws PlatformStepUpError (no logout) on 401 Step-up required", async () => {
    const logoutSpy = vi.spyOn(useAuthStore.getState(), "logout");
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "Step-up required" }));

    await expect(
      postWithStepUp("/api/platform/support-grants", { purpose: "x" }),
    ).rejects.toBeInstanceOf(PlatformStepUpError);
    expect(logoutSpy).not.toHaveBeenCalled();
  });

  it("logs out and throws ApiError on a session-expiry 401", async () => {
    const logoutSpy = vi.spyOn(useAuthStore.getState(), "logout");
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }));

    await expect(
      postWithStepUp("/api/platform/support-grants", { purpose: "x" }, "stepup-123"),
    ).rejects.toBeInstanceOf(ApiError);
    expect(logoutSpy).toHaveBeenCalledTimes(1);
  });
});
