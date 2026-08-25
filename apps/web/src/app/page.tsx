"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth";

export default function Home() {
  const router = useRouter();
  const { token, user, hydrated } = useAuthStore();

  useEffect(() => {
    if (!hydrated) return;

    if (!token || !user) {
      router.replace("/login");
      return;
    }

    // Route based on role
    switch (user.role) {
      case "STUDENT":
        router.replace("/student");
        break;
      case "HOD":
        router.replace("/hod");
        break;
      case "GUARD":
        router.replace("/guard");
        break;
      case "ADMIN":
        router.replace("/admin");
        break;
      default:
        router.replace("/login");
    }
  }, [token, user, router, hydrated]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-pulse text-xl text-gray-500">Loading...</div>
    </div>
  );
}
