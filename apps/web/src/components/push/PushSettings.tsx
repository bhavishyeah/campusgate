"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  enablePush,
  fetchPushConfig,
  getPushState,
  type PushConfig,
  type PushState,
} from "@/lib/push";
import { IOS_INSTALL_TEXT } from "@/components/push/PushPrompt";

interface Device {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  failing: boolean;
}
interface PrefCategory {
  category: string;
  label: string;
  push: boolean;
}
interface PrefsResponse {
  categories: PrefCategory[];
  emergency: { locked: true; push: true };
}

export function PushSettings() {
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [state, setState] = useState<PushState | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [prefs, setPrefs] = useState<PrefsResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const cfg = await fetchPushConfig();
      setConfig(cfg);
      setState(await getPushState(cfg));
      const [d, p] = await Promise.all([
        api.get<{ devices: Device[] }>("/api/notifications/push/devices"),
        api.get<PrefsResponse>("/api/notifications/preferences"),
      ]);
      setDevices(d.devices);
      setPrefs(p);
    } catch (err: any) {
      setError(err?.message || "Could not load notification settings");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onEnable = async () => {
    setBusy(true);
    setError("");
    const result = await enablePush(config?.publicKey ?? null);
    setBusy(false);
    if (!result.ok && result.reason === "failed") setError("Could not enable notifications on this device");
    if (!result.ok && result.reason === "not-configured") setError("Notifications are not set up yet");
    await load();
  };

  const removeDevice = async (id: string) => {
    try {
      await api.delete(`/api/notifications/push/devices/${id}`);
      setDevices((prev) => prev.filter((d) => d.id !== id));
    } catch (err: any) {
      setError(err?.message || "Could not remove device");
    }
  };

  const toggle = async (category: string, push: boolean) => {
    setPrefs((prev) =>
      prev ? { ...prev, categories: prev.categories.map((c) => (c.category === category ? { ...c, push } : c)) } : prev
    );
    try {
      setPrefs(await api.put<PrefsResponse>("/api/notifications/preferences", { category, push }));
    } catch (err: any) {
      setError(err?.message || "Could not save preference");
      void load();
    }
  };

  return (
    <div className="space-y-8">
      {error && <p className="text-sm text-danger-700">{error}</p>}

      <section aria-labelledby="push-device-heading" className="space-y-2">
        <h2 id="push-device-heading" className="font-semibold text-gray-900">
          This device
        </h2>
        {state === "ios-install" && <p className="text-sm text-gray-700">{IOS_INSTALL_TEXT}</p>}
        {state === "unsupported" && (
          <p className="text-sm text-gray-700">This browser does not support push notifications.</p>
        )}
        {state === "not-configured" && (
          <p className="text-sm text-gray-700">Notifications are not set up for this campus yet.</p>
        )}
        {state === "denied" && (
          <p className="text-sm text-gray-700">
            Notifications are blocked. Allow them in your browser or site settings, then reload this page.
          </p>
        )}
        {(state === "default" || state === "granted-not-subscribed") && (
          <button
            onClick={onEnable}
            disabled={busy}
            className="rounded-md bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {busy ? "Enabling..." : "Enable notifications"}
          </button>
        )}
        {state === "subscribed" && <p className="text-sm text-success-700">Notifications are on for this device.</p>}
      </section>

      <section aria-labelledby="push-devices-heading" className="space-y-2">
        <h2 id="push-devices-heading" className="font-semibold text-gray-900">
          My devices
        </h2>
        {devices.length === 0 ? (
          <p className="text-sm text-gray-600">No devices registered.</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900">{d.deviceLabel || "Browser"}</p>
                  <p className="text-xs text-gray-500">
                    Added {new Date(d.createdAt).toLocaleDateString()}
                    {d.lastSuccessAt ? `, last delivery ${new Date(d.lastSuccessAt).toLocaleDateString()}` : ""}
                    {d.failing ? ", not responding" : ""}
                  </p>
                </div>
                <button
                  onClick={() => removeDevice(d.id)}
                  className="text-xs font-medium text-danger-700 hover:underline"
                  aria-label={`Remove ${d.deviceLabel || "device"}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="push-categories-heading" className="space-y-2">
        <h2 id="push-categories-heading" className="font-semibold text-gray-900">
          Push by category
        </h2>
        <p className="text-xs text-gray-500">Turning a category off only stops push alerts. You still see it in the bell.</p>
        {prefs && (
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
            {prefs.categories.map((c) => (
              <li key={c.category} className="flex items-center justify-between px-4 py-3 text-sm">
                <label htmlFor={`pref-${c.category}`} className="text-gray-900">
                  {c.label}
                </label>
                <input
                  id={`pref-${c.category}`}
                  type="checkbox"
                  checked={c.push}
                  onChange={(e) => toggle(c.category, e.target.checked)}
                />
              </li>
            ))}
            <li className="flex items-center justify-between px-4 py-3 text-sm">
              <label htmlFor="pref-EMERGENCY" className="text-gray-900">
                Emergency alerts (always on)
              </label>
              <input id="pref-EMERGENCY" type="checkbox" checked disabled readOnly />
            </li>
          </ul>
        )}
      </section>
    </div>
  );
}
