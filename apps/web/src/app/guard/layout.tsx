"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth";
import { connectSocket } from "@/lib/socket";
import { NotificationBell } from "@/components/NotificationBell";
import { Scan, Activity, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/guard", icon: Scan, label: "Scan" },
  { href: "/guard/activity", icon: Activity, label: "Activity" },
];

export default function GuardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, token, logout } = useAuthStore();

  useEffect(() => {
    if (!token || !user || user.role !== "GUARD") {
      router.replace("/login");
      return;
    }
    connectSocket();
    return () => {
      // Don't disconnect on Strict Mode remount in dev
    };
  }, [token, user, router]);

  if (!token || !user) return null;

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Top bar */}
      <header className="bg-gray-800 border-b border-gray-700 px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">CAMPUSGATE</h1>
          <p className="text-xs text-gray-400">Guard Panel</p>
        </div>
        <div className="flex items-center gap-4">
          {navItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                  isActive
                    ? "bg-primary-600 text-white"
                    : "text-gray-300 hover:bg-gray-700"
                }`}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </Link>
            );
          })}
          <NotificationBell variant="dark" />
          <button
            onClick={() => {
              logout();
              router.replace("/login");
            }}
            className="text-gray-400 hover:text-white"
            aria-label="Sign out"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="p-4">{children}</main>
    </div>
  );
}
