"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth";
import { PushSettings } from "@/components/push/PushSettings";

export default function NotificationSettingsPage() {
  const router = useRouter();
  const token = useAuthStore((s) => s.token);
  const hydrated = useAuthStore((s) => s.hydrated);

  useEffect(() => {
    if (hydrated && !token) router.replace("/login");
  }, [hydrated, token, router]);

  if (!hydrated || !token) return null;

  return (
    <main className="mx-auto max-w-2xl p-4 md:p-8 space-y-6">
      <Link href="/" className="text-sm text-primary-600 hover:underline">
        Back
      </Link>
      <h1 className="text-xl font-semibold text-gray-900">Notification settings</h1>
      <PushSettings />
    </main>
  );
}
