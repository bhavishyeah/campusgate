"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AlertTriangle, CheckCircle2, Siren } from "lucide-react";

type EmergencyType = "FIRE" | "EARTHQUAKE" | "MEDICAL" | "SECURITY" | "EVACUATION" | "OTHER";

type EmergencyAlert = {
  id: string;
  type: EmergencyType;
  status: "ACTIVE" | "RESOLVED";
  title: string;
  message: string;
  affectedArea: string | null;
  declaredAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
};

const EMERGENCY_TYPES: EmergencyType[] = ["FIRE", "EARTHQUAKE", "MEDICAL", "SECURITY", "EVACUATION", "OTHER"];

export default function AdminEmergencyPage() {
  const [active, setActive] = useState<EmergencyAlert | null>(null);
  const [history, setHistory] = useState<EmergencyAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [type, setType] = useState<EmergencyType>("FIRE");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [affectedArea, setAffectedArea] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");

  const load = async () => {
    try {
      setError("");
      const [activeRes, historyRes] = await Promise.all([
        api.get<EmergencyAlert | null>("/api/admin/emergency/active"),
        api.get<EmergencyAlert[]>("/api/admin/emergency?limit=20"),
      ]);
      setActive(activeRes);
      setHistory(historyRes);
    } catch (err: any) {
      setError(err.message || "Failed to load emergency data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const declareEmergency = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!title.trim() || !message.trim()) {
      setError("Title and message are required");
      return;
    }

    setSaving(true);
    try {
      await api.post("/api/admin/emergency/declare", {
        type,
        title: title.trim(),
        message: message.trim(),
        affectedArea: affectedArea.trim() || undefined,
      });
      setTitle("");
      setMessage("");
      setAffectedArea("");
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to declare emergency");
    } finally {
      setSaving(false);
    }
  };

  const resolveEmergency = async () => {
    if (!active) return;

    setSaving(true);
    setError("");
    try {
      await api.post(`/api/admin/emergency/${active.id}/resolve`, {
        resolutionNote: resolutionNote.trim() || undefined,
      });
      setResolutionNote("");
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to resolve emergency");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Emergency Alerts</h1>

      {error && <div className="mb-4 bg-danger-50 text-danger-700 px-4 py-3 rounded-lg text-sm">{error}</div>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card lg:col-span-1">
          <h2 className="text-sm font-medium text-gray-500 mb-4">Declare Emergency</h2>

          {active ? (
            <div className="bg-danger-50 border border-danger-200 rounded-lg p-3 text-sm text-danger-700">
              An active emergency exists. Resolve it before declaring another.
            </div>
          ) : (
            <form className="space-y-4" onSubmit={declareEmergency}>
              <div>
                <label className="label">Emergency Type</label>
                <select className="input" value={type} onChange={(e) => setType(e.target.value as EmergencyType)}>
                  {EMERGENCY_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label">Title</label>
                <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="FIRE EVACUATION — BLOCK A" required />
              </div>

              <div>
                <label className="label">Affected Area (optional)</label>
                <input className="input" value={affectedArea} onChange={(e) => setAffectedArea(e.target.value)} placeholder="Block A" />
              </div>

              <div>
                <label className="label">Instructions / Message</label>
                <textarea className="input min-h-[120px]" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Immediately evacuate through nearest safe exit." required />
              </div>

              <button type="submit" disabled={saving} className="btn-primary w-full flex items-center justify-center gap-2">
                <Siren className="w-4 h-4" />
                {saving ? "Declaring..." : "Declare Emergency"}
              </button>
            </form>
          )}
        </div>

        <div className="lg:col-span-2 space-y-4">
          <div className="card">
            <h2 className="text-sm font-medium text-gray-500 mb-4">Active Emergency</h2>

            {loading ? (
              <div className="text-gray-500 animate-pulse">Loading...</div>
            ) : !active ? (
              <div className="text-sm text-gray-500">No active emergency</div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-lg border border-danger-300 bg-danger-50 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="w-5 h-5 text-danger-700" />
                    <p className="font-semibold text-danger-800">{active.type} · {active.title}</p>
                  </div>
                  {active.affectedArea && <p className="text-sm text-danger-700 mb-2">Affected Area: {active.affectedArea}</p>}
                  <p className="text-sm text-danger-700 whitespace-pre-wrap">{active.message}</p>
                  <p className="text-xs text-danger-600 mt-2">Declared at: {new Date(active.declaredAt).toLocaleString()}</p>
                </div>

                <div>
                  <label className="label">Resolution Note (optional)</label>
                  <textarea className="input min-h-[80px]" value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} />
                </div>

                <button onClick={resolveEmergency} disabled={saving} className="btn-secondary flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  {saving ? "Resolving..." : "Mark Emergency Resolved"}
                </button>
              </div>
            )}
          </div>

          <div className="card">
            <h2 className="text-sm font-medium text-gray-500 mb-4">Recent Emergency History</h2>
            {history.length === 0 ? (
              <div className="text-sm text-gray-500">No emergency history</div>
            ) : (
              <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                {history.map((item) => (
                  <div key={item.id} className="rounded-lg border border-gray-100 p-3">
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-gray-900">{item.type} · {item.title}</p>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${item.status === "ACTIVE" ? "bg-danger-50 text-danger-700" : "bg-success-50 text-success-700"}`}>
                        {item.status}
                      </span>
                    </div>
                    {item.affectedArea && <p className="text-xs text-gray-600 mt-1">Area: {item.affectedArea}</p>}
                    <p className="text-xs text-gray-500 mt-1">Declared: {new Date(item.declaredAt).toLocaleString()}</p>
                    {item.resolvedAt && <p className="text-xs text-gray-500">Resolved: {new Date(item.resolvedAt).toLocaleString()}</p>}
                    {item.resolutionNote && <p className="text-xs text-gray-600 mt-1">Note: {item.resolutionNote}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
