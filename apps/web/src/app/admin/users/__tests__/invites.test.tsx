import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } };
});

import AdminUsersPage from "@/app/admin/users/page";

const users = [
  { id: "s1", email: "stu@x.edu", role: "STUDENT", accountStatus: "ACTIVE", createdAt: "", hasPassword: false, lastInviteSentAt: null,
    studentProfile: { name: "Stu", enrollmentNo: "E1" } },
  { id: "h1", email: "hod@x.edu", role: "HOD", accountStatus: "ACTIVE", createdAt: "", hasPassword: false, lastInviteSentAt: "2027-01-01T00:00:00Z",
    hodProfile: { name: "Hod" } },
  { id: "a1", email: "adm@x.edu", role: "ADMIN", accountStatus: "ACTIVE", createdAt: "", hasPassword: true, lastInviteSentAt: null },
  { id: "p1", email: "pend@x.edu", role: "STUDENT", accountStatus: "PENDING_APPROVAL", createdAt: "", hasPassword: true,
    studentProfile: { name: "Pend", enrollmentNo: "E2" } },
];

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockImplementation(async (url: string) =>
    url.startsWith("/api/admin/users")
      ? { users, pagination: { page: 1, limit: 20, total: users.length, totalPages: 1 } }
      : [],
  );
  post.mockResolvedValue({});
});
afterEach(cleanup);

describe("admin users page: invites and reject", () => {
  it("offers invites only for active users without a password, with Resend after a prior invite", async () => {
    render(<AdminUsersPage />);
    await screen.findByText("stu@x.edu");
    expect(screen.getAllByRole("button", { name: /^send invite/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /resend invite/i })).toHaveLength(1);
  });

  it("confirms before sending a student invite and reports the result", async () => {
    render(<AdminUsersPage />);
    await screen.findByText("stu@x.edu");
    fireEvent.click(screen.getByRole("button", { name: /^send invite/i }));
    expect(post).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    });
    expect(post).toHaveBeenCalledWith("/api/account-invites/students/s1");
    expect((await screen.findByRole("status")).textContent).toMatch(/Invite sent to stu@x.edu/);
  });

  it("uses the staff route for non-students", async () => {
    render(<AdminUsersPage />);
    await screen.findByText("hod@x.edu");
    fireEvent.click(screen.getByRole("button", { name: /resend invite/i }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Resend" }));
    });
    expect(post).toHaveBeenCalledWith("/api/account-invites/users/h1");
  });

  it("shows a clear message when email is not configured", async () => {
    const { ApiError } = await import("@/lib/api");
    post.mockRejectedValueOnce(new ApiError(503, { code: "EMAIL_NOT_CONFIGURED", error: "x" }));
    render(<AdminUsersPage />);
    await screen.findByText("stu@x.edu");
    fireEvent.click(screen.getByRole("button", { name: /^send invite/i }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Send" }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/not configured/));
  });

  it("confirms before rejecting a pending registration", async () => {
    render(<AdminUsersPage />);
    await screen.findByText("pend@x.edu");
    fireEvent.click(screen.getByRole("button", { name: /^reject/i }));
    expect(post).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reject" }));
    });
    expect(post).toHaveBeenCalledWith("/api/admin/users/p1/reject");
  });
});
