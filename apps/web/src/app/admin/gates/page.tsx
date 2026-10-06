"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Activity, Clock3, DoorOpen, Plus, UserRound } from "lucide-react";

type GateHealthStatus = "OPERATIONAL" | "WARNING" | "OFFLINE" | "CLOSED";

interface GateHealthRow {
  gateId: string;
  gateName: string;
  location: string | null;
  status: GateHealthStatus;
  isActive: boolean;
  assignedGuards: { id: string; name: string }[];
  lastActivityAt: string | null;
  lastGuardName: string | null;
  minutesSinceLastActivity: number | null;
  todayExits: number;
  todayReturns: number;
}

interface GateHealthDetail extends Omit<GateHealthRow, "lastGuardName"> {
  recentEvents: {
    id: string;
    type: "EXIT" | "RETURN";
    timestamp: string;
    guardName: string;
    passNumber: string;
    studentName: string;
    enrollmentNo: string;
  }[];
}

const statusStyle: Record<GateHealthStatus, string> = {
  OPERATIONAL: "bg-success-50 text-success-700",
  WARNING: "bg-warning-50 text-warning-600",
  OFFLINE: "bg-danger-50 text-danger-700",
  CLOSED: "bg-gray-100 text-gray-600",
};

function formatDateTime(value: string | null) {
  if (!value) return "No activity";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return date.toLocaleString();
}

function relativeActivity(minutesSinceLastActivity: number | null) {
  if (minutesSinceLastActivity === null) return "No recent activity";
  if (minutesSinceLastActivity < 1) return "Just now";
  if (minutesSinceLastActivity < 60) return `${minutesSinceLastActivity} min ago`;
  const hrs = Math.floor(minutesSinceLastActivity / 60);
  const mins = minutesSinceLastActivity % 60;
  return mins > 0 ? `${hrs}h ${mins}m ago` : `${hrs}h ago`;
}

