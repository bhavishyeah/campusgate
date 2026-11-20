"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, ApiError } from "@/lib/api";

export interface BulkInviteResult {
  dryRun: boolean;
  emailConfigured: boolean;
  eligibleTotal: number;
  attempted: number;
  sent: number;
  failed: number;
  skipped: Record<string, number>;
  failedRecently: number;
  remainingNotInvited: number;
  budget: { inviteCeiling: number; inviteRemaining: number };
  results: { userId: string; email: string; outcome: string }[];
}

const SKIP_LABELS: Record<string, string> = {
  alreadyActivated: "Already activated",
  recentlyInvited: "Invited in the last 24 hours",
  recentFailure: "Failed in the last 24 hours",
  notFound: "Not found",
  notEligible: "Not eligible",
  budget: "Daily email limit",
  providerLimit: "Email provider limit",
  providerError: "Email provider error",
};

const ENDPOINT = "/api/account-invites/bulk-students";

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const code = err.data?.code;
    if (code === "EMAIL_NOT_CONFIGURED") return "Email delivery is not configured on the server.";
    if (code === "EMAIL_DAILY_LIMIT") return "The daily email limit is used up. Try again tomorrow.";
    if (err.status === 429) return "Too many requests. Try again later.";
    if (typeof err.data?.error === "string") return err.data.error;
  }
  return "Something went wrong. Try again.";
}

export function BulkInviteDialog({ onClose }: { onClose: () => void }) {
  const [preview, setPreview] = useState<BulkInviteResult | null>(null);
  const [last, setLast] = useState<BulkInviteResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setPreview(await api.post<BulkInviteResult>(ENDPOINT, { mode: "ALL_PENDING", dryRun: true }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  const send = async () => {
    setSending(true);
    setError("");
    try {
      const res = await api.post<BulkInviteResult>(ENDPOINT, { mode: "ALL_PENDING", dryRun: false });
      setLast(res);
      setPreview(res);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  const state = preview;
  const canSend =
    !!state &&
    state.emailConfigured &&
    state.remainingNotInvited > 0 &&
    state.budget.inviteRemaining > 0 &&
    !sending;
  const batch = state ? Math.min(100, state.budget.inviteRemaining, state.remainingNotInvited) : 0;
  const skippedEntries = last ? Object.entries(last.skipped).filter(([, n]) => n > 0) : [];

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-invite-title"
    >
      <div className="bg-white rounded-xl p-6 w-full max-w-lg my-8">
        <div className="flex items-center justify-between mb-4">
          <h2 id="bulk-invite-title" className="text-lg font-semibold">
            Invite not-activated students
          </h2>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        {loading && <p className="text-sm text-gray-500 animate-pulse">Checking students...</p>}

        {error && (
          <div className="bg-danger-50 text-danger-700 px-4 py-3 rounded-lg text-sm mb-4" role="alert">
            {error}
          </div>
        )}

        {!loading && state && !state.emailConfigured && (
          <div className="bg-warning-50 text-warning-600 px-4 py-3 rounded-lg text-sm mb-4">
            Email delivery is not configured on the server, so invites cannot be sent yet. Ask the
            administrator to set it up.
          </div>
        )}

        {!loading && state && (
          <div className="space-y-3 text-sm text-gray-700">
            <p>
              {state.remainingNotInvited} student{state.remainingNotInvited === 1 ? "" : "s"} not yet activated.
              Up to {batch} can be sent now (shared daily email limit).
            </p>
            {state.failedRecently > 0 && (
              <p className="text-gray-500">
                {state.failedRecently} recent send{state.failedRecently === 1 ? "" : "s"} failed and will be retried
                after 24 hours.
              </p>
            )}
          </div>
        )}

        {last && (
          <div className="mt-4 border-t pt-4">
            <div className="grid grid-cols-3 gap-3 text-center mb-3">
              <div className="bg-success-50 rounded-lg p-3">
                <p className="text-xl font-bold text-success-700">{last.sent}</p>
                <p className="text-xs text-success-600">Sent</p>
              </div>
              <div className="bg-danger-50 rounded-lg p-3">
                <p className="text-xl font-bold text-danger-700">{last.failed}</p>
                <p className="text-xs text-danger-600">Failed</p>
              </div>
              <div className="bg-gray-100 rounded-lg p-3">
                <p className="text-xl font-bold text-gray-700">
                  {skippedEntries.reduce((n, [, v]) => n + v, 0)}
                </p>
                <p className="text-xs text-gray-600">Skipped</p>
              </div>
            </div>
            {skippedEntries.length > 0 && (
              <ul className="text-xs text-gray-600 mb-3 space-y-1">
                {skippedEntries.map(([k, n]) => (
                  <li key={k}>
                    {SKIP_LABELS[k] ?? k}: {n}
                  </li>
                ))}
              </ul>
            )}
            {last.results.length > 0 && (
              <ul className="max-h-48 overflow-y-auto text-xs divide-y divide-gray-100 border rounded-lg" aria-label="Per-student results">
                {last.results.map((r) => (
                  <li key={r.userId} className="flex justify-between gap-3 px-3 py-1.5">
                    <span className="truncate">{r.email}</span>
                    <span className="font-mono text-gray-500 shrink-0">{r.outcome}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex gap-3 pt-5">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn-primary flex-1" onClick={send} disabled={!canSend}>
            {sending ? "Sending..." : last ? "Send next batch" : `Send ${batch} invite${batch === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
