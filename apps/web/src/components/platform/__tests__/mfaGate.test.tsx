import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MfaEnrollmentGate, useMfaGate } from "@/components/platform/MfaEnrollmentGate";
import { useStats } from "@/features/platform/hooks";
import { useAuthStore } from "@/stores/auth";

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

// A minimal platform screen: runs a query and reports its error into the gate,
// exactly as the real dashboard does.
function Screen() {
  const stats = useStats();
  const { reportError } = useMfaGate();
  useEffect(() => {
    if (stats.error) reportError(stats.error);
  }, [stats.error, reportError]);
  if (stats.isLoading) return <div>loading</div>;
  if (stats.isError) return <div>load error</div>;
  return <div>stats ready: {stats.data?.institutions.total}</div>;
}

function renderScreen() {
  const client = makeClient();
  return render(
    <QueryClientProvider client={client}>
      <MfaEnrollmentGate>
        <Screen />
      </MfaEnrollmentGate>
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

describe("MFA enrollment gate", () => {
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

  it("shows the enrollment CTA on a 403 MFA-required (no error/logout) and clears after enrolling", async () => {
    const logoutSpy = vi.spyOn(useAuthStore.getState(), "logout");
    let statsEnrolled = false;

    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/platform/stats")) {
        if (!statsEnrolled) {
          return jsonResponse(403, { error: "MFA enrollment required" });
        }
        return jsonResponse(200, {
          institutions: { total: 3, active: 3, suspended: 0 },
          users: { total: 10, students: 8 },
          movement: { totalPasses: 0, currentlyOutside: 0 },
        });
      }
      if (url.endsWith("/api/auth/mfa/enroll/start")) {
        return jsonResponse(200, {
          otpauthUri: "otpauth://totp/x",
          qrCodeDataUrl: "data:image/png;base64,AAAA",
        });
      }
      if (url.endsWith("/api/auth/mfa/enroll/verify")) {
        statsEnrolled = true;
        return jsonResponse(200, { enabled: true, recoveryCodes: ["code-1"] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    renderScreen();

    // The gate CTA appears instead of an error, and we were not logged out.
    await screen.findByText("Set up MFA to continue");
    expect(screen.queryByText("load error")).toBeNull();
    expect(logoutSpy).not.toHaveBeenCalled();

    // Open enrollment and wait for the start call to render the verify form.
    fireEvent.click(screen.getByRole("button", { name: "Enable MFA" }));
    const codeInput = await screen.findByLabelText("Verification code");

    fireEvent.change(codeInput, { target: { value: "123456" } });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Verify & enable MFA" }),
      );
    });

    // Recovery-code step -> Done clears the gate and invalidates ['platform'].
    const doneBtn = await screen.findByRole("button", { name: "Done" });
    await act(async () => {
      fireEvent.click(doneBtn);
    });

    // The gate is cleared and the screen reloads with the now-successful query.
    await waitFor(() => {
      expect(screen.getByText(/stats ready: 3/)).toBeTruthy();
    });
    expect(logoutSpy).not.toHaveBeenCalled();
  });
});
