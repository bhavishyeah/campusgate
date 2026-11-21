import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

const fetchMock = vi.fn();
function ok(body: unknown = {}): Response {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(ok());
  vi.stubGlobal("fetch", fetchMock);
  useAuthStore.setState({ token: "t" });
});
afterEach(() => vi.unstubAllGlobals());

const init = () => fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };

describe("body-less writes (Fastify rejects an empty JSON body)", () => {
  it.each([
    ["post", () => api.post("/x")],
    ["put", () => api.put("/x")],
    ["patch", () => api.patch("/x")],
    ["delete", () => api.delete("/x")],
  ])("%s without a body sends {} with the JSON content-type", async (_name, run) => {
    await run();
    expect(init().body).toBe("{}");
    expect(init().headers["Content-Type"]).toBe("application/json");
  });

  it("keeps a real body unchanged", async () => {
    await api.post("/x", { a: 1 });
    expect(init().body).toBe('{"a":1}');
  });

  it("sends no body on GET", async () => {
    await api.get("/x");
    expect(init().body).toBeUndefined();
  });
});