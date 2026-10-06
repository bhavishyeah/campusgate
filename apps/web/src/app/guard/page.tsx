"use client";

import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { api } from "@/lib/api";
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Camera,
  Search,
  Play,
  Square,
  Clock3,
} from "lucide-react";

interface VerifyResult {
  valid: boolean;
  status: string;
  action: string;
  message: string;
  pass?: {
    id: string;
    passNumber: string;
    student: {
      name: string;
      enrollmentNo: string;
      department: string;
      program: string;
    };
    reason: string;
    customReason?: string;
    approvedBy: string;
    approvedAt: string;
    requestedExit: string;
    expectedReturn: string;
    actualExit?: string;
    actualReturn?: string;
  };
}

type ShiftStatusResponse = {
  activeShift: {
    id: string;
    status: "ACTIVE";
    gateId: string;
    scheduledStartAt: string;
    scheduledEndAt: string;
    actualStartAt: string | null;
    gate: { id: string; name: string; location: string | null };
  } | null;
  nextShift: {
    id: string;
    status: "SCHEDULED";
    gateId: string;
    scheduledStartAt: string;
    scheduledEndAt: string;
    gate: { id: string; name: string; location: string | null };
  } | null;
};

type EmergencyAlert = {
  id: string;
  type: string;
  title: string;
  message: string;
  affectedArea?: string | null;
};

