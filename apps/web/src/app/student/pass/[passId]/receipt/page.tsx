"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { Printer, ArrowLeft, CheckCircle } from "lucide-react";
import Link from "next/link";

interface PassSummary {
  passId: string;
  passNumber: string;
  status: string;
  student: {
    name: string;
    enrollmentNo: string;
    department: string;
  };
  reason: { label: string; customReason?: string | null };
  approval: {
    approvedBy: string | null;
    approvedAt: string | null;
    rejectionReason: string | null;
  };
  movement: {
    requestedExit: string;
    expectedReturn: string;
    actualExit: string | null;
    actualReturn: string | null;
    outsideDurationMinutes: number | null;
    overdueMinutes: number | null;
  };
  gates: { type: "EXIT" | "RETURN"; at: string; gate: string }[];
}

function fmt(iso: string | null | undefined, style: "time" | "datetime" = "time") {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], {
    ...(style === "datetime"
      ? { year: "numeric", month: "short", day: "numeric" }
      : {}),
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatMins(mins: number | null | undefined) {
  if (mins == null) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function PassReceiptPage() {
  const params = useParams();
  const passId = params?.passId as string;
  const [summary, setSummary] = useState<PassSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!passId) return;
    api
      .get<PassSummary>(`/api/student/gate-pass/${passId}/summary`)
      .then(setSummary)
      .catch((err: any) => setError(err.message || "Could not load pass"))
      .finally(() => setLoading(false));
  }, [passId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh] animate-pulse text-gray-500">
        Loading receipt...
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div className="max-w-lg mx-auto py-12 text-center">
        <p className="text-danger-600 mb-4">{error || "Pass not found"}</p>
        <Link href="/student/history" className="btn-secondary">
          Back to History
        </Link>
      </div>
    );
  }

  const exitEvent = summary.gates.find((g) => g.type === "EXIT");
  const returnEvent = summary.gates.find((g) => g.type === "RETURN");

  return (
    <div className="max-w-lg mx-auto">
      {/* Action bar — hidden when printing */}
      <div className="flex items-center justify-between mb-4 print:hidden">
        <Link
          href="/student/history"
          className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to History
        </Link>
        <button
          onClick={() => window.print()}
          className="btn-primary flex items-center gap-2"
        >
          <Printer className="w-4 h-4" />
          Print / Save PDF
        </button>
      </div>

      {/* Receipt card */}
      <div
        id="receipt"
        className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm print:shadow-none print:border-0"
      >
        {/* Header */}
        <div className="bg-primary-900 text-white px-6 py-5 text-center">
          <h1 className="text-xl font-bold tracking-wide">CAMPUSGATE</h1>
          <p className="text-primary-200 text-xs mt-1 uppercase tracking-widest">
            Campus Movement Record
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5 text-sm">
          {/* Pass ID + Status */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wide">Pass ID</p>
              <p className="font-mono font-medium text-gray-900">{summary.passNumber}</p>
            </div>
            <span
              className={`text-xs px-2 py-1 rounded-full font-semibold ${
                summary.status === "COMPLETED"
                  ? "bg-success-50 text-success-700"
                  : summary.status === "OUTSIDE"
                  ? "bg-primary-50 text-primary-700"
                  : "bg-gray-100 text-gray-600"
              }`}
            >
              {summary.status}
            </span>
          </div>

          <hr className="border-gray-100" />

          {/* Student info */}
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Student</p>
            <p className="font-semibold text-gray-900 text-base">{summary.student.name}</p>
            <p className="text-gray-500 text-xs mt-0.5">
              {summary.student.enrollmentNo} · {summary.student.department}
            </p>
          </div>

          <hr className="border-gray-100" />

          {/* Reason */}
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Reason</p>
            <p className="font-medium text-gray-900">{summary.reason.label}</p>
            {summary.reason.customReason && (
              <p className="text-gray-500 text-xs mt-0.5 italic">{summary.reason.customReason}</p>
            )}
          </div>

          <hr className="border-gray-100" />

          {/* Approval */}
          {summary.approval.approvedBy && (
            <>
              <div>
                <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Approval</p>
                <div className="flex items-center gap-3">
                  <CheckCircle className="w-4 h-4 text-success-500 shrink-0" />
                  <div>
                    <p className="font-medium text-gray-900">{summary.approval.approvedBy}</p>
                    <p className="text-xs text-gray-500">{fmt(summary.approval.approvedAt, "datetime")}</p>
                  </div>
                </div>
              </div>
              <hr className="border-gray-100" />
            </>
          )}

          {/* Movement */}
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">Movement</p>
            <div className="grid grid-cols-2 gap-y-2 gap-x-4">
              <div>
                <p className="text-xs text-gray-400">Requested Exit</p>
                <p className="font-medium text-gray-900">{fmt(summary.movement.requestedExit)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Expected Return</p>
                <p className="font-medium text-gray-900">{fmt(summary.movement.expectedReturn)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">
                  Actual Exit{exitEvent ? ` · ${exitEvent.gate}` : ""}
                </p>
                <p className="font-medium text-gray-900">{fmt(summary.movement.actualExit)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">
                  Actual Return{returnEvent ? ` · ${returnEvent.gate}` : ""}
                </p>
                <p className="font-medium text-gray-900">{fmt(summary.movement.actualReturn)}</p>
              </div>
            </div>
          </div>

          <hr className="border-gray-100" />

          {/* Duration row */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-400">Actual Outside Duration</p>
              <p className="font-semibold text-gray-900 text-base">
                {formatMins(summary.movement.outsideDurationMinutes)}
              </p>
            </div>
            {summary.movement.overdueMinutes != null &&
              summary.movement.overdueMinutes > 0 && (
                <div className="text-right">
                  <p className="text-xs text-gray-400">Overdue By</p>
                  <p className="font-semibold text-danger-600">
                    {formatMins(summary.movement.overdueMinutes)}
                  </p>
                </div>
              )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-gray-50 border-t border-gray-100 text-center">
          <p className="text-xs text-gray-400">
            Generated by CAMPUSGATE · {new Date().toLocaleDateString()}
          </p>
        </div>
      </div>

      {/* Print styles */}
      <style jsx global>{`
        @media print {
          nav,
          header,
          .print\\:hidden {
            display: none !important;
          }
          body {
            background: white;
          }
          #receipt {
            border: none;
            box-shadow: none;
          }
        }
      `}</style>
    </div>
  );
}
