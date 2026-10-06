"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function HodApproved() {
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const fetchData = async () => {
    const data = await api.get<any[]>("/api/hod/requests?status=APPROVED");
    setRequests(data);
  };

  useEffect(() => {
    fetchData()
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleRevoke = async (passId: string) => {
    const reason = window.prompt("Enter revocation reason:");
    if (!reason || reason.trim().length < 3) {
      return;
    }

    setRevokingId(passId);
    try {
      await api.post("/api/hod/revoke", { passId, reason: reason.trim() });
      await fetchData();
    } catch (err: any) {
      alert(err.message || "Failed to revoke pass");
    } finally {
      setRevokingId(null);
    }
  };

  if (loading) {
    return <div className="animate-pulse text-gray-500 text-center py-12">Loading...</div>;
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Approved Requests</h1>

      {requests.length === 0 ? (
        <div className="card text-center text-gray-500 py-8">No approved requests</div>
      ) : (
        <div className="space-y-3">
          {requests.map((req: any) => (
            <div key={req.id} className="card">
              <div className="flex justify-between items-start">
                <div>
                  <p className="font-medium">{req.student?.name}</p>
                  <p className="text-xs text-gray-500">{req.student?.enrollmentNo}</p>
                </div>
                <span className="text-xs bg-success-50 text-success-700 px-2 py-1 rounded-full">
                  {req.status}
                </span>
              </div>
              <p className="text-sm text-gray-600 mt-2">{req.reason?.label}</p>

              <div className="mt-3 flex justify-end">
                <button
                  className="btn-danger"
                  onClick={() => handleRevoke(req.id)}
                  disabled={revokingId === req.id}
                >
                  {revokingId === req.id ? "Revoking..." : "Revoke Pass"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
