"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Plus, DoorOpen } from "lucide-react";

interface Gate {
  id: string;
  name: string;
  location: string | null;
  isActive: boolean;
  assignedGuards?: { guard: { id: string; name: string } }[];
}

export default function AdminGatesPage() {
  const [gates, setGates] = useState<Gate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchGates = async () => {
    try {
      setGates(await api.get<Gate[]>("/api/admin/gates"));
    } catch (err: any) {
      setError(err.message || "Failed to load gates");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGates();
  }, []);

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
      await fetchGates();
    } catch (err: any) {
      setError(err.message || "Failed to create gate");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Gates</h1>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card lg:col-span-1">
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

        <div className="lg:col-span-2">
          {loading ? (
            <div className="card text-center text-gray-500 py-10 animate-pulse">
              Loading gates...
            </div>
          ) : gates.length === 0 ? (
            <div className="card text-center text-gray-500 py-10">No gates yet</div>
          ) : (
            <div className="space-y-3">
              {gates.map((g) => {
                const guards = (g.assignedGuards ?? []).map((a) => a.guard.name);
                return (
                  <div key={g.id} className="card">
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-lg bg-orange-50 flex items-center justify-center shrink-0">
                        <DoorOpen className="w-5 h-5 text-orange-600" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium text-gray-900">{g.name}</p>
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                              g.isActive
                                ? "bg-success-50 text-success-700"
                                : "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {g.isActive ? "Active" : "Inactive"}
                          </span>
                        </div>
                        {g.location && (
                          <p className="text-xs text-gray-500 mt-0.5">{g.location}</p>
                        )}
                        <p className="text-xs text-gray-500 mt-2">
                          <span className="text-gray-400">Guards: </span>
                          {guards.length > 0 ? guards.join(", ") : "None assigned"}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
