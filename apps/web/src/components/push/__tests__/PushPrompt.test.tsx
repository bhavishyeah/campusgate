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

  it("renders nothing for subscribed or denied and resyncs when already granted", async () => {
    push.getPushState.mockResolvedValue("subscribed");
    const { container } = render(<PushPrompt />);
    await waitFor(() => expect(push.resyncPush).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
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
    render(<PushPrompt />);
    expect(push.fetchPushConfig).toHaveBeenCalledTimes(1);
  });
});
