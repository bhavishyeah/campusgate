"use client";

import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Camera,
  Search,
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

export default function GuardScanPage() {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [manualQuery, setManualQuery] = useState("");
  const [gateId, setGateId] = useState("");
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const { user } = useAuthStore();

  // Get assigned gate from profile
  useEffect(() => {
    // Fetch full profile with gate assignments
    api.get<any>("/api/auth/me").then((data) => {
      if (data.profile?.assignedGates?.[0]?.gate?.id) {
        setGateId(data.profile.assignedGates[0].gate.id);
      }
    }).catch(() => {});
  }, []);

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
          // Stop scanner after successful read
          await scanner.stop();
          setScanning(false);
          verifyToken(decodedText);
        },
        () => {} // Ignore scan failures
      );
    } catch (err) {
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
      const pass = await api.get<any>(
        `/api/guard/lookup?query=${encodeURIComponent(manualQuery)}`
      );
      // Verify the pass token
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
      setError("No gate assigned to your profile. Contact admin.");
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
      setError("No gate assigned to your profile. Contact admin.");
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

  return (
    <div className="max-w-lg mx-auto space-y-6">
      {/* Scanner Area */}
      <div className="text-center">
        <div
          id="qr-reader"
          className={`mx-auto rounded-xl overflow-hidden ${scanning ? "block" : "hidden"}`}
          style={{ width: "100%", maxWidth: 400 }}
        />

        {!scanning && !result && (
          <button
            onClick={startScanner}
            className="bg-primary-600 hover:bg-primary-700 text-white font-bold py-6 px-8 rounded-2xl text-xl flex items-center gap-3 mx-auto"
          >
            <Camera className="w-8 h-8" />
            SCAN PASS
          </button>
        )}

        {scanning && (
          <button
            onClick={stopScanner}
            className="btn-secondary mt-4"
          >
            Cancel Scan
          </button>
        )}
      </div>

      {/* Manual Lookup */}
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
          <button
            onClick={handleManualLookup}
            className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg"
            disabled={loading}
          >
            <Search className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="text-center text-gray-400 animate-pulse">
          Verifying...
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-3 rounded-xl flex items-center gap-2">
          <XCircle className="w-5 h-5 shrink-0" />
          {error}
        </div>
      )}

      {/* Verification Result */}
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
          {/* Status Header */}
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
              <h2 className="text-xl font-bold">
                {result.valid ? "VALID PASS" : "INVALID"}
              </h2>
              <p className="text-sm opacity-75">{result.message}</p>
            </div>
          </div>

          {/* Student info */}
          {result.pass && (
            <div className="space-y-3 text-sm">
              <div className="bg-black/20 rounded-lg p-3">
                <p className="text-lg font-bold">{result.pass.student.name}</p>
                <p className="text-gray-400">
                  {result.pass.student.program} •{" "}
                  {result.pass.student.department}
                </p>
                <p className="text-gray-400 font-mono">
                  {result.pass.student.enrollmentNo}
                </p>
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
                    {new Date(result.pass.expectedReturn).toLocaleTimeString(
                      [],
                      { hour: "2-digit", minute: "2-digit" }
                    )}
                  </p>
                </div>
                <div>
                  <span className="text-gray-400">Pass #</span>
                  <p className="font-medium font-mono">
                    {result.pass.passNumber}
                  </p>
                </div>
              </div>

              {/* Action Buttons */}
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

          {/* Reset */}
          <button
            onClick={() => setResult(null)}
            className="btn-secondary w-full mt-4"
          >
            Scan Another
          </button>
        </div>
      )}
    </div>
  );
}
