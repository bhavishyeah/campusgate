"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, CheckCircle2, Copy, X, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";

interface MfaEnrollmentProps {
  open: boolean;
  onClose: () => void;
  onEnrolled?: () => void;
}

interface EnrollStartResult {
  otpauthUri: string;
  qrCodeDataUrl: string;
}

interface EnrollVerifyResult {
  enabled: true;
  recoveryCodes: string[];
}

type Step = "scan" | "verifying" | "recovery";

export function MfaEnrollment({ open, onClose, onEnrolled }: MfaEnrollmentProps) {
  const [step, setStep] = useState<Step>("scan");
  const [error, setError] = useState("");
  const [otpauthUri, setOtpauthUri] = useState("");
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const start = useCallback(async () => {
    setStarting(true);
    setError("");
    try {
      const res = await api.post<EnrollStartResult>("/api/auth/mfa/enroll/start", {});
      setOtpauthUri(res.otpauthUri);
      setQrCodeDataUrl(res.qrCodeDataUrl);
      setCode("");
      setStep("scan");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.data?.error || err.message);
      } else {
        setError(err instanceof Error ? err.message : "Could not start MFA enrollment");
      }
    } finally {
      setStarting(false);
    }
  }, []);

  // Start enrollment when the modal opens; reset transient state on close.
  useEffect(() => {
    if (open) {
      setStep("scan");
      setError("");
      setCode("");
      setRecoveryCodes([]);
      start();
    } else {
      setOtpauthUri("");
      setQrCodeDataUrl("");
    }
  }, [open, start]);

  // Escape-to-close (mirrors NotificationBell's keydown pattern).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    setStep("verifying");
    try {
      const res = await api.post<EnrollVerifyResult>("/api/auth/mfa/enroll/verify", {
        code: code.trim(),
      });
      setRecoveryCodes(res.recoveryCodes);
      setStep("recovery");
    } catch (err) {
      setStep("scan");
      if (err instanceof ApiError && err.status === 400) {
        setError(err.data?.error || "Invalid code");
      } else if (err instanceof ApiError) {
        setError(err.data?.error || err.message);
      } else {
        setError(err instanceof Error ? err.message : "Could not verify code");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDone = () => {
    onEnrolled?.();
    onClose();
  };

  if (!open) return null;

  const enrollmentNotStarted = error === "Enrollment not started";
  const busy = starting || submitting;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
      role="dialog"
      aria-modal="true"
      aria-label="Set up multi-factor authentication"
    >
      <div className="bg-white rounded-xl p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-primary-800">
            <ShieldCheck className="w-5 h-5" />
            <h3 className="text-lg font-semibold">
              {step === "recovery" ? "Save your recovery codes" : "Set up MFA"}
            </h3>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        {error && (
          <div
            className="bg-danger-50 text-danger-700 px-4 py-3 rounded-lg text-sm mb-4"
            role="alert"
          >
            {error}
            {enrollmentNotStarted && (
              <button
                type="button"
                onClick={start}
                className="ml-2 font-medium underline hover:no-underline"
              >
                Try again
              </button>
            )}
          </div>
        )}

        {step === "recovery" ? (
          <>
            <div className="bg-warning-50 text-warning-700 px-4 py-3 rounded-lg text-sm mb-4">
              These recovery codes are shown only once. Save them now in a safe
              place — each can be used once to sign in if you lose your
              authenticator.
            </div>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {recoveryCodes.map((rc) => (
                <code
                  key={rc}
                  className="bg-gray-50 rounded-lg px-3 py-2 font-mono text-sm text-gray-900 text-center"
                >
                  {rc}
                </code>
              ))}
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                className="btn-secondary flex-1 flex items-center justify-center gap-2"
                onClick={() => navigator.clipboard.writeText(recoveryCodes.join("\n"))}
              >
                <Copy className="w-4 h-4" />
                Copy all
              </button>
              <button type="button" className="btn-primary flex-1" onClick={handleDone}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-600 mb-4">
              Scan the QR code with an authenticator app, then enter the 6-digit
              code it generates to finish enabling MFA.
            </p>

            {starting ? (
              <div className="flex items-center justify-center py-10 text-gray-500">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            ) : qrCodeDataUrl ? (
              <>
                <div className="flex justify-center mb-4">
                  {/* Backend-provided data: PNG — rendered directly, no client QR library. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={qrCodeDataUrl}
                    alt="MFA setup QR code"
                    className="w-48 h-48 rounded-lg border border-gray-200"
                  />
                </div>

                <div className="mb-4">
                  <p className="text-xs text-gray-500 mb-1">
                    Or enter this setup key manually:
                  </p>
                  <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                    <span className="font-mono text-xs text-gray-700 break-all flex-1">
                      {otpauthUri}
                    </span>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard.writeText(otpauthUri)}
                      aria-label="Copy setup key"
                      className="text-gray-400 hover:text-gray-700 shrink-0"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <form onSubmit={handleVerify} className="space-y-4">
                  <div>
                    <label htmlFor="mfa-code" className="label">
                      Verification code
                    </label>
                    <input
                      id="mfa-code"
                      className="input font-mono tracking-widest"
                      value={code}
                      onChange={(e) =>
                        setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                      }
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="123456"
                      required
                    />
                  </div>
                  <button
                    type="submit"
                    className="btn-primary w-full flex items-center justify-center gap-2"
                    disabled={busy || code.length !== 6}
                  >
                    {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                    {submitting ? "Verifying..." : "Verify & enable MFA"}
                  </button>
                </form>
              </>
            ) : (
              <div className="flex justify-center py-6">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={start}
                  disabled={starting}
                >
                  Start enrollment
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
