"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface ReliabilityScore {
  overall: number;
  components: {
    timelyReturnRate: number;
    completionRate: number;
    authorizationComplianceRate: number;
  };
  totalMovements: number;
  hasSufficientData: boolean;
  trend: {
    snapshots: Array<{ score: number; date: string; movementNumber: number }>;
    improvementIndicator: boolean;
  } | null;
  message?: string;
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const percentage = Math.round(value * 100);
  const barColor =
    percentage >= 80
      ? "bg-green-500"
      : percentage >= 60
        ? "bg-yellow-500"
        : "bg-red-500";

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-gray-600">{label}</span>
        <span className="font-medium text-gray-900">{percentage}%</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

function TrendSparkline({
  snapshots,
  improvementIndicator,
}: {
  snapshots: Array<{ score: number; date: string; movementNumber: number }>;
  improvementIndicator: boolean;
}) {
  if (snapshots.length < 2) return null;

  const maxScore = 5.0;
  const width = 240;
  const height = 48;
  const padding = 4;

  const points = snapshots.map((s, i) => {
    const x = padding + (i / (snapshots.length - 1)) * (width - padding * 2);
    const y = height - padding - (s.score / maxScore) * (height - padding * 2);
    return { x, y };
  });

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-600">
          Score Trend (last {snapshots.length} movements)
        </span>
        {improvementIndicator && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2}>
              <path d="M2 8l4-4 4 4" />
            </svg>
            Improving
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-12 rounded bg-gray-50"
        aria-label="Reliability score trend chart"
      >
        <path d={pathD} fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {/* Start and end dots */}
        <circle cx={points[0].x} cy={points[0].y} r="2.5" fill="#6366f1" />
        <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r="2.5" fill="#6366f1" />
      </svg>
      <div className="flex justify-between text-xs text-gray-400">
        <span>Movement #{snapshots[0].movementNumber}</span>
        <span>Movement #{snapshots[snapshots.length - 1].movementNumber}</span>
      </div>
    </div>
  );
}

function OverallScoreBadge({ score }: { score: number }) {
  const color =
    score >= 4.0
      ? "text-green-700 bg-green-50 border-green-200"
      : score >= 3.0
        ? "text-yellow-700 bg-yellow-50 border-yellow-200"
        : "text-red-700 bg-red-50 border-red-200";

  return (
    <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg border ${color}`}>
      <span className="text-2xl font-bold">{score.toFixed(1)}</span>
      <span className="text-sm font-medium">/ 5.0</span>
    </div>
  );
}

export default function StudentProfile() {
  const [profile, setProfile] = useState<any>(null);
  const [reliability, setReliability] = useState<ReliabilityScore | null>(null);
  const [loading, setLoading] = useState(true);
  const [reliabilityLoading, setReliabilityLoading] = useState(true);

  useEffect(() => {
    api
      .get("/api/auth/me")
      .then(setProfile)
      .catch(console.error)
      .finally(() => setLoading(false));

    api
      .get<ReliabilityScore>("/api/student/reliability")
      .then(setReliability)
      .catch(console.error)
      .finally(() => setReliabilityLoading(false));
  }, []);

  if (loading) {
    return <div className="animate-pulse text-gray-500 text-center py-12">Loading...</div>;
  }

  if (!profile) return null;

  const student = profile.profile;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">My Profile</h1>

      <div className="card space-y-4">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-16 h-16 rounded-full bg-primary-100 flex items-center justify-center">
            <span className="text-2xl font-bold text-primary-700">
              {student?.name?.[0] || "S"}
            </span>
          </div>
          <div>
            <h2 className="text-xl font-bold text-gray-900">{student?.name}</h2>
            <p className="text-sm text-gray-500">{profile.email}</p>
          </div>
        </div>

        <div className="divide-y divide-gray-100">
          {[
            { label: "Enrollment Number", value: student?.enrollmentNo },
            { label: "Program", value: student?.program },
            { label: "Department", value: student?.department?.name },
            { label: "Semester", value: student?.semester },
            { label: "Section", value: student?.section || "—" },
            { label: "Account Status", value: profile.accountStatus },
            { label: "Institution", value: profile.institution?.name },
          ].map((item) => (
            <div key={item.label} className="flex justify-between py-3">
              <span className="text-sm text-gray-500">{item.label}</span>
              <span className="text-sm font-medium text-gray-900">{item.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Reliability Score Section */}
      <div className="card space-y-4">
        <h3 className="text-lg font-semibold text-gray-900">GatePass Reliability Score</h3>

        {reliabilityLoading ? (
          <div className="animate-pulse text-gray-400 text-sm py-4">Loading score...</div>
        ) : reliability && reliability.hasSufficientData ? (
          <div className="space-y-5">
            {/* Overall Score */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Overall Score</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  Based on {reliability.totalMovements} movements
                </p>
              </div>
              <OverallScoreBadge score={reliability.overall} />
            </div>

            {/* Component Scores */}
            <div className="space-y-3 pt-2 border-t border-gray-100">
              <p className="text-sm font-medium text-gray-700">Component Breakdown</p>
              <ScoreBar label="Timely Return" value={reliability.components.timelyReturnRate} />
              <ScoreBar label="Completion" value={reliability.components.completionRate} />
              <ScoreBar label="Authorization Compliance" value={reliability.components.authorizationComplianceRate} />
            </div>

            {/* Trend */}
            {reliability.trend && reliability.trend.snapshots.length >= 2 && (
              <div className="pt-2 border-t border-gray-100">
                <TrendSparkline
                  snapshots={reliability.trend.snapshots}
                  improvementIndicator={reliability.trend.improvementIndicator}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="py-4 text-center">
            <p className="text-sm text-gray-500">
              {reliability?.message || "Insufficient data to display a reliability score. Complete more gate pass movements to see your score."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
