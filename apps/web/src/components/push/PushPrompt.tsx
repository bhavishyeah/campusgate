"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import { useAuthStore } from "@/stores/auth";
import {
  enablePush,
  fetchPushConfig,
  getPushState,
  resyncPush,
  type PushConfig,
  type PushState,
} from "@/lib/push";

const DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
const dismissKey = (userId: string) => `cg.push.dismissed.${userId}`;

export const IOS_INSTALL_TEXT =
  "To get notifications on iPhone: tap Share, choose Add to Home Screen, then open CampusGate from the icon. Requires iOS 16.4 or later.";

function isDismissed(userId: string): boolean {
  try {
    const at = Number(localStorage.getItem(dismissKey(userId)));
    return Number.isFinite(at) && at > 0 && Date.now() - at < DISMISS_MS;
  } catch {
    return false;
  }
}

let resyncedThisSession = false;

/** Test seam. */
export function resetPushPromptForTests(): void {
  resyncedThisSession = false;
}

export function PushPrompt() {
  const userId = useAuthStore((s) => s.user?.id);
  const [state, setState] = useState<PushState | null>(null);
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!userId) return;
    if (isDismissed(userId)) {
      setHidden(true);
      return;
    }
    let cancelled = false;
    (async () => {
      let cfg: PushConfig | null = null;
      try {
        cfg = await fetchPushConfig();
      } catch {
        // 403 for platform accounts or a network error: stay silent
        return;
      }
      if (cancelled) return;
      setConfig(cfg);
      const next = await getPushState(cfg);
      if (cancelled) return;
      setState(next);
      if ((next === "subscribed" || next === "granted-not-subscribed") && !resyncedThisSession) {
        resyncedThisSession = true;
        void resyncPush();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const dismiss = useCallback(() => {
    if (userId) {
      try {
        localStorage.setItem(dismissKey(userId), String(Date.now()));
      } catch {
        // ignore storage failures
      }
    }
    setHidden(true);
  }, [userId]);

  // Click handler: requestPermission is called synchronously inside enablePush.
  const onEnable = async () => {
    setBusy(true);
    setMessage("");
    const result = await enablePush(config?.publicKey ?? null);
    setBusy(false);
    if (result.ok) {
      setState("subscribed");
      return;
    }
    if (result.reason === "denied") setState("denied");
    else if (result.reason === "not-configured") setHidden(true);
    else if (result.reason === "failed") setMessage("Could not enable notifications on this device");
  };

  if (hidden || (state !== "default" && state !== "ios-install")) return null;

  return (
    <div
      role="region"
      aria-label="Enable notifications"
      className="mx-4 mt-3 md:mx-8 flex items-start gap-3 rounded-lg border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-gray-800"
    >
      <Bell className="w-4 h-4 mt-0.5 shrink-0 text-primary-600" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {state === "ios-install" ? (
          <p>{IOS_INSTALL_TEXT}</p>
        ) : (
          <>
            <p>Get instant alerts on this device for gate passes, fees and notices.</p>
            <button
              onClick={onEnable}
              disabled={busy}
              className="mt-2 rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700 disabled:opacity-50"
            >
              {busy ? "Enabling..." : "Enable notifications"}
            </button>
            {message && <p className="mt-1 text-xs text-danger-700">{message}</p>}
          </>
        )}
      </div>
      <button onClick={dismiss} aria-label="Dismiss" className="p-1 text-gray-500 hover:text-gray-800">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