export default function GuardScanPage() {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [manualQuery, setManualQuery] = useState("");
  const [gateId, setGateId] = useState("");
  const [shiftInfo, setShiftInfo] = useState<ShiftStatusResponse | null>(null);
  const [shiftLoading, setShiftLoading] = useState(true);
  const [emergency, setEmergency] = useState<EmergencyAlert | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);

  const loadShift = async () => {
    setShiftLoading(true);
    try {
      const [data, emergencyData] = await Promise.all([
        api.get<ShiftStatusResponse>("/api/guard/shift/current"),
        api.get<EmergencyAlert | null>("/api/guard/emergency/active"),
      ]);
      setShiftInfo(data);
      setEmergency(emergencyData);

      if (data.activeShift?.gateId) {
        setGateId(data.activeShift.gateId);
      } else {
        const me = await api.get<any>("/api/auth/me");
        if (me.profile?.assignedGates?.[0]?.gate?.id) {
          setGateId(me.profile.assignedGates[0].gate.id);
        }
      }
    } catch {
      setShiftInfo(null);
    } finally {
      setShiftLoading(false);
    }
  };

  useEffect(() => {
    loadShift();
  }, []);

  const handleStartShift = async () => {
    if (!shiftInfo?.nextShift) return;
    setLoading(true);
    setError("");
    try {
      await api.post("/api/guard/shift/start", { shiftId: shiftInfo.nextShift.id });
      await loadShift();
    } catch (err: any) {
      setError(err.message || "Failed to start shift");
    } finally {
      setLoading(false);
    }
  };

  const handleEndShift = async () => {
    if (!shiftInfo?.activeShift) return;
    setLoading(true);
    setError("");
    try {
      await api.post("/api/guard/shift/end", { shiftId: shiftInfo.activeShift.id });
      await loadShift();
    } catch (err: any) {
      setError(err.message || "Failed to end shift");
    } finally {
      setLoading(false);
    }
  };

  const startScanner = async () => {
    setResult(null);
    setError("");
    setScanning(true);

    try {
      const scanner = new Html5Qrcode("qr-reader");
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          await scanner.stop();
          setScanning(false);
          verifyToken(decodedText);
        },
        () => {}
      );
    } catch {
      setScanning(false);
      setError("Camera access denied or not available");
    }
  };

  const stopScanner = async () => {
    if (scannerRef.current) {
      await scannerRef.current.stop();
      scannerRef.current = null;
    }
    setScanning(false);
  };

  const verifyToken = async (qrToken: string) => {
    setLoading(true);
    setError("");
    try {
      const data = await api.post<VerifyResult>("/api/guard/verify", {
        qrToken,
      });
      setResult(data);
    } catch (err: any) {
      setError(err.message || "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  const handleManualLookup = async () => {
    if (!manualQuery.trim()) return;
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const pass = await api.get<any>(`/api/guard/lookup?query=${encodeURIComponent(manualQuery)}`);
      if (pass.qrToken) {
        await verifyToken(pass.qrToken);
      }
    } catch (err: any) {
      setError(err.message || "No pass found");
    } finally {
      setLoading(false);
    }
  };

  const handleMarkExit = async () => {
    if (!result?.pass) return;
    if (!gateId) {
      setError("No gate available. Contact admin.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await api.post("/api/guard/mark-exit", {
        passId: result.pass.id,
        gateId,
      });
      setResult(null);
      alert("✅ Exit recorded successfully");
    } catch (err: any) {
      setError(err.message || "Failed to record exit");
    } finally {
      setLoading(false);
    }
  };

  const handleMarkReturn = async () => {
    if (!result?.pass) return;
    if (!gateId) {
      setError("No gate available. Contact admin.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await api.post("/api/guard/mark-return", {
        passId: result.pass.id,
        gateId,
      });
      setResult(null);
      alert("✅ Return recorded successfully");
    } catch (err: any) {
      setError(err.message || "Failed to record return");
    } finally {
      setLoading(false);
    }
  };

  const shiftPanel = () => {
    if (shiftLoading) {
      return <div className="bg-gray-800 rounded-xl p-4 text-gray-400 animate-pulse">Loading shift...</div>;
    }

    if (shiftInfo?.activeShift) {
      const s = shiftInfo.activeShift;
      return (
        <div className="bg-green-900/20 border border-green-700 rounded-xl p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-green-300 font-semibold">Shift Active</p>
              <p className="text-xs text-gray-300 mt-1">
                {s.gate.name}
                {s.gate.location ? ` • ${s.gate.location}` : ""}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                Scheduled: {new Date(s.scheduledStartAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                {" "}→{" "}
                {new Date(s.scheduledEndAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
            <button
              onClick={handleEndShift}
              disabled={loading}
              className="bg-danger-600 hover:bg-danger-700 text-white text-sm px-3 py-2 rounded-lg flex items-center gap-2"
            >
              <Square className="w-4 h-4" />
              End Shift
            </button>
          </div>
        </div>
      );
    }

    if (shiftInfo?.nextShift) {
      const s = shiftInfo.nextShift;
      return (
        <div className="bg-yellow-900/20 border border-yellow-700 rounded-xl p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-yellow-300 font-semibold">Upcoming Shift</p>
              <p className="text-xs text-gray-300 mt-1">
                {s.gate.name}
                {s.gate.location ? ` • ${s.gate.location}` : ""}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                <Clock3 className="w-3.5 h-3.5 inline mr-1" />
                {new Date(s.scheduledStartAt).toLocaleString()} → {new Date(s.scheduledEndAt).toLocaleString()}
              </p>
            </div>
            <button
              onClick={handleStartShift}
              disabled={loading}
              className="bg-green-600 hover:bg-green-700 text-white text-sm px-3 py-2 rounded-lg flex items-center gap-2"
            >
              <Play className="w-4 h-4" />
              Start Shift
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="bg-gray-800 rounded-xl p-4 text-gray-400 text-sm">
        No active or upcoming shifts. Contact admin to schedule your shift.
      </div>
    );
  };

  return (
    <div className="max-w-lg mx-auto space-y-6">
      {emergency && (
        <div className="bg-danger-900/30 border border-danger-600 rounded-xl p-4 text-danger-100">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="w-5 h-5" />
            <p className="font-semibold">Emergency Alert · {emergency.type}</p>
          </div>
          <p className="text-sm font-medium">{emergency.title}</p>
          <p className="text-sm mt-1 whitespace-pre-wrap">{emergency.message}</p>
          {emergency.affectedArea && <p className="text-xs mt-2">Area: {emergency.affectedArea}</p>}
        </div>
      )}

      {shiftPanel()}

      <div className="text-center">
        <div
          id="qr-reader"
          className={`mx-auto rounded-xl overflow-hidden ${scanning ? "block" : "hidden"}`}
          style={{ width: "100%", maxWidth: 400 }}
        />

        {!scanning && !result && (
          <button
            onClick={startScanner}
            disabled={!shiftInfo?.activeShift}
            className="bg-primary-600 hover:bg-primary-700 disabled:bg-gray-700 disabled:text-gray-400 text-white font-bold py-6 px-8 rounded-2xl text-xl flex items-center gap-3 mx-auto"
          >
            <Camera className="w-8 h-8" />
            SCAN PASS
          </button>
        )}

        {scanning && (
          <button onClick={stopScanner} className="btn-secondary mt-4">
            Cancel Scan
          </button>
        )}
      </div>

      <div className="bg-gray-800 rounded-xl p-4">
        <h3 className="text-sm text-gray-400 mb-2">Manual Lookup</h3>
        <div className="flex gap-2">
          <input
            type="text"
            className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500"
            placeholder="Pass # or Enrollment #"
            value={manualQuery}
            onChange={(e) => setManualQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleManualLookup()}
          />
          <button onClick={handleManualLookup} className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg" disabled={loading || !shiftInfo?.activeShift}>
            <Search className="w-5 h-5" />
          </button>
        </div>
      </div>

      {loading && <div className="text-center text-gray-400 animate-pulse">Working...</div>}

      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-3 rounded-xl flex items-center gap-2">
          <XCircle className="w-5 h-5 shrink-0" />
          {error}
        </div>
      )}

      {result && (
        <div
          className={`rounded-xl p-5 border-2 ${
            result.valid
              ? result.status === "OVERDUE"
                ? "bg-yellow-900/30 border-yellow-600"
                : "bg-green-900/30 border-green-600"
              : "bg-red-900/30 border-red-600"
          }`}
        >
          <div className="flex items-center gap-3 mb-4">
            {result.valid ? (
              result.status === "OVERDUE" ? (
                <AlertTriangle className="w-8 h-8 text-yellow-400" />
              ) : (
                <CheckCircle className="w-8 h-8 text-green-400" />
              )
            ) : (
              <XCircle className="w-8 h-8 text-red-400" />
            )}
            <div>
              <h2 className="text-xl font-bold">{result.valid ? "VALID PASS" : "INVALID"}</h2>
              <p className="text-sm opacity-75">{result.message}</p>
            </div>
          </div>

          {result.pass && (
            <div className="space-y-3 text-sm">
              <div className="bg-black/20 rounded-lg p-3">
                <p className="text-lg font-bold">{result.pass.student.name}</p>
                <p className="text-gray-400">
                  {result.pass.student.program} • {result.pass.student.department}
                </p>
                <p className="text-gray-400 font-mono">{result.pass.student.enrollmentNo}</p>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-gray-400">Reason</span>
                  <p className="font-medium">{result.pass.reason}</p>
                </div>
                <div>
                  <span className="text-gray-400">Approved By</span>
                  <p className="font-medium">{result.pass.approvedBy}</p>
                </div>
                <div>
                  <span className="text-gray-400">Expected Return</span>
                  <p className="font-medium">
                    {new Date(result.pass.expectedReturn).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
                <div>
                  <span className="text-gray-400">Pass #</span>
                  <p className="font-medium font-mono">{result.pass.passNumber}</p>
                </div>
              </div>

              {result.action === "MARK_EXIT" && (
                <button
                  onClick={handleMarkExit}
                  className="w-full py-4 bg-green-600 hover:bg-green-700 text-white font-bold text-lg rounded-xl mt-4"
                  disabled={loading}
                >
                  MARK EXIT
                </button>
              )}

              {result.action === "MARK_RETURN" && (
                <button
                  onClick={handleMarkReturn}
                  className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold text-lg rounded-xl mt-4"
                  disabled={loading}
                >
                  MARK RETURN
                </button>
              )}
            </div>
          )}

          <button onClick={() => setResult(null)} className="btn-secondary w-full mt-4">
            Scan Another
          </button>
        </div>
      )}
    </div>
  );
}
