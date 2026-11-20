import { StrictMode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const post = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api: { post: (...a: unknown[]) => post(...a) } };
});
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ApiError } from "@/lib/api";
import ResetPasswordPage from "@/app/reset-password/page";
import ActivatePage from "@/app/activate/page";
import ForgotPasswordPage from "@/app/forgot-password/page";

const TOKEN = "T".repeat(43);

function fillAndSubmit(password: string, confirm: string, button: RegExp) {
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: confirm } });
  return act(async () => {
    fireEvent.click(screen.getByRole("button", { name: button }));
  });
}

beforeEach(() => {
  post.mockReset();
  window.history.replaceState(null, "", "/");
});
afterEach(cleanup);

describe("reset-password page", () => {
  it("keeps the token under StrictMode double mount, clears the hash, and posts it", async () => {
    window.history.replaceState(null, "", `/reset-password#token=${TOKEN}`);
    post.mockResolvedValue({ message: "Password updated. You can now sign in." });
    render(
      <StrictMode>
        <ResetPasswordPage />
      </StrictMode>,
    );
    await screen.findByLabelText("New password");
    expect(window.location.hash).toBe("");

    await fillAndSubmit("newpassword1", "newpassword1", /reset password/i);
    expect(post).toHaveBeenCalledWith("/api/auth/reset-password", { token: TOKEN, password: "newpassword1" });
    expect(await screen.findByText(/Password updated/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
  });

  it("shows the no-token state with a link to request a new one", async () => {
    render(<ResetPasswordPage />);
    expect(await screen.findByText("This link is invalid or has expired.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /request a new link/i }).getAttribute("href")).toBe("/forgot-password");
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("does not call the API when passwords do not match", async () => {
    window.history.replaceState(null, "", `/reset-password#token=${TOKEN}`);
    render(<ResetPasswordPage />);
    await screen.findByLabelText("New password");
    await fillAndSubmit("newpassword1", "newpassword2", /reset password/i);
    expect(post).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toMatch(/do not match/);
  });

  it("shows the server message on 400", async () => {
    window.history.replaceState(null, "", `/reset-password#token=${TOKEN}`);
    post.mockRejectedValue(new ApiError(400, { error: "This link is invalid or has expired. Request a new one." }));
    render(<ResetPasswordPage />);
    await screen.findByLabelText("New password");
    await fillAndSubmit("newpassword1", "newpassword1", /reset password/i);
    expect((await screen.findByRole("alert")).textContent).toMatch(/invalid or has expired/);
  });
});

describe("activate page", () => {
  it("posts to the activate endpoint", async () => {
    window.history.replaceState(null, "", `/activate#token=${TOKEN}`);
    post.mockResolvedValue({ message: "Account activated. You can now sign in." });
    render(<ActivatePage />);
    await screen.findByLabelText("New password");
    await fillAndSubmit("newpassword1", "newpassword1", /activate account/i);
    expect(post).toHaveBeenCalledWith("/api/auth/activate", { token: TOKEN, password: "newpassword1" });
    expect(await screen.findByText(/Account activated/)).toBeTruthy();
  });
});

describe("forgot-password page", () => {
  it("shows the generic message after submitting", async () => {
    post.mockResolvedValue({ message: "If an account exists for that email, we have sent a link. Check your inbox." });
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.edu" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /send link/i }));
    });
    expect(post).toHaveBeenCalledWith("/api/auth/forgot-password", { email: "a@b.edu" });
    expect(await screen.findByText(/If an account exists/)).toBeTruthy();
  });

  it("shows a retry message on 429", async () => {
    post.mockRejectedValue(new ApiError(429, { error: "Too many requests. Try again later." }));
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.edu" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /send link/i }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Too many attempts/));
  });
});
