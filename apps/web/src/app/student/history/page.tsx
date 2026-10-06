"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

function formatDuration(exitIso: string | null, returnIso: string | null): string {
  if (!exitIso || !returnIso) return "—";
  const ms = new Date(returnIso).getTime() - new Date(exitIso).getTime();
  if (ms <= 0) return "—";
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function StudentHistory() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, { summary?: any; timeline?: any[] }>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api
      .get("/api/student/history?limit=20")
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const toggleDetails = async (passId: string) => {
    const next = !expanded[passId];
    setExpanded((prev) => ({ ...prev, [passId]: next }));

    if (!next || details[passId]) return;

    setDetailLoading((prev) => ({ ...prev, [passId]: true }));
    try {
      const [summary, timelineRes] = await Promise.all([
        api.get<any>(`/api/student/gate-pass/${passId}/summary`),
        api.get<{ timeline: any[] }>(`/api/student/gate-pass/${passId}/timeline`),
      ]);

      setDetails((prev) => ({
        ...prev,
        [passId]: {
          summary,
          timeline: timelineRes.timeline || [],
        },
      }));
    } catch (err) {
      console.error(err);
    } finally {
      setDetailLoading((prev) => ({ ...prev, [passId]: false }));
    }
  };

  if (loading) {
    return <div className="animate-pulse text-gray-500 text-center py-12">Loading history...</div>;
  }

  const passes = data?.passes || [];

  const statusColors: Record<string, string> = {
    COMPLETED: "bg-success-50 text-success-700",
    REJECTED: "bg-danger-50 text-danger-700",
    CANCELLED: "bg-gray-100 text-gray-600",
    PENDING: "bg-warning-50 text-warning-600",
    APPROVED: "bg-primary-50 text-primary-700",
    OUTSIDE: "bg-primary-50 text-primary-700",
    EXPIRED: "bg-gray-100 text-gray-600",
    REVOKED: "bg-danger-50 text-danger-700",
  };

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Pass History</h1>

      {passes.length === 0 ? (
        <div className="card text-center text-gray-500 py-8">No history yet</div>
      ) : (
        <div className="space-y-3">
          {passes.map((pass: any) => {
            const detail = details[pass.id];
            const isExpanded = !!expanded[pass.id];
            const isLoading = !!detailLoading[pass.id];

            return (
              <div key={pass.id} className="card">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <p className="font-mono text-xs text-gray-400">{pass.passNumber}</p>
                    <p className="font-medium text-gray-900">{pass.reason?.label}</p>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColors[pass.status] || "bg-gray-100"}`}>
                    {pass.status}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
                  <div>
                    <span className="text-gray-400">Date: </span>
                    {new Date(pass.createdAt).toLocaleDateString()}
                  </div>
                  <div>
                    <span className="text-gray-400">Exit: </span>
                    {pass.actualExit ? new Date(pass.actualExit).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
                  </div>
                  <div>
                    <span className="text-gray-400">Return: </span>
                    {pass.actualReturn ? new Date(pass.actualReturn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
                  </div>
                  <div>
                    <span className="text-gray-400">Duration: </span>
                    <span className="font-medium text-gray-900">
                      {formatDuration(pass.actualExit, pass.actualReturn)}
                    </span>
                  </div>
                </div>

                {pass.overdueMinutes && pass.overdueMinutes > 0 && (
                  <div className="mt-2 text-xs text-danger-600 bg-danger-50 px-2 py-1 rounded inline-block">
                    Overdue by {pass.overdueMinutes}m
                  </div>
                )}

                <div className="mt-3">
                  <button className="btn-secondary text-sm" onClick={() => toggleDetails(pass.id)}>
                    {isExpanded ? "Hide Summary & Timeline" : "View Summary & Timeline"}
                  </button>
                </div>

                {isExpanded && (
                  <div className="mt-3 border-t pt-3 space-y-3">
                    {isLoading && <p className="text-xs text-gray-500">Loading details...</p>}

                    {!isLoading && detail?.summary && (
                      <div className="text-xs text-gray-700 bg-gray-50 rounded p-2 space-y-1">
                        <p><span className="text-gray-500">Approved By:</span> {detail.summary.approval?.approvedBy || "—"}</p>
                        <p><span className="text-gray-500">Approved At:</span> {detail.summary.approval?.approvedAt ? new Date(detail.summary.approval.approvedAt).toLocaleString() : "—"}</p>
                        <p><span className="text-gray-500">Outside Duration:</span> {detail.summary.movement?.outsideDurationMinutes != null ? `${detail.summary.movement.outsideDurationMinutes}m` : "—"}</p>
                      </div>
                    )}

                    {!isLoading && detail?.timeline && detail.timeline.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-gray-600 mb-2">Timeline</p>
                        <div className="space-y-2">
                          {detail.timeline.map((t: any, i: number) => (
                            <div key={`${pass.id}-${i}`} className="text-xs">
                              <p className="text-gray-900 font-medium">{new Date(t.at).toLocaleString()} · {t.title}</p>
                              {t.detail && <p className="text-gray-500">{t.detail}</p>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
