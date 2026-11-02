import Link from "next/link";
import { ShieldAlert } from "lucide-react";

/** Friendly 403 screen for deep-links the user lacks the permission for. */
export function ForbiddenScreen() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center p-4 text-center">
      <ShieldAlert className="w-12 h-12 text-danger-500" aria-hidden="true" />
      <h1 className="mt-4 text-xl font-semibold text-gray-900">
        You don&apos;t have access to this page
      </h1>
      <p className="mt-1 text-sm text-gray-500 max-w-sm">
        Your account doesn&apos;t have permission to view this. If you think this
        is a mistake, contact your administrator.
      </p>
      <Link href="/" className="btn-primary mt-6">
        Back to home
      </Link>
    </div>
  );
}
