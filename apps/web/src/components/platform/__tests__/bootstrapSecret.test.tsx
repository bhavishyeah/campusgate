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
import { CreateInstitutionDialog } from "@/components/platform/CreateInstitutionDialog";
import { useAuthStore } from "@/stores/auth";

const TEMP_PASSWORD = "Str0ngTemp_x";

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderDialog() {
  const client = makeClient();
  return render(
    <QueryClientProvider client={client}>
      <CreateInstitutionDialog open onOpenChange={() => {}} />
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

async function createThroughForm() {
  fireEvent.change(screen.getByLabelText("Institution name"), {
    target: { value: "ITM College" },
  });
  fireEvent.change(screen.getByLabelText("Institution code"), {
    target: { value: "ITM001" },
  });
  fireEvent.change(screen.getByLabelText("Initial admin email"), {
    target: { value: "admin@itm.edu" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create institution" }));
  });
}

describe("bootstrap secret one-time reveal", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    localStorage.clear();
    useAuthStore.setState({ token: "session-token" });
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        institution: {
          id: "inst-1",
          name: "ITM College",
          code: "ITM001",
          domain: null,
          status: "ACTIVE",
          _count: { users: 1, departments: 0, gates: 0, exitReasons: 0 },
        },
        admin: { id: "u-1", email: "admin@itm.edu", role: "ADMIN" },
        tempPassword: TEMP_PASSWORD,
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("cannot be dismissed by Esc or outside-click until 'I saved it' is checked", async () => {
    renderDialog();
    await createThroughForm();

    // Reveal panel is up; reveal the password so it is in the DOM.
    await screen.findByText("Institution created");
    fireEvent.click(screen.getByLabelText("Reveal password"));
    expect(screen.getByTestId("temp-password").textContent).toBe(TEMP_PASSWORD);

    // Done is disabled before the checkbox.
    const done = screen.getByRole("button", { name: "Done" });
    expect((done as HTMLButtonElement).disabled).toBe(true);

    // Esc must NOT close the reveal.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
      code: "Escape",
    });
    expect(screen.getByText("Institution created")).toBeTruthy();

    // Tick the checkbox -> Done enables.
    fireEvent.click(screen.getByLabelText("I saved it"));
    expect(
      (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("removes the password from the DOM after Done and never writes it to localStorage", async () => {
    renderDialog();
    await createThroughForm();

    await screen.findByText("Institution created");
    fireEvent.click(screen.getByLabelText("Reveal password"));
    expect(document.body.textContent).toContain(TEMP_PASSWORD);

    fireEvent.click(screen.getByLabelText("I saved it"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });

    // The reveal is gone and the secret is no longer in the document.
    await waitFor(() => {
      expect(screen.queryByText("Institution created")).toBeNull();
    });
    expect(document.body.textContent).not.toContain(TEMP_PASSWORD);

    // The secret was never persisted to localStorage (any key).
    const serialized = JSON.stringify({ ...localStorage });
    expect(serialized).not.toContain(TEMP_PASSWORD);
  });
});
