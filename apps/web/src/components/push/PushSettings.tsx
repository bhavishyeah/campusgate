"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  enablePush,
  fetchPushConfig,
  getPushState,
  getThisDeviceCheck,
  type PushConfig,
  type ThisDeviceCheck,
  type PushState,
} from "@/lib/push";
import { IOS_INSTALL_TEXT } from "@/components/push/PushPrompt";
import { PUSH_DENIED_TEXT, PUSH_DISMISSED_TEXT } from "@/lib/pushText";

interface Device {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  failing: boolean;
}
interface ServerStatus {
  known: boolean;
  lastSuccessAt: string | null;
  failing: boolean;
}

interface TestResult {
  sent: number;
  failed: number;
  devices: Array<{ id: string; deviceLabel: string | null; result: "sent" | "failed" | "removed" }>;
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
  const [check, setCheck] = useState<ThisDeviceCheck | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState("");
  const [enableNote, setEnableNote] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const cfg = await fetchPushConfig();
      setConfig(cfg);
      setState(await getPushState(cfg));
      const device = await getThisDeviceCheck();
      setCheck(device);
      if (device.endpoint) {
        setServerStatus(
          await api
            .post<ServerStatus>("/api/notifications/push/status", { endpoint: device.endpoint })
            .catch(() => null),
        );
      } else {
        setServerStatus(null);
      }
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
    setEnableNote("");
    const result = await enablePush(config?.publicKey ?? null);
    setBusy(false);
    if (!result.ok && result.reason === "dismissed") setEnableNote(PUSH_DISMISSED_TEXT);
    if (!result.ok && result.reason === "failed") setError("Could not enable notifications on this device");
    if (!result.ok && result.reason === "not-configured") setError("Notifications are not set up yet");
    await load();
  };

  const sendTest = async () => {
    setTestBusy(true);
    setTestError("");
    setTestResult(null);
    try {
      setTestResult(await api.post<TestResult>("/api/notifications/push/test"));
    } catch (err: any) {
      setTestError(err?.message || "Could not send the test notification");
    } finally {
      setTestBusy(false);
    }
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
          <p className="text-sm text-gray-700">{PUSH_DENIED_TEXT}</p>
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
        {enableNote && (
          <p role="status" className="text-xs text-gray-700">
            {enableNote}
          </p>
        )}
        {state === "subscribed" && <p className="text-sm text-success-700">Notifications are on for this device.</p>}
        {check && (
          <dl aria-label="Device check" className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm text-gray-800">
            <dt className="text-gray-500">Push supported</dt>
            <dd>{check.supported ? "Yes" : "No"}</dd>
            <dt className="text-gray-500">Installed app</dt>
            <dd>{check.standalone ? "Yes" : "No, running in a browser tab"}</dd>
            <dt className="text-gray-500">Permission</dt>
            <dd>{check.permission === "default" ? "Not asked yet" : check.permission}</dd>
            <dt className="text-gray-500">Browser subscription</dt>
            <dd>{check.hasSubscription ? "Yes" : "No"}</dd>
            <dt className="text-gray-500">Known to server</dt>
            <dd>{serverStatus ? (serverStatus.known ? (serverStatus.failing ? "Yes, not responding" : "Yes") : "No") : "Unknown"}</dd>
            <dt className="text-gray-500">Last delivery</dt>
            <dd>{serverStatus?.lastSuccessAt ? new Date(serverStatus.lastSuccessAt).toLocaleString() : "None yet"}</dd>
          </dl>
        )}
      </section>

      <section aria-labelledby="push-test-heading" className="space-y-2">
        <h2 id="push-test-heading" className="font-semibold text-gray-900">
          Test notification
        </h2>
        <p className="text-xs text-gray-500">Sends a test to all your registered devices.</p>
        <button
          onClick={sendTest}
          disabled={testBusy}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
        >
          {testBusy ? "Sending..." : "Send a test notification"}
        </button>
        {testError && <p role="alert" className="text-sm text-danger-700">{testError}</p>}
        {testResult && testResult.devices.length === 0 && (
          <p role="status" className="text-sm text-gray-700">No devices registered. Enable notifications on this device first.</p>
        )}
        {testResult && testResult.devices.length > 0 && (
          <ul role="status" className="text-sm text-gray-800">
            {testResult.devices.map((d) => (
              <li key={d.id}>
                {d.deviceLabel || "Browser"}: {d.result === "sent" ? "sent" : d.result === "removed" ? "no longer valid, removed" : "failed"}
              </li>
            ))}
          </ul>
        )}
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

      <section aria-labelledby="push-help-heading" className="space-y-2">
        <h2 id="push-help-heading" className="font-semibold text-gray-900">
          Not receiving notifications?
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
          <li>
            Android: install CampusGate (menu, then Install app) and open it from the icon. Set Chrome battery use to
            No restrictions (Xiaomi, Redmi, POCO: Chrome &gt; Battery saver &gt; No restrictions, turn Autostart on and lock
            Chrome in recent apps). Oppo, Realme, Vivo, Samsung and others have a similar battery or app-launch setting
            for Chrome.
          </li>
          <li>
            Windows: Settings &gt; System &gt; Notifications, turn Chrome on and Do not disturb off. In Chrome, Settings
            &gt; System, keep Continue running background apps on.
          </li>
          <li>iPhone: tap Share, Add to Home Screen, then open CampusGate from the icon (iOS 16.4 or later).</li>
        </ul>
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
