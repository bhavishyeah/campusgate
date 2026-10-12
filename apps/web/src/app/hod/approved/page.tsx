"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { X } from "lucide-react";

interface Pass {
  id: string;
  passNumber: string;
  status: string;
  createdAt: string;
  student?: { name: string; enrollmentNo: string };
  reason?: { label: string };
}

const statusColors: Record<string, string> = {
  APPROVED: "bg-primary-50 text-primary-700",
  ACTIVE: "bg-success-50 text-success-700",
  OUTSIDE: "bg-warning-50 text-warning-600",
};

export default function HodApproved() {
  const [requests, setRequests] = useState<Pass[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [targetPass, setTargetPass] = useState<Pass | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [revokeError, setRevokeError] = useState("");

  const fetchData = async () => {
    try {
      // Fetch APPROVED, ACTIVE and OUTSIDE passes — all revocable
      const [approved, active, outside] = await Promise.all([
        api.get<Pass[]>("/api/hod/requests?status=APPROVED"),
        api.get<Pass[]>("/api/hod/requests?status=ACTIVE"),
        api.get<Pass[]>("/api/hod/requests?status=OUTSIDE"),
      ]);
      // Deduplicate just in case
      const seen = new Set<string>();
      const all: Pass[] = [];
      for (const p of [...approved, ...active, ...outside]) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          all.push(p);
        }
      }
      setRequests(all);
    } catch (err: any) {
      setError(err.message || "Failed to load approved passes");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const openRevoke = (pass: Pass) => {
    setTargetPass(pass);
    setRevokeReason("");
    setRevokeError("");
    setShowModal(true);
  };

  const confirmRevoke = async () => {
    if (!targetPass) return;
    if (revokeReason.trim().length < 3) {
      setRevokeError("Reason must be at least 3 characters");
      return;
    }
    setRevokingId(targetPass.id);
    setRevokeError("");
    try {
      await api.post("/api/hod/revoke", {
        passId: targetPass.id,
        reason: revokeReason.trim(),
      });
      setShowModal(false);
      setTargetPass(null);
      await fetchData();
    } catch (err: any) {
      setRevokeError(err.message || "Failed to revoke pass");
    } finally {
      setRevokingId(null);
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse text-gray-500 text-center py-12">
        Loading...
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">
        Active Passes
      </h1>

      {error && (
        <div className="bg-danger-50 text-danger-700 px-4 py-3 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}

      {requests.length === 0 ? (
        <div className="card text-center text-gray-500 py-8">
          No active passes
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((req) => (
            <div key={req.id} className="card">
              <div className="flex justify-between items-start">
                <div>
                  <p className="font-medium text-gray-900">
                    {req.student?.name}
                  </p>
                  <p className="text-xs text-gray-500">
                    {req.student?.enrollmentNo}
                  </p>
                </div>
                <span
                  className={`text-xs px-2 py-1 rounded-full font-medium ${statusColors[req.status] ?? "bg-gray-100 text-gray-600"}`}
                >
                  {req.status}
                </span>
              </div>
              <p className="text-sm text-gray-600 mt-2">{req.reason?.label}</p>
              <p className="text-xs text-gray-400 mt-1 font-mono">
                {req.passNumber}
              </p>

              <div className="mt-3 flex justify-end">
                <button
                  className="btn-danger text-sm"
                  onClick={() => openRevoke(req)}
                  disabled={revokingId === req.id}
                >
                  Revoke Pass
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Revoke modal */}
      {showModal && targetPass && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">
                Revoke Pass
              </h3>
              <button
                onClick={() => setShowModal(false)}
                aria-label="Close"
              >
                <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
              </button>
            </div>

            <p className="text-sm text-gray-600 mb-4">
              Revoking{" "}
              <span className="font-medium">{targetPass.passNumber}</span> for{" "}
              <span className="font-medium">{targetPass.student?.name}</span>.
              The student will be notified immediately.
            </p>

            <div className="mb-4">
              <label className="label">Reason for revocation</label>
              <textarea
                className="input min-h-[80px]"
                value={revokeReason}
                onChange={(e) => setRevokeReason(e.target.value)}
                placeholder="Provide a reason (min 3 characters)..."
                autoFocus
              />
            </div>

            {revokeError && (
              <div className="bg-danger-50 text-danger-700 px-3 py-2 rounded-lg text-sm mb-4">
                {revokeError}
              </div>
            )}

            <div className="flex gap-3">
              <button
                className="btn-secondary flex-1"
                onClick={() => setShowModal(false)}
              >
                Cancel
              </button>
              <button
                className="btn-danger flex-1"
                onClick={confirmRevoke}
                disabled={!!revokingId}
              >
                {revokingId ? "Revoking..." : "Confirm Revoke"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
