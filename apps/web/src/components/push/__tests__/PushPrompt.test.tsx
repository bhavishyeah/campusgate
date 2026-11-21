import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAuthStore } from "@/stores/auth";

const push = vi.hoisted(() => ({
  fetchPushConfig: vi.fn(),
  getPushState: vi.fn(),
  enablePush: vi.fn(),
  resyncPush: vi.fn(async () => {}),
}));
vi.mock("@/lib/push", () => push);

import { PushPrompt, resetPushPromptForTests } from "@/components/push/PushPrompt";

const cfg = { enabled: true, publicKey: "AQID" };

beforeEach(() => {
  vi.clearAllMocks();
  resetPushPromptForTests();
  localStorage.clear();
  push.fetchPushConfig.mockResolvedValue(cfg);
  useAuthStore.setState({ token: "t", user: { id: "u1", email: "a@x", role: "STUDENT", accountStatus: "ACTIVE" } });
});
afterEach(cleanup);

describe("PushPrompt", () => {
  it("shows the enable button for the default state and does not request permission on mount", async () => {
    push.getPushState.mockResolvedValue("default");
    render(<PushPrompt />);
    await screen.findByText("Enable notifications");
    expect(push.enablePush).not.toHaveBeenCalled();
  });

  it("calls enablePush only on click", async () => {
    push.getPushState.mockResolvedValue("default");
    push.enablePush.mockResolvedValue({ ok: true });
    render(<PushPrompt />);
    fireEvent.click(await screen.findByText("Enable notifications"));
    await waitFor(() => expect(push.enablePush).toHaveBeenCalledWith("AQID"));
    await waitFor(() => expect(screen.queryByText("Enable notifications")).toBeNull());
  });

  it("shows iOS instructions without a button and never enables", async () => {
    push.getPushState.mockResolvedValue("ios-install");
    render(<PushPrompt />);
    await screen.findByText(/Add to Home Screen/);
    expect(screen.queryByText("Enable notifications")).toBeNull();
    expect(push.enablePush).not.toHaveBeenCalled();
  });

  it("renders nothing for a subscribed device and resyncs", async () => {
    push.getPushState.mockResolvedValue("subscribed");
    const { container } = render(<PushPrompt />);
    await waitFor(() => expect(push.resyncPush).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it("a subscribed device stays hidden and resyncs even after a dismissal expired or is active", async () => {
    localStorage.setItem("cg.push.dismissed.u1", String(Date.now()));
    push.getPushState.mockResolvedValue("subscribed");
    const { container } = render(<PushPrompt />);
    await waitFor(() => expect(push.resyncPush).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it("shows unblock steps when notifications are denied, and they can be dismissed", async () => {
    push.getPushState.mockResolvedValue("denied");
    const { container } = render(<PushPrompt />);
    await screen.findByText(/blocked for this site/);
    expect(screen.getByText(/Permissions > Notifications > Allow/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(container.firstChild).toBeNull();
  });

  it("explains install steps when the prompt was dismissed or not shown", async () => {
    push.getPushState.mockResolvedValue("default");
    push.enablePush.mockResolvedValue({ ok: false, reason: "dismissed" });
    render(<PushPrompt />);
    fireEvent.click(await screen.findByText("Enable notifications"));
    const note = await screen.findByRole("status");
    expect(note.textContent).toMatch(/install CampusGate first/);
    expect(note.textContent).toMatch(/Permissions > Notifications > Allow/);
    expect(screen.getByText("Enable notifications")).toBeTruthy();
  });

  it("shows the error with a Try again button when enabling failed", async () => {
    push.getPushState.mockResolvedValue("default");
    push.enablePush.mockResolvedValueOnce({ ok: false, reason: "failed" }).mockResolvedValueOnce({ ok: true });
    render(<PushPrompt />);
    fireEvent.click(await screen.findByText("Enable notifications"));
    await screen.findByText("Could not enable notifications on this device");
    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(push.enablePush).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Try again")).toBeNull());
  });

  it("stays silent when the config call fails (platform account)", async () => {
    push.fetchPushConfig.mockRejectedValue(new Error("403"));
    const { container } = render(<PushPrompt />);
    await waitFor(() => expect(push.fetchPushConfig).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("dismissal hides the banner and persists for the user", async () => {
    push.getPushState.mockResolvedValue("default");
    const { container } = render(<PushPrompt />);
    fireEvent.click(await screen.findByLabelText("Dismiss"));
    expect(container.firstChild).toBeNull();
    expect(localStorage.getItem("cg.push.dismissed.u1")).toBeTruthy();

    cleanup();
    const again = render(<PushPrompt />);
    await waitFor(() => expect(push.getPushState).toHaveBeenCalledTimes(2));
    expect(again.container.firstChild).toBeNull();
  });
});
