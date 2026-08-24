"use client";

import { useEffect, useState, useRef } from "react";
import { api } from "@/lib/api";
import { onMessage } from "@/lib/socket";
import Link from "next/link";
import {
  CheckCircle,
  Clock,
  AlertTriangle,
  MapPin,
  FileText,
  Timer,
} from "lucide-react";

interface DashboardData {
  movementState: string;
  activePass: any;
  student: {
    id: string;
    name: string;
    enrollmentNo: string;
  };
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
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

function formatPeriodType(type: string): string {
  switch (type) {
    case "DAILY":
      return "Daily";
    case "WEEKLY":
      return "Weekly";
    case "MONTHLY":
      return "Monthly";
    case "SEMESTER":
      return "Semester";
    default:
      return type;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

const stateConfig: Record<
  string,
  { label: string; color: string; icon: any; description: string }
> = {
  NO_ACTIVE_REQUEST: {
    label: "Inside Campus",
    color: "bg-gray-100 text-gray-700 border-gray-200",
    icon: CheckCircle,
    description: "You have no active gate pass request.",
  },
  PENDING_APPROVAL: {
    label: "Pending Approval",
    color: "bg-warning-50 text-warning-600 border-warning-500",
    icon: Clock,
    description: "Your gate pass request is awaiting HOD approval.",
  },
  GATE_PASS_APPROVED: {
    label: "Gate Pass Approved",
    color: "bg-success-50 text-success-700 border-success-500",
    icon: CheckCircle,
    description: "Your gate pass is approved. Show QR at the gate.",
  },
  CURRENTLY_OUTSIDE: {
    label: "Currently Outside",
    color: "bg-primary-50 text-primary-700 border-primary-500",
    icon: MapPin,
    description: "You are currently outside campus.",
  },
  OVERDUE: {
    label: "Overdue",
    color: "bg-danger-50 text-danger-700 border-danger-500",
    icon: AlertTriangle,
    description: "You are past your expected return time.",
  },
};

export default function StudentDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [allowance, setAllowance] = useState<AllowanceSummary | null>(null);
  const [elapsedTimer, setElapsedTimer] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchDashboard = async () => {
    try {
      const result = await api.get<DashboardData>("/api/student/dashboard");
      setData(result);
    } catch (err) {
      console.error("Failed to fetch dashboard", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchAllowance = async () => {
    try {
      const result = await api.get<AllowanceSummary>("/api/student/allowance");
      setAllowance(result);
      if (result.currentlyOutsideElapsed !== null) {
        setElapsedTimer(result.currentlyOutsideElapsed);
      } else {
        setElapsedTimer(null);
      }
    } catch (err) {
      console.error("Failed to fetch allowance", err);
    }
  };

  useEffect(() => {
    fetchDashboard();
    fetchAllowance();

    // Listen for real-time notifications to refresh
    const unsubscribe = onMessage("notification", () => {
      fetchDashboard();
      fetchAllowance();
    });
    return unsubscribe;
  }, []);

  // Real-time elapsed timer: increment every 60 seconds when outside
  useEffect(() => {
    if (elapsedTimer !== null) {
      timerRef.current = setInterval(() => {
        setElapsedTimer((prev) => (prev !== null ? prev + 1 : null));
      }, 60000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [elapsedTimer !== null]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-pulse text-gray-500">Loading dashboard...</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center text-danger-600">
        Failed to load dashboard
      </div>
    );
  }

  const state = stateConfig[data.movementState] || stateConfig.NO_ACTIVE_REQUEST;
  const StateIcon = state.icon;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          Hello, {data.student.name.split(" ")[0]}
        </h1>
        <p className="text-gray-500 text-sm">{data.student.enrollmentNo}</p>
      </div>

      {/* Movement State Card */}
      <div className={`card border-2 ${state.color}`}>
        <div className="flex items-center gap-3 mb-2">
          <StateIcon className="w-6 h-6" />
          <h2 className="text-lg font-semibold">{state.label}</h2>
        </div>
        <p className="text-sm opacity-80">{state.description}</p>
      </div>

      {/* Allowance Summary */}
      {allowance && (
        <div
          className={`card ${
            allowance.warningThreshold
              ? "border-2 border-warning-500 bg-warning-50"
              : ""
          }`}
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-500">
              Outside-Time Allowance
            </h3>
            {allowance.warningThreshold && (
              <span className="flex items-center gap-1 text-xs font-medium text-warning-600 bg-warning-100 px-2 py-0.5 rounded-full">
                <AlertTriangle className="w-3 h-3" />
                Low
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 mb-3">
            <div>
              <p className="text-xs text-gray-500">Remaining</p>
              <p
                className={`text-lg font-semibold ${
                  allowance.warningThreshold
                    ? "text-warning-600"
                    : "text-gray-900"
                }`}
              >
                {formatMinutes(allowance.remaining)}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Consumed</p>
              <p className="text-lg font-semibold text-gray-900">
                {formatMinutes(allowance.consumed)}
              </p>
            </div>
          </div>

          {/* Period info */}
          <div className="text-xs text-gray-500 border-t border-gray-100 pt-2">
            <span className="font-medium">{formatPeriodType(allowance.periodType)}</span>
            {" · "}
            {formatDate(allowance.periodStart)} – {formatDate(allowance.periodEnd)}
          </div>

          {/* Real-time elapsed timer */}
          {elapsedTimer !== null && (
            <div className="mt-3 flex items-center gap-2 text-sm text-primary-700 bg-primary-50 px-3 py-2 rounded-lg">
              <Timer className="w-4 h-4 animate-pulse" />
              <span>
                Outside for <span className="font-semibold">{formatMinutes(elapsedTimer)}</span>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Active Pass Info */}
      {data.activePass && (
        <div className="card">
          <h3 className="text-sm font-medium text-gray-500 mb-3">
            Active Pass
          </h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Pass #</span>
              <span className="font-mono font-medium">
                {data.activePass.passNumber}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Reason</span>
              <span>{data.activePass.reason?.label}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Exit Time</span>
              <span>
                {new Date(data.activePass.requestedExit).toLocaleTimeString(
                  [],
                  { hour: "2-digit", minute: "2-digit" }
                )}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Expected Return</span>
              <span>
                {new Date(data.activePass.expectedReturn).toLocaleTimeString(
                  [],
                  { hour: "2-digit", minute: "2-digit" }
                )}
              </span>
            </div>
          </div>

          {(data.movementState === "GATE_PASS_APPROVED" ||
            data.movementState === "CURRENTLY_OUTSIDE") && (
            <Link
              href="/student/pass"
              className="btn-primary w-full mt-4 block text-center"
            >
              View Gate Pass & QR
            </Link>
          )}
        </div>
      )}

      {/* Quick Actions */}
      {data.movementState === "NO_ACTIVE_REQUEST" && (
        <Link
          href="/student/request"
          className="btn-primary w-full block text-center flex items-center justify-center gap-2"
        >
          <FileText className="w-5 h-5" />
          Request Gate Pass
        </Link>
      )}
    </div>
  );
}
