"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function StudentHistory() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get("/api/student/history?limit=20")
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

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
  };

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Pass History</h1>

      {passes.length === 0 ? (
        <div className="card text-center text-gray-500 py-8">No history yet</div>
      ) : (
        <div className="space-y-3">
          {passes.map((pass: any) => (
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
                  <span className="text-gray-400">Requested: </span>
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
                {pass.overdueMinutes && (
                  <div className="text-danger-600">
                    Overdue: {pass.overdueMinutes}min
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
