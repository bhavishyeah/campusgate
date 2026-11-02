"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth";
import { landingRoute } from "@/lib/landing";

export default function Home() {
  const router = useRouter();
  const { token, user, hydrated } = useAuthStore();

  useEffect(() => {
    if (!hydrated) return;

    if (!token || !user) {
      router.replace("/login");
      return;
    }

    const { roles, permissions } = useAuthStore.getState();
    router.replace(landingRoute(roles, permissions));
  }, [token, user, router, hydrated]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-pulse text-xl text-gray-500">Loading...</div>
    </div>
  );
}
