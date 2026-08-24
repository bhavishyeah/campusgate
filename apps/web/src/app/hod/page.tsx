"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { onMessage } from "@/lib/socket";
import {
  CheckCircle,
  XCircle,
  Clock,
  User,
  AlertTriangle,
  ShieldAlert,
  Info,
} from "lucide-react";

interface GatePassRequest {
  id: string;
  passNumber: string;
  status: string;
  customReason?: string;
  allowanceWarning?: string | null;
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

interface AllowanceSummary {
  totalAllowance: number;
  consumed: number;
  remaining: number;
  periodType: string;
  periodStart: string;
  periodEnd: string;
  isExhausted: boolean;
  warningThreshold: boolean;
  currentlyOutsideElapsed: number | null;
  enforcement?: string;
}

interface ReliabilityScore {
  overall: number;
  components: {
    timelyReturnRate: number;
    completionRate: number;
    authorizationComplianceRate: number;
  };
  totalMovements: number;
  hasSufficientData: boolean;
}

interface EmergencyOverrideResponse {
  id: string;
  gatePassId: string;
  justification: string;
  createdAt: string;
}

function formatMinutes(minutes: number): string {
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hrs === 0) return `${mins}m`;
  if (mins === 0) return `${hrs}h`;
  return `${hrs}h ${mins}m`;
}

