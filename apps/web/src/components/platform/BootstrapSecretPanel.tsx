"use client";

import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CheckCircle2, Copy, Eye, EyeOff, ShieldAlert } from "lucide-react";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { CreateInstitutionResult } from "@/features/platform/types";

/**
 * Show-once bootstrap-secret reveal (design C.6.2 / acceptance 5).
 *
 * This deliberately composes DialogPortal + DialogOverlay +
 * DialogPrimitive.Content DIRECTLY — WITHOUT the shared <DialogContent>, which
 * hard-codes a trailing X close button. There is no X here, Esc and
 * outside-click are swallowed, and onOpenChange refuses to close until the
 * operator ticks "I saved it". "Done" is the ONLY exit and clears local state.
 *
 * SECRET HYGIENE: `tempPassword` lives only in the parent's transient state and
 * the local reveal toggle here. It is NEVER written to any store, localStorage,
 * React Query cache, analytics, console.*, or toast.
 */
export function BootstrapSecretPanel({
  result,
  onDone,
}: {
  result: CreateInstitutionResult;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.tempPassword);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable; the operator can still read the revealed value.
    }
  };

  return (
    <Dialog
      open
      // Refuse every close path until the operator confirms they saved it. Even
      // then, closing routes through onDone so local state is cleared explicitly.
      onOpenChange={(next) => {
        if (!next && saved) onDone();
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          className="fixed left-[50%] top-[50%] z-50 grid w-full max-w-md translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg sm:rounded-lg"
        >
          <div className="flex items-center gap-2 text-success-700">
            <CheckCircle2 className="h-5 w-5" />
            <DialogPrimitive.Title className="text-lg font-semibold">
              Institution created
            </DialogPrimitive.Title>
          </div>
          <DialogPrimitive.Description className="text-sm text-gray-600">
            <strong>{result.institution.name}</strong> ({result.institution.code})
            is now active. Share these credentials with the institution&apos;s
            admin.
          </DialogPrimitive.Description>

          <div className="space-y-2 rounded-lg bg-gray-50 p-4 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-500">Admin email</span>
              <span className="font-mono">{result.admin.email}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-500">Temporary password</span>
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium" data-testid="temp-password">
                  {revealed ? result.tempPassword : "••••••••••••"}
                </span>
                <button
                  type="button"
                  onClick={() => setRevealed((v) => !v)}
                  aria-label={revealed ? "Hide password" : "Reveal password"}
                  className="text-gray-400 hover:text-gray-700"
                >
                  {revealed ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={copy}
                  aria-label="Copy temporary password"
                  className="text-gray-400 hover:text-gray-700"
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>
            </div>
            {copied && (
              <p className="text-right text-xs text-success-700" role="status">
                Copied
              </p>
            )}
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-warning-50 px-4 py-3 text-sm text-warning-700">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              This password is shown only once and cannot be retrieved again.
            </span>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            I saved it
          </label>

          <Button
            type="button"
            className="w-full"
            disabled={!saved}
            onClick={onDone}
          >
            Done
          </Button>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
