"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { readTokenFromLocation } from "@/lib/accountLinks";
import { SetPasswordForm } from "@/components/auth/SetPasswordForm";

interface Props {
  endpoint: string;
  title: string;
  intro: string;
  submitLabel: string;
  busyLabel: string;
}

const INVALID_LINK = "This link is invalid or has expired.";

/** Shared page body for /reset-password and /activate. The token comes from the URL fragment. */
export function TokenPasswordPage({ endpoint, title, intro, submitLabel, busyLabel }: Props) {
  // `undefined` = not read yet. A ref survives React StrictMode's second effect run,
  // so the token read on the first run is not lost after the hash is cleared.
  const tokenRef = useRef<string | null | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (tokenRef.current === undefined) {
      tokenRef.current = readTokenFromLocation();
      if (tokenRef.current) {
        // Keep the token out of history, screenshots and the Referer of later navigations.
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
    setReady(true);
  }, []);

  const submit = async (password: string) => {
    setError("");
    try {
      const res = await api.post<{ message?: string }>(endpoint, { token: tokenRef.current, password });
      setDone(res.message || "Done. You can now sign in.");
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError("Too many attempts. Try again later.");
      } else if (err instanceof ApiError && err.status === 400 && typeof err.data?.error === "string") {
        setError(err.data.error);
      } else if (err instanceof ApiError && err.status === 400) {
        setError("Please check the password and try again.");
      } else {
        setError("Something went wrong. Check your connection and try again.");
      }
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-900 via-primary-800 to-primary-950 p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white tracking-tight">CAMPUSGATE</h1>
        </div>
        <div className="card">{children}</div>
      </div>
    </div>
  );

  if (!ready) return shell(<p className="text-sm text-gray-500">Loading...</p>);

  if (done) {
    return shell(
      <div className="text-center">
        <CheckCircle className="w-14 h-14 text-success-500 mx-auto mb-4" />
        <p className="text-sm text-gray-700 mb-6">{done}</p>
        <Link href="/login" className="btn-primary w-full inline-block text-center">
          Sign in
        </Link>
      </div>,
    );
  }

  if (!tokenRef.current) {
    return shell(
      <div>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Link problem</h2>
        <p className="text-sm text-gray-600 mb-4">{INVALID_LINK}</p>
        <Link href="/forgot-password" className="text-primary-600 hover:underline text-sm">
          Request a new link
        </Link>
      </div>,
    );
  }

  return shell(
    <>
      <h2 className="text-xl font-semibold text-gray-900 mb-2">{title}</h2>
      <p className="text-sm text-gray-600 mb-6">{intro}</p>
      <SetPasswordForm submitLabel={submitLabel} busyLabel={busyLabel} onSubmit={submit} error={error} />
      {error && (
        <p className="text-center text-sm text-gray-500 mt-4">
          <Link href="/forgot-password" className="text-primary-600 hover:underline">
            Request a new link
          </Link>
        </p>
      )}
    </>,
  );
}
