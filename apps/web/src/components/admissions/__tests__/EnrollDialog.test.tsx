import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EnrollDialog } from "@/components/admissions/EnrollDialog";
import { StudentPortalLink } from "@/components/admissions/StudentPortalLink";
import { resetSessionRefreshForTests } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

function res(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

const PREVIEW = {
  enrolled: false,
  roleMissing: false,
  suggestedEnrollmentNo: "BCA2026001",
  student: { name: "Asha Rao", programName: "BCA", departmentName: "Computer Science", sessionName: "2026-27", semester: 1 },
  willCreateProfile: true,
  existingEnrollmentNo: null,
  studentProfileId: null,
  hasPassword: true,
  emailConfigured: true,
  grants: ["STUDENT"],
  needsSession: false,
};

const RESULT = {
  enrollment: {},
  studentProfileId: "sp-1",
  enrollmentNo: "BCA2026001",
  created: true,
  roleGranted: true,
  accountSetup: "HAS_PASSWORD",
  email: "SENT",
};

const fetchMock = vi.fn();
let preview: Record<string, unknown>;
let enrollResponse: () => Response;

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EnrollDialog open onOpenChange={() => {}} applicationId="app-1" needsSession={false} />
    </QueryClientProvider>,
  );
}

const enrollCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/enroll"));
/** Wait for the preview: the suggestion lands in the field and confirm is enabled. */
async function ready(): Promise<HTMLInputElement> {
  const input = (await screen.findByLabelText("Enrollment number")) as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe("BCA2026001"));
  await waitFor(() => expect((screen.getByRole("button", { name: "Confirm and enroll" }) as HTMLButtonElement).disabled).toBe(false));
  return input;
}
const enrollBody = () => JSON.parse(enrollCalls()[0][1].body as string);

beforeEach(() => {
  fetchMock.mockReset();
  resetSessionRefreshForTests();
  preview = { ...PREVIEW };
  enrollResponse = () => res(201, RESULT);
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.endsWith("/enroll-preview")) return res(200, preview);
    if (u.endsWith("/enroll")) return enrollResponse();
    return res(404, { error: "unexpected " + u });
  });
  vi.stubGlobal("fetch", fetchMock);
  useAuthStore.setState({ token: "t", roles: ["ADMISSION_OFFICER"], permissions: ["admissions.enroll", "admissions.applications.view", "students.view"] });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EnrollDialog", () => {
  it("tells the officer what will happen and pre-fills the suggested number", async () => {
    renderDialog();
    expect(await screen.findByText(/Create the student record/)).toBeTruthy();
    expect(screen.getByText(/Grant student access/)).toBeTruthy();
    expect(screen.getByText(/Email the student an enrollment notice\./)).toBeTruthy();
    expect(await screen.findByText("Computer Science")).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("Enrollment number") as HTMLInputElement).value).toBe("BCA2026001"));
    expect(screen.getByRole("button", { name: "Confirm and enroll" })).toBeTruthy();
  });

  it("says no email is sent when email is not configured, and mentions the activation link for a passwordless applicant", async () => {
    preview = { ...PREVIEW, emailConfigured: false };
    renderDialog();
    expect(await screen.findByText(/Not send an email, because email is not configured/)).toBeTruthy();
    cleanup();
    preview = { ...PREVIEW, hasPassword: false };
    renderDialog();
    expect(await screen.findByText(/that includes an activation link/)).toBeTruthy();
  });

  it("omits enrollmentNo when the suggestion is untouched or cleared, and sends an edited value as typed", async () => {
    renderDialog();
    const input = (await screen.findByLabelText("Enrollment number")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("BCA2026001"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and enroll" }));
    await waitFor(() => expect(enrollCalls()).toHaveLength(1));
    expect(enrollBody()).toEqual({});
    cleanup();

    fetchMock.mockClear();
    renderDialog();
    const again = (await screen.findByLabelText("Enrollment number")) as HTMLInputElement;
    await waitFor(() => expect(again.value).toBe("BCA2026001"));
    fireEvent.change(again, { target: { value: "  CUSTOM-9 " } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm and enroll" }));
    await waitFor(() => expect(enrollCalls()).toHaveLength(1));
    expect(enrollBody()).toEqual({ enrollmentNo: "CUSTOM-9" });
    cleanup();

    fetchMock.mockClear();
    renderDialog();
    const cleared = (await screen.findByLabelText("Enrollment number")) as HTMLInputElement;
    await waitFor(() => expect(cleared.value).toBe("BCA2026001"));
    fireEvent.change(cleared, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm and enroll" }));
    await waitFor(() => expect(enrollCalls()).toHaveLength(1));
    expect(enrollBody()).toEqual({});
  });

  it("shows the resulting student with a link only for students.view, plus the email outcome", async () => {
    renderDialog();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and enroll" }));
    expect(await screen.findByText("Applicant enrolled")).toBeTruthy();
    expect(screen.getByText("BCA2026001")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open student record" }).getAttribute("href")).toBe("/sis/students/sp-1");
    expect(screen.getByText("An email was sent to the student.")).toBeTruthy();
    cleanup();

    useAuthStore.setState({ permissions: ["admissions.enroll"] });
    enrollResponse = () => res(201, { ...RESULT, email: "SKIPPED_NOT_CONFIGURED" });
    renderDialog();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and enroll" }));
    expect(await screen.findByText("Applicant enrolled")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open student record" })).toBeNull();
    expect(screen.getByText(/Use Resend invite on the Users page/)).toBeTruthy();
  });

  it("renders a 409 inline and keeps the dialog open", async () => {
    enrollResponse = () => res(409, { error: "Enrollment number already registered" });
    renderDialog();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and enroll" }));
    expect(await screen.findByText("Enrollment number already registered")).toBeTruthy();
    expect(screen.getByText(/Check the enrollment number and the applicant identity/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm and enroll" })).toBeTruthy();
  });

  it("shows a preview error inline and disables confirm", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/enroll-preview") ? res(409, { error: "application is not in ACCEPTED state" }) : res(404, {}),
    );
    renderDialog();
    expect(await screen.findByText("application is not in ACCEPTED state")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Confirm and enroll" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides the number field for an existing student record and shows its number", async () => {
    preview = { ...PREVIEW, willCreateProfile: false, suggestedEnrollmentNo: null, existingEnrollmentNo: "OLD-1" };
    renderDialog();
    expect(await screen.findByText(/Link the applicant's existing student record/)).toBeTruthy();
    expect(screen.queryByLabelText("Enrollment number")).toBeNull();
    expect(screen.getByText("OLD-1")).toBeTruthy();
  });
});

describe("StudentPortalLink", () => {
  it("links to the student portal when the session has the STUDENT role", () => {
    useAuthStore.setState({ roles: ["APPLICANT", "STUDENT"] });
    render(<StudentPortalLink />);
    expect(screen.getByRole("link", { name: "Open student portal" }).getAttribute("href")).toBe("/student");
  });
  it("asks the user to sign in again when the session still lacks it", () => {
    useAuthStore.setState({ roles: ["APPLICANT"] });
    render(<StudentPortalLink />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Sign out and back in to open the student portal.")).toBeTruthy();
  });
});
