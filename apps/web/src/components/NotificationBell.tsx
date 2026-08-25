"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Check, CheckCheck } from "lucide-react";
import { api } from "@/lib/api";
import { onMessage } from "@/lib/socket";

interface Notification {
  id: string;
  title: string;
  body: string;
  type: string;
  data: Record<string, unknown> | null;
  read: boolean;
  createdAt: string;
}

interface NotificationsResponse {
  notifications: Notification[];
  unreadCount: number;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

/** Dark variant matches the guard/admin dark chrome; light suits student/HOD. */
type Variant = "light" | "dark";

function relativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function typeAccent(type: string) {
  if (type.includes("APPROVED")) return "bg-success-500";
  if (type.includes("REJECTED")) return "bg-danger-500";
  if (type.includes("OVERDUE")) return "bg-warning-500";
  return "bg-primary-500";
}

export function NotificationBell({ variant = "light" }: { variant?: Variant }) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const isDark = variant === "dark";

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get<NotificationsResponse>("/api/notifications?limit=20");
      setNotifications(res.notifications);
      setUnreadCount(res.unreadCount);
    } catch (err: any) {
      setError(err.message || "Could not load notifications");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial unread count so the badge is accurate before the panel is opened
  useEffect(() => {
    api
      .get<{ unreadCount: number }>("/api/notifications/unread-count")
      .then((res) => setUnreadCount(res.unreadCount))
      .catch(() => {});
  }, []);

  // Live updates: prepend the incoming notification and bump the badge
  useEffect(() => {
    return onMessage("notification", (incoming: Notification) => {
      setNotifications((prev) => {
        if (prev.some((n) => n.id === incoming.id)) return prev;
        return [incoming, ...prev].slice(0, 20);
      });
      setUnreadCount((c) => c + 1);
    });
  }, []);

  // Close on outside click and on Escape
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) fetchNotifications();
  };

  const markRead = async (id: string) => {
    // Optimistic: flip locally, then reconcile the count from the server
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      const res = await api.post<{ unreadCount: number }>(
        `/api/notifications/${id}/read`
      );
      setUnreadCount(res.unreadCount);
    } catch {
      fetchNotifications();
    }
  };

  const markAllRead = async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
    try {
      await api.post("/api/notifications/read-all");
    } catch {
      fetchNotifications();
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={toggle}
        className={`relative p-2 rounded-lg transition-colors ${
          isDark
            ? "text-gray-300 hover:text-white hover:bg-gray-700"
            : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
        }`}
        aria-label={
          unreadCount > 0
            ? `Notifications, ${unreadCount} unread`
            : "Notifications"
        }
        aria-expanded={open}
        aria-haspopup="true"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-danger-600 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 mt-2 w-80 sm:w-96 bg-white rounded-xl shadow-lg border border-gray-200 z-50 max-h-[70vh] flex flex-col"
          role="dialog"
          aria-label="Notifications"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900 text-sm">
              Notifications
              {unreadCount > 0 && (
                <span className="ml-2 text-xs font-normal text-gray-500">
                  {unreadCount} unread
                </span>
              )}
            </h2>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                Mark all read
              </button>
            )}
          </div>

          <div className="overflow-y-auto flex-1">
            {loading ? (
              <p className="text-sm text-gray-500 text-center py-8 animate-pulse">
                Loading...
              </p>
            ) : error ? (
              <p className="text-sm text-danger-700 text-center py-8 px-4">
                {error}
              </p>
            ) : notifications.length === 0 ? (
              <div className="text-center py-10 px-4">
                <Bell className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-500">No notifications yet</p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {notifications.map((n) => (
                  <li
                    key={n.id}
                    className={`px-4 py-3 flex gap-3 ${
                      n.read ? "" : "bg-primary-50/40"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                        n.read ? "bg-transparent" : typeAccent(n.type)
                      }`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-sm ${
                          n.read
                            ? "text-gray-700"
                            : "text-gray-900 font-medium"
                        }`}
                      >
                        {n.title}
                      </p>
                      <p className="text-xs text-gray-600 mt-0.5">{n.body}</p>
                      <p className="text-xs text-gray-400 mt-1">
                        {relativeTime(n.createdAt)}
                      </p>
                    </div>
                    {!n.read && (
                      <button
                        onClick={() => markRead(n.id)}
                        className="text-gray-400 hover:text-primary-600 shrink-0 self-start p-1"
                        aria-label={`Mark "${n.title}" as read`}
                        title="Mark as read"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
