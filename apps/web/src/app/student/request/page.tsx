"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

interface ExitReason {
  id: string;
  label: string;
  requiresNote: boolean;
}

export default function RequestGatePass() {
  const router = useRouter();
  const [reasons, setReasons] = useState<ExitReason[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Form state
  const [reasonId, setReasonId] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [exitTime, setExitTime] = useState("");
  const [returnTime, setReturnTime] = useState("");
  const [step, setStep] = useState<"form" | "review">("form");

  useEffect(() => {
    // Fetch available exit reasons
    api
      .get<ExitReason[]>("/api/student/reasons")
      .then(setReasons)
      .catch(() => setError("Failed to load exit reasons"));
  }, []);

  const selectedReason = reasons.find((r) => r.id === reasonId);

  const calculateDuration = () => {
    if (!exitTime || !returnTime) return null;
    const exit = new Date(exitTime);
    const ret = new Date(returnTime);
    const diff = ret.getTime() - exit.getTime();
    if (diff <= 0) return null;
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.round((diff % 3600000) / 60000);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  };

  const isFormValid = () => {
    if (!reasonId || !exitTime || !returnTime) return false;
    if (selectedReason?.requiresNote && !customReason.trim()) return false;
    if (new Date(returnTime) <= new Date(exitTime)) return false;
    return true;
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError("");

    try {
      await api.post("/api/student/gate-pass", {
        reasonId,
        customReason: customReason || undefined,
        requestedExit: new Date(exitTime).toISOString(),
        expectedReturn: new Date(returnTime).toISOString(),
      });
      router.push("/student");
    } catch (err: any) {
      setError(err.message || "Failed to submit request");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">
        Request Gate Pass
      </h1>

      {step === "form" && (
        <div className="card space-y-5">
          {/* Reason */}
          <div>
            <label htmlFor="reason" className="label">
              Exit Reason
            </label>
            <select
              id="reason"
              className="input"
              value={reasonId}
              onChange={(e) => setReasonId(e.target.value)}
            >
              <option value="">Select a reason</option>
              {reasons.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          {/* Custom reason (if required) */}
          {selectedReason?.requiresNote && (
            <div>
              <label htmlFor="customReason" className="label">
                Please explain
              </label>
              <textarea
                id="customReason"
                className="input min-h-[80px]"
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                placeholder="Provide a reason for your exit..."
                required
              />
            </div>
          )}

          {/* Exit time */}
          <div>
            <label htmlFor="exitTime" className="label">
              Requested Exit Time
            </label>
            <input
              id="exitTime"
              type="datetime-local"
              className="input"
              value={exitTime}
              onChange={(e) => setExitTime(e.target.value)}
            />
          </div>

          {/* Return time */}
          <div>
            <label htmlFor="returnTime" className="label">
              Expected Return Time
            </label>
            <input
              id="returnTime"
              type="datetime-local"
              className="input"
              value={returnTime}
              onChange={(e) => setReturnTime(e.target.value)}
            />
          </div>

          {/* Duration */}
          {calculateDuration() && (
            <div className="bg-primary-50 text-primary-700 px-4 py-2 rounded-lg text-sm">
              Duration: <strong>{calculateDuration()}</strong>
            </div>
          )}

          {/* Time validation */}
          {exitTime && returnTime && new Date(returnTime) <= new Date(exitTime) && (
            <div className="bg-danger-50 text-danger-700 px-4 py-2 rounded-lg text-sm">
              Return time must be after exit time
            </div>
          )}

          <button
            className="btn-primary w-full"
            disabled={!isFormValid()}
            onClick={() => setStep("review")}
          >
            Review Request
          </button>
        </div>
      )}

      {step === "review" && (
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold">Review & Submit</h2>

          <div className="bg-gray-50 rounded-lg p-4 space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Reason</span>
              <span className="font-medium">{selectedReason?.label}</span>
            </div>
            {customReason && (
              <div className="flex justify-between">
                <span className="text-gray-600">Details</span>
                <span className="font-medium text-right max-w-[200px]">
                  {customReason}
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-gray-600">Exit</span>
              <span className="font-medium">
                {new Date(exitTime).toLocaleString([], {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Expected Return</span>
              <span className="font-medium">
                {new Date(returnTime).toLocaleString([], {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Duration</span>
              <span className="font-medium">{calculateDuration()}</span>
            </div>
          </div>

          {error && (
            <div className="bg-danger-50 text-danger-700 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              className="btn-secondary flex-1"
              onClick={() => setStep("form")}
            >
              Back
            </button>
            <button
              className="btn-primary flex-1"
              onClick={handleSubmit}
              disabled={loading}
            >
              {loading ? "Submitting..." : "Submit Request"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
