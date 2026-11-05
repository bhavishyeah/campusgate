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
import { SupportGrantForm } from "@/components/platform/SupportGrantForm";
import { useAuthStore } from "@/stores/auth";

// next/navigation is pulled in transitively by shared imports in some trees;
// SupportGrantForm itself doesn't use it, so no router mock is needed.

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderForm() {
  const client = makeClient();
  return render(
    <QueryClientProvider client={client}>
      <SupportGrantForm open institutionId="inst-1" onOpenChange={() => {}} />
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

describe("support grant step-up retry loop", () => {
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

  it("opens step-up on 401, mints a token, retries with x-step-up and does not log out", async () => {
    const logoutSpy = vi.spyOn(useAuthStore.getState(), "logout");

    // 1) create (no token) -> 401 Step-up required
    // 2) /api/auth/mfa/verify -> mints a token
    // 3) create (with token) -> 201
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/auth/mfa/verify")) {
        return jsonResponse(200, {
          stepUpToken: "stepup-xyz",
          action: "support_grant.create",
          expiresIn: 300,
        });
      }
      if (url.endsWith("/api/platform/support-grants")) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (headers["x-step-up"]) {
          return jsonResponse(201, { id: "g-1", status: "ACTIVE" });
        }
        return jsonResponse(401, { error: "Step-up required" });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    renderForm();

    // Fill the form.
    fireEvent.change(screen.getByLabelText("Purpose"), {
      target: { value: "Investigating a locked account" },
    });
    const future = new Date(Date.now() + 60 * 60 * 1000);
    // datetime-local wants "YYYY-MM-DDTHH:mm"
    const local = new Date(future.getTime() - future.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    fireEvent.change(screen.getByLabelText("Expires at"), {
      target: { value: local },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create grant" }));
    });

    // Step-up dialog should appear after the 401.
    await screen.findByText("Confirm it's you");

    // Enter the code and verify.
    fireEvent.change(screen.getByLabelText("Authentication code"), {
      target: { value: "123456" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    });

    // The retry must carry the minted token and yield a 201.
    await waitFor(() => {
      const retried = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]).endsWith("/api/platform/support-grants") &&
          ((c[1]?.headers ?? {}) as Record<string, string>)["x-step-up"] ===
            "stepup-xyz",
      );
      expect(retried).toBeTruthy();
    });

    // The operator was never logged out by the 401 step-up challenge.
    expect(logoutSpy).not.toHaveBeenCalled();
  });
});
