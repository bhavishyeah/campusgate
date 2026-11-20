"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle } from "lucide-react";
import { api, ApiError } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await api.post<{ message: string }>("/api/auth/forgot-password", { email: email.trim() });
      setMessage(res.message || "If an account exists for that email, we have sent a link. Check your inbox.");
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError("Too many attempts. Try again later.");
      } else if (err instanceof ApiError && err.status === 400) {
        setError("Enter a valid email address.");
      } else {
        setError("Something went wrong. Check your connection and try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-900 via-primary-800 to-primary-950 p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white tracking-tight">CAMPUSGATE</h1>
        </div>
        <div className="card">
          {message ? (
            <div className="text-center">
              <CheckCircle className="w-14 h-14 text-success-500 mx-auto mb-4" />
              <p className="text-sm text-gray-700 mb-6">{message}</p>
              <Link href="/login" className="btn-primary w-full inline-block text-center">
                Back to Sign In
              </Link>
            </div>
          ) : (
            <>
              <h2 className="text-xl font-semibold text-gray-900 mb-2">Forgot password</h2>
              <p className="text-sm text-gray-600 mb-6">
                Enter your email and we will send you a link to set a new password.
              </p>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="email" className="label">
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    className="input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@institution.edu"
                    required
                    autoComplete="email"
                  />
                </div>
                {error && (
                  <div
                    className="bg-danger-50 border border-danger-500 text-danger-700 px-4 py-3 rounded-lg text-sm"
                    role="alert"
                  >
                    {error}
                  </div>
                )}
                <button type="submit" className="btn-primary w-full" disabled={loading}>
                  {loading ? "Sending..." : "Send link"}
                </button>
              </form>
              <p className="text-center text-sm text-gray-500 mt-6">
                <Link href="/login" className="text-primary-600 hover:underline">
                  Back to Sign In
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