export default function HodDashboard() {
  const [requests, setRequests] = useState<GatePassRequest[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  // Emergency Override state
  const [overridePassId, setOverridePassId] = useState<string | null>(null);
  const [overrideJustification, setOverrideJustification] = useState("");
  const [overrideLoading, setOverrideLoading] = useState(false);
  const [overrideSuccess, setOverrideSuccess] = useState<{
    id: string;
    passNumber: string;
  } | null>(null);

  // Allowance and reliability info per request (keyed by pass ID)
  const [allowanceMap, setAllowanceMap] = useState<
    Record<string, AllowanceSummary>
  >({});
  const [reliabilityMap, setReliabilityMap] = useState<
    Record<string, ReliabilityScore | null>
  >({});

  const fetchData = async () => {
    try {
      const [reqs, statsData] = await Promise.all([
        api.get<GatePassRequest[]>("/api/hod/requests?status=PENDING"),
        api.get<any>("/api/hod/stats"),
      ]);
      setRequests(reqs);
      setStats(statsData);

      // Fetch allowance and reliability info for each request
      const detailEntries = await Promise.all(
        reqs.map(async (req) => {
          try {
            const detail = await api.get<any>(`/api/hod/requests/${req.id}`);
            return {
              id: req.id,
              allowance: detail.allowance as AllowanceSummary,
              reliabilityScore: detail.reliabilityScore as ReliabilityScore | null,
            };
          } catch {
            return { id: req.id, allowance: null, reliabilityScore: null };
          }
        })
      );

      const aMap: Record<string, AllowanceSummary> = {};
      const rMap: Record<string, ReliabilityScore | null> = {};
      for (const entry of detailEntries) {
        if (entry.allowance) aMap[entry.id] = entry.allowance;
        rMap[entry.id] = entry.reliabilityScore;
      }
      setAllowanceMap(aMap);
      setReliabilityMap(rMap);
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

  const handleEmergencyOverride = async () => {
    if (!overridePassId || overrideJustification.trim().length < 10) return;
    setOverrideLoading(true);
    try {
      const result = await api.post<EmergencyOverrideResponse>(
        "/api/hod/emergency-override",
        { passId: overridePassId, justification: overrideJustification.trim() }
      );
      const pass = requests.find((r) => r.id === overridePassId);
      setOverrideSuccess({
        id: result.id,
        passNumber: pass?.passNumber || "",
      });
      setOverridePassId(null);
      setOverrideJustification("");
      fetchData();
    } catch (err: any) {
      alert(err.message || "Failed to create emergency override");
    } finally {
      setOverrideLoading(false);
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
            {requests.map((req) => {
              const allowance = allowanceMap[req.id];
              const reliability = reliabilityMap[req.id];
              const showOverrideButton =
                allowance?.isExhausted &&
                allowance?.enforcement === "block_new_requests";

              return (
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

                  {/* Allowance warning from pass (warn_only enforcement) — Req 7.3 */}
                  {req.allowanceWarning && (
                    <div className="flex items-center gap-2 bg-orange-50 border border-orange-200 text-orange-800 text-sm px-3 py-2 rounded-lg mb-3">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                      <span>{req.allowanceWarning}</span>
                    </div>
                  )}

                  {/* Prominent exhaustion warning — Req 7.2 */}
                  {allowance?.isExhausted && (
                    <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg mb-3">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                      <span className="font-medium">
                        Allowance exhausted — 0 remaining of{" "}
                        {formatMinutes(allowance.totalAllowance)}
                      </span>
                    </div>
                  )}

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
                      &quot;{req.customReason}&quot;
                    </p>
                  )}

                  {/* Allowance & Reliability Info Panel — Req 7.1, 9.5, 12.3 */}
                  {allowance && (
                    <div className="bg-gray-50 rounded-lg p-3 mb-3 space-y-2">
                      {/* Remaining allowance display — Req 7.1 */}
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-gray-600 uppercase tracking-wide">
                          Outside-Time Allowance
                        </span>
                        {allowance.isExhausted ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
                            <AlertTriangle className="w-3 h-3" />
                            Exhausted
                          </span>
                        ) : allowance.warningThreshold ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">
                            <AlertTriangle className="w-3 h-3" />
                            Low
                          </span>
                        ) : null}
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-sm">
                        <div>
                          <p className="text-xs text-gray-500">Remaining</p>
                          <p
                            className={`font-semibold ${
                              allowance.isExhausted
                                ? "text-red-600"
                                : allowance.warningThreshold
                                ? "text-orange-600"
                                : "text-gray-900"
                            }`}
                          >
                            {formatMinutes(allowance.remaining)}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-500">Used</p>
                          <p className="font-semibold text-gray-900">
                            {formatMinutes(allowance.consumed)}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-500">Total</p>
                          <p className="font-semibold text-gray-900">
                            {formatMinutes(allowance.totalAllowance)}
                          </p>
                        </div>
                      </div>

                      {/* Reliability Score — Req 9.5, 12.3 (advisory only, non-blocking) */}
                      {reliability ? (
                        <div className="border-t border-gray-200 pt-2 mt-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-medium text-gray-600 uppercase tracking-wide">
                                Reliability
                              </span>
                              <span className="inline-flex items-center gap-0.5 text-xs text-gray-400">
                                <Info className="w-3 h-3" />
                                Advisory
                              </span>
                            </div>
                            <p className="text-sm font-bold text-gray-900">
                              {reliability.overall.toFixed(1)}
                              <span className="text-xs font-normal text-gray-500">
                                /5.0
                              </span>
                            </p>
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Based on {reliability.totalMovements} completed
                            movements
                          </p>
                        </div>
                      ) : (
                        <div className="border-t border-gray-200 pt-2 mt-2">
                          <p className="text-xs text-gray-400">
                            Reliability score: Insufficient data
                          </p>
                        </div>
                      )}
                    </div>
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

                  {/* Emergency Override button */}
                  {showOverrideButton && (
                    <button
                      className="w-full mt-3 flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50"
                      onClick={() => setOverridePassId(req.id)}
                      disabled={actionLoading === req.id}
                    >
                      <ShieldAlert className="w-4 h-4" />
                      Emergency Override
                    </button>
                  )}
                </div>
              );
            })}
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

      {/* Emergency Override Modal */}
      {overridePassId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center">
                <ShieldAlert className="w-5 h-5 text-orange-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">
                  Emergency Override
                </h3>
                <p className="text-xs text-gray-500">
                  Pass:{" "}
                  {requests.find((r) => r.id === overridePassId)?.passNumber}
                </p>
              </div>
            </div>

            <p className="text-sm text-gray-600 mb-3">
              This student&apos;s outside-time allowance is exhausted and new
              requests are blocked. Provide a justification to override this
              restriction for an emergency.
            </p>

            <textarea
              className="input min-h-[100px] mb-2"
              placeholder="Justification for emergency override (min 10 characters)..."
              value={overrideJustification}
              onChange={(e) => setOverrideJustification(e.target.value)}
            />
            <p className="text-xs text-gray-400 mb-4">
              {overrideJustification.trim().length}/10 characters minimum
            </p>

            <div className="flex gap-3">
              <button
                className="btn-secondary flex-1"
                onClick={() => {
                  setOverridePassId(null);
                  setOverrideJustification("");
                }}
              >
                Cancel
              </button>
              <button
                className="flex-1 flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50"
                onClick={handleEmergencyOverride}
                disabled={
                  overrideJustification.trim().length < 10 || overrideLoading
                }
              >
                {overrideLoading ? "Submitting..." : "Confirm Override"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Override Success Confirmation */}
      {overrideSuccess && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md text-center">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <CheckCircle className="w-6 h-6 text-green-600" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Emergency Override Created
            </h3>
            <p className="text-sm text-gray-600 mb-2">
              The emergency override for pass{" "}
              <span className="font-mono font-medium">
                {overrideSuccess.passNumber}
              </span>{" "}
              has been recorded.
            </p>
            <p className="text-xs text-gray-400 mb-4">
              Audit reference: {overrideSuccess.id}
            </p>
            <button
              className="btn-primary w-full"
              onClick={() => setOverrideSuccess(null)}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
