"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth";
import { LogOut } from "lucide-react";

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, token, logout, hydrated } = useAuthStore();

  useEffect(() => {
    if (!hydrated) return;
    if (!token || !user || user.role !== "SUPER_ADMIN") {
      router.replace("/login");
    }
  }, [hydrated, token, user, router]);

  if (!hydrated || !token || !user) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="font-bold text-primary-800">CAMPUSGATE Platform</h1>
          <p className="text-xs text-gray-500">Super Admin</p>
        </div>
        <button
          onClick={() => {
            logout();
            router.replace("/login");
          }}
          className="flex items-center gap-2 text-sm text-gray-600 hover:text-danger-600"
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      </header>
      <main className="p-4 md:p-8">{children}</main>
    </div>
  );
}
