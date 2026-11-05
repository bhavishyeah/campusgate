"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { MfaEnrollment } from "@/components/MfaEnrollment";
import { isMfaEnrollmentRequired } from "@/features/platform/errors";

interface MfaGateContextValue {
  /** Screens call this from onError/useEffect; flips the gate on the 403. */
  reportError: (err: unknown) => void;
}

const MfaGateContext = createContext<MfaGateContextValue | null>(null);

/** Access the gate so screen queries can report their errors into it. */
export function useMfaGate(): MfaGateContextValue {
  const ctx = useContext(MfaGateContext);
  if (!ctx) {
    throw new Error("useMfaGate must be used within <MfaEnrollmentGate>");
  }
  return ctx;
}

/**
 * Detects the platform 403 `{ error: "MFA enrollment required" }` surfaced by
 * any platform call and renders the existing <MfaEnrollment/> flow. On
 * successful enrollment it clears the flag and invalidates every ['platform']
 * query so the screens refetch now that the MFA gate is cleared.
 */
export function MfaEnrollmentGate({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [required, setRequired] = useState(false);
  const [showEnrollment, setShowEnrollment] = useState(false);

  const reportError = useCallback((err: unknown) => {
    if (isMfaEnrollmentRequired(err)) setRequired(true);
  }, []);

  const onEnrolled = useCallback(() => {
    setRequired(false);
    setShowEnrollment(false);
    queryClient.invalidateQueries({ queryKey: ["platform"] });
  }, [queryClient]);

  if (required) {
    return (
      <MfaGateContext.Provider value={{ reportError }}>
        <div className="mx-auto max-w-md rounded-xl border border-warning-200 bg-warning-50 p-6 text-center">
          <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-warning-600" />
          <h2 className="mb-1 text-lg font-semibold text-gray-900">
            Set up MFA to continue
          </h2>
          <p className="mb-4 text-sm text-gray-600">
            Multi-factor authentication is required for the platform console.
            Enroll an authenticator app to unlock the super-admin tools.
          </p>
          <button
            type="button"
            className="btn-primary"
            onClick={() => setShowEnrollment(true)}
          >
            Enable MFA
          </button>
        </div>
        <MfaEnrollment
          open={showEnrollment}
          onClose={() => setShowEnrollment(false)}
          onEnrolled={onEnrolled}
        />
      </MfaGateContext.Provider>
    );
  }

  return (
    <MfaGateContext.Provider value={{ reportError }}>
      {children}
    </MfaGateContext.Provider>
  );
}
