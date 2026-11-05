import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { GrantList } from "@/components/platform/GrantList";
import { useAuthStore } from "@/stores/auth";
import type { SupportGrant } from "@/features/platform/types";

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const grant: SupportGrant = {
  id: "g-1",
  institutionId: "inst-1",
  grantedToUserId: "u-op",
  purpose: "Investigating a locked account",
  status: "ACTIVE",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  activatedAt: null,
  createdAt: new Date().toISOString(),
};

function renderList() {
  const client = makeClient();
  return render(
    <QueryClientProvider client={client}>
      <GrantList grants={[grant]} isLoading={false} isError={false} error={null} />
    </QueryClientProvider>,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("support grant revoke reason", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    useAuthStore.setState({ token: "session-token" });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("transmits the entered reason in the DELETE request body", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/platform/support-grants/g-1")) {
        return jsonResponse(200, { ...grant, status: "REVOKED", revokedReason: "duplicate grant" });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    renderList();

    // Open the confirm dialog.
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    // Type a reason.
    const textarea = await screen.findByLabelText("Reason (optional)");
    fireEvent.change(textarea, { target: { value: "duplicate grant" } });

    // Confirm.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Revoke grant" }));
    });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) =>
        String(c[0]).endsWith("/api/platform/support-grants/g-1"),
      );
      expect(call).toBeTruthy();
      const init = call![1] as RequestInit;
      expect(init.method).toBe("DELETE");
      expect(JSON.parse(String(init.body))).toEqual({ reason: "duplicate grant" });
    });
  });

  it("omits the body when no reason is entered", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/api/platform/support-grants/g-1")) {
        return jsonResponse(200, { ...grant, status: "REVOKED" });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await screen.findByLabelText("Reason (optional)");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Revoke grant" }));
    });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) =>
        String(c[0]).endsWith("/api/platform/support-grants/g-1"),
      );
      expect(call).toBeTruthy();
      const init = call![1] as RequestInit;
      expect(init.method).toBe("DELETE");
      expect(init.body).toBeUndefined();
    });
  });
});
