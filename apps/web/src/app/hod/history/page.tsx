"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function HodHistory() {
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, { summary?: any; timeline?: any[] }>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api
      .get<any[]>("/api/hod/requests?status=ALL")
      .then(setRequests)
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
        api.get<any>(`/api/hod/requests/${passId}/summary`),
        api.get<{ timeline: any[] }>(`/api/hod/requests/${passId}/timeline`),
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
    return <div className="animate-pulse text-gray-500 text-center py-12">Loading...</div>;
  }

  const statusColors: Record<string, string> = {
    COMPLETED: "bg-success-50 text-success-700",
    REJECTED: "bg-danger-50 text-danger-700",
    PENDING: "bg-warning-50 text-warning-600",
    APPROVED: "bg-primary-50 text-primary-700",
    OUTSIDE: "bg-primary-50 text-primary-700",
    REVOKED: "bg-danger-50 text-danger-700",
    CANCELLED: "bg-gray-100 text-gray-600",
  };

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">All Requests</h1>

      {requests.length === 0 ? (
        <div className="card text-center text-gray-500 py-8">No requests yet</div>
      ) : (
        <div className="space-y-3">
          {requests.map((req: any) => {
            const detail = details[req.id];
            const isExpanded = !!expanded[req.id];
            const isLoadingDetail = !!detailLoading[req.id];

            return (
              <div key={req.id} className="card">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-medium">{req.student?.name}</p>
                    <p className="text-xs text-gray-500">
                      {req.student?.enrollmentNo} • {req.reason?.label}
                    </p>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColors[req.status] || "bg-gray-100 text-gray-600"}`}>
                    {req.status}
                  </span>
                </div>
                <div className="mt-2 text-xs text-gray-500">
                  {new Date(req.createdAt).toLocaleString()}
                </div>

                <div className="mt-3">
                  <button className="btn-secondary text-sm" onClick={() => toggleDetails(req.id)}>
                    {isExpanded ? "Hide Summary & Timeline" : "View Summary & Timeline"}
                  </button>
                </div>

                {isExpanded && (
                  <div className="mt-3 border-t pt-3 space-y-3">
                    {isLoadingDetail && <p className="text-xs text-gray-500">Loading details...</p>}

                    {!isLoadingDetail && detail?.summary && (
                      <div className="text-xs text-gray-700 bg-gray-50 rounded p-2 space-y-1">
                        <p><span className="text-gray-500">Pass #:</span> {detail.summary.passNumber}</p>
                        <p><span className="text-gray-500">Approved By:</span> {detail.summary.approval?.approvedBy || "—"}</p>
                        <p><span className="text-gray-500">Approved At:</span> {detail.summary.approval?.approvedAt ? new Date(detail.summary.approval.approvedAt).toLocaleString() : "—"}</p>
                        <p><span className="text-gray-500">Outside Duration:</span> {detail.summary.movement?.outsideDurationMinutes != null ? `${detail.summary.movement.outsideDurationMinutes}m` : "—"}</p>
                      </div>
                    )}

                    {!isLoadingDetail && detail?.timeline && detail.timeline.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-gray-600 mb-2">Timeline</p>
                        <div className="space-y-2">
                          {detail.timeline.map((t: any, i: number) => (
                            <div key={`${req.id}-${i}`} className="text-xs">
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
