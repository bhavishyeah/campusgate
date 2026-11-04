import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";

interface MfaVerifyResponse {
  stepUpToken: string;
  action: string;
  expiresIn: number;
}

/**
 * Mints a short-lived step-up JWT. `action` is mandatory: the verify route
 * defaults it to "support_grant.create", which the publish gate rejects.
 * Returns the stepUpToken string. No toast and no logout here; the dialog
 * handles the 400s ("Invalid code", "MFA not enrolled").
 */
export function useStepUp() {
  return useMutation<string, ApiError, { code: string; action: string }>({
    mutationFn: async ({ code, action }) => {
      const data = await api.post<MfaVerifyResponse>("/api/auth/mfa/verify", {
        code,
        action,
      });
      return data.stepUpToken;
    },
  });
}
