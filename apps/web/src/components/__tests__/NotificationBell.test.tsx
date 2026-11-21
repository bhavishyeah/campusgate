import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));
vi.mock("@/lib/socket", () => ({ onMessage: () => () => {} }));
vi.mock("next/link", () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }));

import { NotificationBell } from "@/components/NotificationBell";

const item = (id: string, read = false) => ({
  id, title: `T${id}`, body: "b", type: "X", data: null, read, createdAt: new Date().toISOString(),
});
const list = (unread: number, items = [item("1"), item("2")]) => ({
  notifications: items,
  unreadCount: unread,
  pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 },
});

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation(async (url: string) =>
    url.includes("unread-count") ? { unreadCount: 2 } : list(2),
  );
});
afterEach(cleanup);

async function open() {
  render(<NotificationBell />);
  await screen.findByLabelText("Notifications, 2 unread");
  fireEvent.click(screen.getByLabelText("Notifications, 2 unread"));
  await screen.findByText("T1");
}

describe("NotificationBell mark as read", () => {
  it("markRead posts to the item endpoint and takes the unread count from the server", async () => {
    api.post.mockResolvedValue({ unreadCount: 1 });
    await open();
    fireEvent.click(screen.getByLabelText('Mark "T1" as read'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/notifications/1/read"));
    await screen.findByLabelText("Notifications, 1 unread");
  });

  it("markRead reconciles by refetching when the server fails", async () => {
    api.post.mockRejectedValue(new Error("400"));
    await open();
    const before = api.get.mock.calls.length;
    fireEvent.click(screen.getByLabelText('Mark "T1" as read'));
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(before));
    await screen.findByLabelText("Notifications, 2 unread");
  });

  it("markAllRead posts to read-all and the badge takes the server count", async () => {
    api.post.mockResolvedValue({ success: true, updated: 2, unreadCount: 0 });
    await open();
    fireEvent.click(screen.getByText("Mark all read"));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/notifications/read-all"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy());
  });

  it("markAllRead reconciles by refetching when the server fails", async () => {
    api.post.mockRejectedValue(new Error("500"));
    await open();
    const before = api.get.mock.calls.length;
    fireEvent.click(screen.getByText("Mark all read"));
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(before));
    await screen.findByLabelText("Notifications, 2 unread");
  });
});
