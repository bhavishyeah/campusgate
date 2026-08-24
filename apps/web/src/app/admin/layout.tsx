"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth";
import {
  LayoutDashboard,
  Users,
  DoorOpen,
  Building,
  FileText,
  Shield,
  LogOut,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/admin", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/admin/users", icon: Users, label: "Users" },
  { href: "/admin/departments", icon: Building, label: "Departments" },
  { href: "/admin/gates", icon: DoorOpen, label: "Gates" },
  { href: "/admin/reasons", icon: FileText, label: "Exit Reasons" },
  { href: "/admin/audit", icon: Shield, label: "Audit Log" },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, token, logout } = useAuthStore();

  useEffect(() => {
    if (!token || !user || user.role !== "ADMIN") {
      router.replace("/login");
    }
  }, [token, user, router]);

  if (!token || !user) return null;

  return (
    <div className="min-h-screen bg-gray-50 md:pl-64">
      {/* Sidebar */}
      <aside className="hidden md:flex md:flex-col md:fixed md:inset-y-0 md:left-0 md:w-64 bg-gray-900 text-white">
        <div className="p-6">
          <h1 className="text-xl font-bold">CAMPUSGATE</h1>
          <p className="text-xs text-gray-400 mt-1">Admin Panel</p>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          {navItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-primary-600 text-white"
                    : "text-gray-300 hover:bg-gray-800"
                }`}
              >
                <item.icon className="w-5 h-5" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-gray-700">
          <button
            onClick={() => {
              logout();
              router.replace("/login");
            }}
            className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors w-full"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      <main className="p-4 md:p-8">{children}</main>
    </div>
  );
}
