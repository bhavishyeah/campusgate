"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { onMessage } from "@/lib/socket";
import { CheckCircle, XCircle, Clock, User } from "lucide-react";

interface GatePassRequest {
  id: string;
  passNumber: string;
  status: string;
  customReason?: string;
  requestedExit: string;
  expectedReturn: string;
  createdAt: string;
  student: {
    name: string;
    enrollmentNo: string;
    program: string;
    department: { name: string };
  };
  reason: { label: string };
}

export default function HodDashboard() {
  const [requests, setRequests] = useState<GatePassRequest[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const fetchData = async () => {
    try {
      const [reqs, statsData] = await Promise.all([
        api.get<GatePassRequest[]>("/api/hod/requests?status=PENDING"),
        api.get<any>("/api/hod/stats"),
      ]);
      setRequests(reqs);
      setStats(statsData);
    } catch (err) {
      console.error("Failed to fetch HOD data", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const unsubscribe = onMessage("notification", fetchData);
    return unsubscribe;
  }, []);

  const handleApprove = async (passId: string) => {
    setActionLoading(passId);
    try {
      await api.post("/api/hod/approve", { passId });
      fetchData();
    } catch (err: any) {
      alert(err.message || "Failed to approve");
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async () => {
    if (!rejectId || !rejectReason.trim()) return;
    setActionLoading(rejectId);
    try {
      await api.post("/api/hod/reject", {
        passId: rejectId,
        rejectionReason: rejectReason,
      });
      setRejectId(null);
      setRejectReason("");
      fetchData();
    } catch (err: any) {
      alert(err.message || "Failed to reject");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-pulse text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="card text-center">
            <p className="text-2xl font-bold text-warning-600">
              {stats.pending}
            </p>
            <p className="text-xs text-gray-500">Pending</p>
          </div>
          <div className="card text-center">
            <p className="text-2xl font-bold text-success-600">
              {stats.approvedToday}
            </p>
            <p className="text-xs text-gray-500">Approved Today</p>
          </div>
          <div className="card text-center">
            <p className="text-2xl font-bold text-danger-600">
              {stats.rejectedToday}
            </p>
            <p className="text-xs text-gray-500">Rejected Today</p>
          </div>
          <div className="card text-center">
            <p className="text-2xl font-bold text-primary-600">
              {stats.currentlyOutside}
            </p>
            <p className="text-xs text-gray-500">Outside Now</p>
          </div>
        </div>
      )}

      {/* Pending Requests */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Clock className="w-5 h-5 text-warning-500" />
          Pending Requests ({requests.length})
        </h2>

        {requests.length === 0 ? (
          <div className="card text-center text-gray-500 py-8">
            No pending requests
          </div>
        ) : (
          <div className="space-y-3">
            {requests.map((req) => (
              <div key={req.id} className="card">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-primary-100 flex items-center justify-center">
                      <User className="w-5 h-5 text-primary-600" />
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">
                        {req.student.name}
                      </p>
                      <p className="text-xs text-gray-500">
                        {req.student.enrollmentNo} • {req.student.program}
                      </p>
                    </div>
                  </div>
                  <span className="text-xs text-gray-400 font-mono">
                    {req.passNumber}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-sm mb-4">
                  <div>
                    <span className="text-gray-500">Reason:</span>{" "}
                    <span className="font-medium">{req.reason.label}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Exit:</span>{" "}
                    <span className="font-medium">
                      {new Date(req.requestedExit).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Return:</span>{" "}
                    <span className="font-medium">
                      {new Date(req.expectedReturn).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Requested:</span>{" "}
                    <span className="font-medium">
                      {new Date(req.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                </div>

                {req.customReason && (
                  <p className="text-sm text-gray-600 bg-gray-50 p-2 rounded mb-3">
                    "{req.customReason}"
                  </p>
                )}

                {/* Action buttons */}
                <div className="flex gap-3">
                  <button
                    className="flex-1 flex items-center justify-center gap-2 bg-success-500 hover:bg-success-600 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50"
                    onClick={() => handleApprove(req.id)}
                    disabled={actionLoading === req.id}
                  >
                    <CheckCircle className="w-4 h-4" />
                    Approve
                  </button>
                  <button
                    className="flex-1 flex items-center justify-center gap-2 bg-danger-500 hover:bg-danger-600 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50"
                    onClick={() => setRejectId(req.id)}
                    disabled={actionLoading === req.id}
                  >
                    <XCircle className="w-4 h-4" />
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Reject Modal */}
      {rejectId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-4">Rejection Reason</h3>
            <textarea
              className="input min-h-[100px] mb-4"
              placeholder="Please provide a reason for rejection..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
            <div className="flex gap-3">
              <button
                className="btn-secondary flex-1"
                onClick={() => {
                  setRejectId(null);
                  setRejectReason("");
                }}
              >
                Cancel
              </button>
              <button
                className="btn-danger flex-1"
                onClick={handleReject}
                disabled={!rejectReason.trim() || actionLoading === rejectId}
              >
                Confirm Reject
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
