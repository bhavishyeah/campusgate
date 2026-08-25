"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Plus, FileText } from "lucide-react";

interface ExitReason {
  id: string;
  label: string;
  requiresNote: boolean;
  isActive: boolean;
}

export default function AdminReasonsPage() {
  const [reasons, setReasons] = useState<ExitReason[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [requiresNote, setRequiresNote] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchReasons = async () => {
    try {
      setReasons(await api.get<ExitReason[]>("/api/admin/reasons"));
    } catch (err: any) {
      setError(err.message || "Failed to load exit reasons");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReasons();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await api.post("/api/admin/reasons", { label, requiresNote });
      setLabel("");
      setRequiresNote(false);
      await fetchReasons();
    } catch (err: any) {
      setError(err.message || "Failed to create exit reason");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Exit Reasons</h1>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card lg:col-span-1">
          <h2 className="text-sm font-medium text-gray-500 mb-4">Add Reason</h2>
          <form onSubmit={create} className="space-y-4">
            <div>
              <label htmlFor="reason-label" className="label">
                Label
              </label>
              <input
                id="reason-label"
                className="input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Medical"
                required
              />
            </div>

            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={requiresNote}
                onChange={(e) => setRequiresNote(e.target.checked)}
              />
              <span>
                Require explanation
                <span className="block text-xs text-gray-500">
                  Students must provide written details when selecting this reason.
                </span>
              </span>
            </label>

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
              {saving ? "Adding..." : "Add Reason"}
            </button>
          </form>
        </div>

        <div className="lg:col-span-2">
          {loading ? (
            <div className="card text-center text-gray-500 py-10 animate-pulse">
              Loading exit reasons...
            </div>
          ) : reasons.length === 0 ? (
            <div className="card text-center text-gray-500 py-10">
              No exit reasons configured
            </div>
          ) : (
            <div className="space-y-3">
              {reasons.map((r) => (
                <div key={r.id} className="card flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center shrink-0">
                    <FileText className="w-5 h-5 text-primary-600" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-gray-900">{r.label}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {r.requiresNote
                        ? "Explanation required"
                        : "No explanation required"}
                    </p>
                  </div>
                  <span
                    className={`text-xs px-2 py-1 rounded-full font-medium ${
                      r.isActive
                        ? "bg-success-50 text-success-700"
                        : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {r.isActive ? "Active" : "Inactive"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