export default function AdminGatesPage() {
  const [gates, setGates] = useState<GateHealthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedGateId, setSelectedGateId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GateHealthDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const selectedGate = useMemo(
    () => gates.find((g) => g.gateId === selectedGateId) ?? null,
    [gates, selectedGateId]
  );

  const fetchHealth = async () => {
    try {
      const rows = await api.get<GateHealthRow[]>("/api/admin/gates/health");
      setGates(rows);
      setError("");
    } catch (err: any) {
      setError(err.message || "Failed to load gate health");
    } finally {
      setLoading(false);
    }
  };

  const fetchGateDetail = async (gateId: string) => {
    setDetailLoading(true);
    try {
      const payload = await api.get<GateHealthDetail>(`/api/admin/gates/${gateId}/health`);
      setDetail(payload);
      setError("");
    } catch (err: any) {
      setError(err.message || "Failed to load gate detail");
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    fetchHealth();
  }, []);

  useEffect(() => {
    if (!selectedGateId) {
      setDetail(null);
      return;
    }
    fetchGateDetail(selectedGateId);
  }, [selectedGateId]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await api.post("/api/admin/gates", {
        name,
        location: location || undefined,
      });
      setName("");
      setLocation("");
      await fetchHealth();
    } catch (err: any) {
      setError(err.message || "Failed to create gate");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Gates</h1>

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="card lg:col-span-3">
          <h2 className="text-sm font-medium text-gray-500 mb-4">Add Gate</h2>
          <form onSubmit={create} className="space-y-4">
            <div>
              <label htmlFor="gate-name" className="label">
                Gate Name
              </label>
              <input
                id="gate-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Main Gate"
                required
              />
            </div>
            <div>
              <label htmlFor="gate-location" className="label">
                Location
              </label>
              <input
                id="gate-location"
                className="input"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Front Entrance"
              />
            </div>

            {error && (
              <div
                className="bg-danger-50 text-danger-700 px-4 py-3 rounded-lg text-sm"
                role="alert"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              className="btn-primary w-full flex items-center justify-center gap-2"
              disabled={saving}
            >
              <Plus className="w-4 h-4" />
              {saving ? "Adding..." : "Add Gate"}
            </button>
          </form>
        </div>

        <div className="lg:col-span-5">
          <div className="card mb-3">
            <h2 className="text-sm font-medium text-gray-500">Gate Health</h2>
          </div>

          {loading ? (
            <div className="card text-center text-gray-500 py-10 animate-pulse">
              Loading gate health...
            </div>
          ) : gates.length === 0 ? (
            <div className="card text-center text-gray-500 py-10">No gates yet</div>
          ) : (
            <div className="space-y-3">
              {gates.map((g) => {
                const isSelected = g.gateId === selectedGateId;
                const guardNames = g.assignedGuards.map((x) => x.name);
                return (
                  <button
                    key={g.gateId}
                    type="button"
                    onClick={() => setSelectedGateId(g.gateId)}
                    className={`card text-left w-full transition border-2 ${
                      isSelected ? "border-primary-500" : "border-transparent"
                    }`}
                  >
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-lg bg-orange-50 flex items-center justify-center shrink-0">
                        <DoorOpen className="w-5 h-5 text-orange-600" />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium text-gray-900">{g.gateName}</p>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusStyle[g.status]}`}>
                            {g.status}
                          </span>
                        </div>

                        {g.location && <p className="text-xs text-gray-500 mt-0.5">{g.location}</p>}

                        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-600">
                          <div className="flex items-center gap-1">
                            <Clock3 className="w-3.5 h-3.5 text-gray-400" />
                            <span>{relativeActivity(g.minutesSinceLastActivity)}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Activity className="w-3.5 h-3.5 text-gray-400" />
                            <span>
                              Exits {g.todayExits} · Returns {g.todayReturns}
                            </span>
                          </div>
                          <div className="col-span-2 flex items-center gap-1">
                            <UserRound className="w-3.5 h-3.5 text-gray-400" />
                            <span>
                              Guards: {guardNames.length > 0 ? guardNames.join(", ") : "None assigned"}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="lg:col-span-4">
          <div className="card">
            <h2 className="text-sm font-medium text-gray-500 mb-4">Gate Details</h2>

            {!selectedGateId ? (
              <p className="text-sm text-gray-500">Select a gate to view details</p>
            ) : detailLoading ? (
              <p className="text-sm text-gray-500 animate-pulse">Loading details...</p>
            ) : !detail ? (
              <p className="text-sm text-gray-500">No details available.</p>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-gray-900">{detail.gateName}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusStyle[detail.status]}`}>
                      {detail.status}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {detail.location || selectedGate?.location || "No location set"}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-lg bg-gray-50 p-3">
                    <p className="text-xs text-gray-500">Today Exits</p>
                    <p className="font-semibold text-gray-900">{detail.todayExits}</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3">
                    <p className="text-xs text-gray-500">Today Returns</p>
                    <p className="font-semibold text-gray-900">{detail.todayReturns}</p>
                  </div>
                </div>

                <div className="text-xs text-gray-600 space-y-1">
                  <p>
                    <span className="text-gray-500">Last activity:</span>{" "}
                    {formatDateTime(detail.lastActivityAt)}
                  </p>
                  <p>
                    <span className="text-gray-500">Since last activity:</span>{" "}
                    {relativeActivity(detail.minutesSinceLastActivity)}
                  </p>
                </div>

                <div>
                  <p className="text-xs text-gray-500 mb-2">Recent Events</p>
                  {detail.recentEvents.length === 0 ? (
                    <p className="text-xs text-gray-500">No recent events</p>
                  ) : (
                    <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                      {detail.recentEvents.map((evt) => (
                        <div key={evt.id} className="rounded-lg border border-gray-100 p-2">
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                                evt.type === "EXIT"
                                  ? "bg-primary-50 text-primary-700"
                                  : "bg-success-50 text-success-700"
                              }`}
                            >
                              {evt.type}
                            </span>
                            <span className="text-[10px] text-gray-500">{formatDateTime(evt.timestamp)}</span>
                          </div>
                          <p className="text-xs text-gray-700 mt-1">
                            {evt.studentName} ({evt.enrollmentNo})
                          </p>
                          <p className="text-[11px] text-gray-500">
                            Pass {evt.passNumber} · Guard {evt.guardName}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
