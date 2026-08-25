"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Shield } from "lucide-react";

interface AuditLog {
  id: string;
  action: string;
  targetId: string | null;
  targetType: string | null;
  metadata: Record<string, unknown> | null;
  timestamp: string;
  actor: { id: string; email: string; role: string };
}

interface AuditResponse {
  logs: AuditLog[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

const ACTIONS = [
  "PASS_REQUESTED",
  "PASS_APPROVED",
  "PASS_REJECTED",
  "PASS_CANCELLED",
  "PASS_REVOKED",
  "PASS_EXPIRED",
  "GATE_EXIT",
  "GATE_RETURN",
  "USER_CREATED",
  "USER_UPDATED",
  "USER_DEACTIVATED",
  "USER_REACTIVATED",
  "GATE_CREATED",
  "GATE_UPDATED",
  "DEPARTMENT_CREATED",
  "DEPARTMENT_UPDATED",
  "REASON_CREATED",
  "REASON_UPDATED",
  "BULK_IMPORT",
];

function actionStyle(action: string) {
  if (action.includes("APPROVED") || action.includes("REACTIVATED"))
    return "bg-success-50 text-success-700";
  if (
    action.includes("REJECTED") ||
    action.includes("REVOKED") ||
    action.includes("DEACTIVATED")
  )
    return "bg-danger-50 text-danger-700";
  if (action.startsWith("GATE_")) return "bg-primary-50 text-primary-700";
  if (action.includes("CANCELLED") || action.includes("EXPIRED"))
    return "bg-gray-100 text-gray-600";
  return "bg-warning-50 text-warning-600";
}

export default function AdminAuditPage() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [action, setAction] = useState("");
  const [page, setPage] = useState(1);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (action) params.set("action", action);
      setData(await api.get<AuditResponse>(`/api/admin/audit-logs?${params}`));
    } catch (err: any) {
      setError(err.message || "Failed to load audit logs");
    } finally {
      setLoading(false);
    }
  }, [page, action]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Shield className="w-6 h-6 text-gray-700" />
        <h1 className="text-2xl font-bold text-gray-900">Audit Log</h1>
      </div>

      <div className="card mb-4 flex flex-wrap gap-4 items-end">
        <div>
          <label htmlFor="action-filter" className="label">
            Action
          </label>
          <select
            id="action-filter"
            className="input"
            value={action}
            onChange={(e) => {
              setPage(1);
              setAction(e.target.value);
            }}
          >
            <option value="">All actions</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        {data && (
          <p className="text-sm text-gray-500 ml-auto">
            {data.pagination.total} record{data.pagination.total === 1 ? "" : "s"}
          </p>
        )}
      </div>

      {error && (
        <div
          className="bg-danger-50 border border-danger-500 text-danger-700 px-4 py-3 rounded-lg text-sm mb-4"
          role="alert"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="card text-center text-gray-500 py-10 animate-pulse">
          Loading audit log...
        </div>
      ) : !data || data.logs.length === 0 ? (
        <div className="card text-center text-gray-500 py-10">
          No audit records found
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <caption className="sr-only">Security audit records</caption>
            <thead className="bg-gray-50 text-left">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium text-gray-600">Time</th>
                <th scope="col" className="px-4 py-3 font-medium text-gray-600">Actor</th>
                <th scope="col" className="px-4 py-3 font-medium text-gray-600">Action</th>
                <th scope="col" className="px-4 py-3 font-medium text-gray-600">Target</th>
                <th scope="col" className="px-4 py-3 font-medium text-gray-600">Context</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.logs.map((log) => (
                <tr key={log.id}>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {new Date(log.timestamp).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-gray-900">{log.actor?.email ?? "—"}</p>
                    <p className="text-xs text-gray-500">{log.actor?.role}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs px-2 py-1 rounded-full font-medium whitespace-nowrap ${actionStyle(log.action)}`}
                    >
                      {log.action.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    <p>{log.targetType ?? "—"}</p>
                    {log.targetId && (
                      <p className="text-xs text-gray-400 font-mono truncate max-w-[140px]">
                        {log.targetId}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {log.metadata && Object.keys(log.metadata).length > 0 ? (
                      <code className="text-xs text-gray-600 break-all">
                        {JSON.stringify(log.metadata)}
                      </code>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 mt-4">
          <button
            className="btn-secondary"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            Previous
          </button>
          <span className="text-sm text-gray-600">
            Page {data.pagination.page} of {data.pagination.totalPages}
          </span>
          <button
            className="btn-secondary"
            onClick={() => setPage((p) => Math.min(data.pagination.totalPages, p + 1))}
            disabled={page >= data.pagination.totalPages}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
