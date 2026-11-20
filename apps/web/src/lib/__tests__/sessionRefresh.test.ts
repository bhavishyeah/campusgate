import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, resetSessionRefreshForTests, setSessionRefreshListener } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

// A minimal unsigned JWT: decodeAuthClaims only reads the payload segment.
function jwtWith(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

const oldToken = jwtWith({ userId: "u1", roles: ["APPLICANT"], permissions: ["admissions.view_own"], permissionsVersion: 0 });
const newToken = jwtWith({ userId: "u1", roles: ["APPLICANT", "STUDENT"], permissions: ["admissions.view_own", "fees.view_own"], permissionsVersion: 1 });
const user = { id: "u1", email: "a@x.edu", role: "STUDENT", accountStatus: "ACTIVE" };

describe("x-session-stale handling", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    resetSessionRefreshForTests();
    vi.stubGlobal("fetch", fetchMock);
    useAuthStore.setState({ token: oldToken, user, roles: ["APPLICANT"], permissions: ["admissions.view_own"], permissionsVersion: 0 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const refreshCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/auth/refresh"));
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("refreshes once, swaps the token and claims, and notifies the listener", async () => {
    const listener = vi.fn();
    setSessionRefreshListener(listener);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/api/auth/refresh") ? res(200, { token: newToken, user }) : res(200, { ok: true }, { "x-session-stale": "1" }),
    );
    await api.get("/api/admissions/applications/mine");
    await settle();
    expect(refreshCalls()).toHaveLength(1);
    const [, init] = refreshCalls()[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(init.headers.Authorization).toBe(`Bearer ${oldToken}`);
    const s = useAuthStore.getState();
    expect(s.token).toBe(newToken);
    expect(s.roles).toEqual(["APPLICANT", "STUDENT"]);
    expect(s.permissions).toContain("fees.view_own");
    expect(s.permissionsVersion).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not refresh again within 30 seconds, and refreshes again after that", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/api/auth/refresh") ? res(200, { token: oldToken, user }) : res(200, {}, { "x-session-stale": "1" }),
    );
    await api.get("/api/a");
    await settle();
    await api.get("/api/b");
    await settle();
    expect(refreshCalls()).toHaveLength(1);
    vi.setSystemTime(new Date("2027-01-01T00:00:31Z"));
    await api.get("/api/c");
    await settle();
    expect(refreshCalls()).toHaveLength(2);
  });

  it("coalesces concurrent stale responses into one refresh", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/api/auth/refresh")) {
        await gate;
        return res(200, { token: newToken, user });
      }
      return res(200, {}, { "x-session-stale": "1" });
    });
    await Promise.all([api.get("/api/a"), api.get("/api/b"), api.get("/api/c")]);
    release();
    await settle();
    expect(refreshCalls()).toHaveLength(1);
  });

  it("never refreshes for /api/auth/* calls or when the header is absent", async () => {
    fetchMock.mockResolvedValue(res(200, {}, { "x-session-stale": "1" }));
    await api.get("/api/auth/me");
    await settle();
    fetchMock.mockResolvedValue(res(200, {}));
    await api.get("/api/other");
    await settle();
    expect(refreshCalls()).toHaveLength(0);
  });

  it("a failed refresh does not log out and does not break the original request", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/api/auth/refresh") ? res(401, { error: "Unauthorized" }) : res(200, { fine: true }, { "x-session-stale": "1" }),
    );
    await expect(api.get("/api/a")).resolves.toEqual({ fine: true });
    await settle();
    expect(useAuthStore.getState().token).toBe(oldToken);

    resetSessionRefreshForTests();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/api/auth/refresh")) throw new Error("network");
      return res(200, { fine: true }, { "x-session-stale": "1" });
    });
    await expect(api.get("/api/a")).resolves.toEqual({ fine: true });
    await settle();
    expect(useAuthStore.getState().token).toBe(oldToken);
  });

  it("discards the refreshed token if the user logged out meanwhile", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/api/auth/refresh")) {
        await gate;
        return res(200, { token: newToken, user });
      }
      return res(200, {}, { "x-session-stale": "1" });
    });
    await api.get("/api/a");
    useAuthStore.getState().logout();
    release();
    await settle();
    expect(useAuthStore.getState().token).toBeNull();
  });
});
