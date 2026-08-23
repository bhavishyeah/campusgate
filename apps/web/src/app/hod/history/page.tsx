"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function HodHistory() {
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<any[]>("/api/hod/requests?status=ALL")
      .then(setRequests)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="animate-pulse text-gray-500 text-center py-12">Loading...</div>;
  }

  const statusColors: Record<string, string> = {
    COMPLETED: "bg-success-50 text-success-700",
    REJECTED: "bg-danger-50 text-danger-700",
    PENDING: "bg-warning-50 text-warning-600",
    APPROVED: "bg-primary-50 text-primary-700",
    OUTSIDE: "bg-primary-50 text-primary-700",
  };

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">All Requests</h1>

      {requests.length === 0 ? (
        <div className="card text-center text-gray-500 py-8">No requests yet</div>
      ) : (
        <div className="space-y-3">
          {requests.map((req: any) => (
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
