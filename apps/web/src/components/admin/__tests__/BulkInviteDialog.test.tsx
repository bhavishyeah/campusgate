import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const post = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api: { post: (...a: unknown[]) => post(...a) } };
});

import { ApiError } from "@/lib/api";
import { BulkInviteDialog, type BulkInviteResult } from "@/components/admin/BulkInviteDialog";

function result(over: Partial<BulkInviteResult> = {}): BulkInviteResult {
  return {
    dryRun: true,
    emailConfigured: true,
    eligibleTotal: 120,
    attempted: 100,
    sent: 0,
    failed: 0,
    skipped: {},
    failedRecently: 0,
    remainingNotInvited: 120,
    budget: { inviteCeiling: 250, inviteRemaining: 250 },
    results: [],
    ...over,
  };
}

beforeEach(() => post.mockReset());
afterEach(cleanup);

describe("BulkInviteDialog", () => {
  it("runs a dry run first and shows the batch size", async () => {
    post.mockResolvedValueOnce(result());
    render(<BulkInviteDialog onClose={() => {}} />);
    expect(await screen.findByText(/120 students not yet activated/)).toBeTruthy();
    expect(post).toHaveBeenCalledWith("/api/account-invites/bulk-students", { mode: "ALL_PENDING", dryRun: true });
    expect(screen.getByRole("button", { name: "Send 100 invites" })).toBeTruthy();
  });

  it("sends a batch and renders counts and per-user results", async () => {
    post.mockResolvedValueOnce(result()).mockResolvedValueOnce(
      result({
        dryRun: false,
        sent: 2,
        failed: 1,
        skipped: { recentlyInvited: 3, alreadyActivated: 0 },
        remainingNotInvited: 17,
        budget: { inviteCeiling: 250, inviteRemaining: 247 },
        results: [
          { userId: "u1", email: "a@x.edu", outcome: "SENT" },
          { userId: "u2", email: "b@x.edu", outcome: "SENT" },
          { userId: "u3", email: "c@x.edu", outcome: "FAILED" },
        ],
      }),
    );
    render(<BulkInviteDialog onClose={() => {}} />);
    await screen.findByText(/120 students/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send 100 invites" }));
    });
    expect(post).toHaveBeenLastCalledWith("/api/account-invites/bulk-students", { mode: "ALL_PENDING", dryRun: false });
    expect(await screen.findByText("a@x.edu")).toBeTruthy();
    expect(screen.getByText("Invited in the last 24 hours: 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send next batch" })).toBeTruthy();
  });

  it("disables sending and explains when email is not configured", async () => {
    post.mockResolvedValueOnce(result({ emailConfigured: false }));
    render(<BulkInviteDialog onClose={() => {}} />);
    expect(await screen.findByText(/not configured/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables the next batch when nothing remains", async () => {
    post.mockResolvedValueOnce(result({ remainingNotInvited: 0, eligibleTotal: 0 }));
    render(<BulkInviteDialog onClose={() => {}} />);
    await screen.findByText(/0 students not yet activated/);
    expect((screen.getByRole("button", { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a daily-limit message on 429", async () => {
    post.mockRejectedValueOnce(new ApiError(429, { code: "EMAIL_DAILY_LIMIT" }));
    render(<BulkInviteDialog onClose={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/daily email limit/);
  });
});
