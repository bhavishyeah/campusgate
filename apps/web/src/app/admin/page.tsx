"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Users, Shield, DoorOpen, Activity, Settings } from "lucide-react";

interface PolicyConfig {
  allowanceAmount: number;
  policyPeriod: string;
  gracePeriod: number;
  enforcement: string;
  minimumSampleSize: number;
  severityMinorMax: number;
  severityModerateMax: number;
  severitySignificantMax: number;
}

const POLICY_PERIODS = [
  { value: "DAILY", label: "Daily" },
  { value: "WEEKLY", label: "Weekly" },
  { value: "MONTHLY", label: "Monthly" },
  { value: "SEMESTER", label: "Semester" },
];

const ENFORCEMENT_MODES = [
  { value: "BLOCK_NEW_REQUESTS", label: "Block New Requests" },
  { value: "WARN_ONLY", label: "Warn Only" },
];

const DEFAULT_POLICY: PolicyConfig = {
  allowanceAmount: 1440,
  policyPeriod: "WEEKLY",
  gracePeriod: 10,
  enforcement: "WARN_ONLY",
  minimumSampleSize: 5,
  severityMinorMax: 15,
  severityModerateMax: 60,
  severitySignificantMax: 180,
};

interface ValidationErrors {
  allowanceAmount?: string;
  gracePeriod?: string;
  minimumSampleSize?: string;
  severityMinorMax?: string;
  severityModerateMax?: string;
  severitySignificantMax?: string;
}

function validatePolicy(policy: PolicyConfig): ValidationErrors {
  const errors: ValidationErrors = {};

  if (policy.allowanceAmount < 60 || policy.allowanceAmount > 10080) {
    errors.allowanceAmount = "Must be between 60 and 10080 minutes";
  }
  if (policy.gracePeriod < 0 || policy.gracePeriod > 60) {
    errors.gracePeriod = "Must be between 0 and 60 minutes";
  }
  if (policy.minimumSampleSize < 3 || policy.minimumSampleSize > 20) {
    errors.minimumSampleSize = "Must be between 3 and 20";
  }
  if (policy.severityMinorMax < 1) {
    errors.severityMinorMax = "Must be at least 1 minute";
  }
  if (policy.severityModerateMax <= policy.severityMinorMax) {
    errors.severityModerateMax = "Must be greater than minor max";
  }
  if (policy.severitySignificantMax <= policy.severityModerateMax) {
    errors.severitySignificantMax = "Must be greater than moderate max";
  }

  return errors;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Policy config state
  const [policy, setPolicy] = useState<PolicyConfig>(DEFAULT_POLICY);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [policySaving, setPolicySaving] = useState(false);
  const [policyMessage, setPolicyMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});

  useEffect(() => {
    api
      .get("/api/admin/stats")
      .then(setStats)
      .catch(console.error)
      .finally(() => setLoading(false));

    api
      .get<PolicyConfig>("/api/admin/allowance-policy")
      .then((data) => {
        setPolicy({
          allowanceAmount: data.allowanceAmount ?? DEFAULT_POLICY.allowanceAmount,
          policyPeriod: data.policyPeriod ?? DEFAULT_POLICY.policyPeriod,
          gracePeriod: data.gracePeriod ?? DEFAULT_POLICY.gracePeriod,
          enforcement: data.enforcement ?? DEFAULT_POLICY.enforcement,
          minimumSampleSize: data.minimumSampleSize ?? DEFAULT_POLICY.minimumSampleSize,
          severityMinorMax: data.severityMinorMax ?? DEFAULT_POLICY.severityMinorMax,
          severityModerateMax: data.severityModerateMax ?? DEFAULT_POLICY.severityModerateMax,
          severitySignificantMax: data.severitySignificantMax ?? DEFAULT_POLICY.severitySignificantMax,
        });
      })
      .catch(console.error)
      .finally(() => setPolicyLoading(false));
  }, []);

  const handlePolicyChange = (field: keyof PolicyConfig, value: string | number) => {
    setPolicy((prev) => ({ ...prev, [field]: value }));
    setPolicyMessage(null);
    setValidationErrors({});
  };

  const handlePolicySave = async () => {
    const errors = validatePolicy(policy);
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      return;
    }

    setPolicySaving(true);
    setPolicyMessage(null);

    try {
      const updated = await api.put<PolicyConfig>("/api/admin/allowance-policy", policy);
      setPolicy({
        allowanceAmount: updated.allowanceAmount,
        policyPeriod: updated.policyPeriod,
        gracePeriod: updated.gracePeriod,
        enforcement: updated.enforcement,
        minimumSampleSize: updated.minimumSampleSize,
        severityMinorMax: updated.severityMinorMax,
        severityModerateMax: updated.severityModerateMax,
        severitySignificantMax: updated.severitySignificantMax,
      });
      setPolicyMessage({ type: "success", text: "Policy saved successfully" });
    } catch (err: any) {
      setPolicyMessage({ type: "error", text: err.message || "Failed to save policy" });
    } finally {
      setPolicySaving(false);
    }
  };

  if (loading) {
    return <div className="animate-pulse text-gray-500 text-center py-12">Loading...</div>;
  }

  const cards = [
    { label: "Total Students", value: stats?.totalStudents, icon: Users, color: "text-primary-600" },
    { label: "Total HODs", value: stats?.totalHods, icon: Shield, color: "text-purple-600" },
    { label: "Total Guards", value: stats?.totalGuards, icon: Shield, color: "text-green-600" },
    { label: "Active Gates", value: stats?.totalGates, icon: DoorOpen, color: "text-orange-600" },
    { label: "Exits Today", value: stats?.todayExits, icon: Activity, color: "text-green-600" },
    { label: "Returns Today", value: stats?.todayReturns, icon: Activity, color: "text-blue-600" },
    { label: "Currently Outside", value: stats?.currentlyOutside, icon: Users, color: "text-warning-600" },
    { label: "Pending Approvals", value: stats?.pendingApprovals, icon: Activity, color: "text-warning-600" },
    { label: "Pending Registrations", value: stats?.pendingRegistrations, icon: Users, color: "text-danger-600" },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Admin Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {cards.map((card) => (
          <div key={card.label} className="card flex items-center gap-4">
            <div className={`${card.color}`}>
              <card.icon className="w-8 h-8" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{card.value ?? 0}</p>
              <p className="text-sm text-gray-500">{card.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Allowance Policy Configuration */}
      <div className="mt-10">
        <div className="flex items-center gap-2 mb-4">
          <Settings className="w-5 h-5 text-gray-700" />
          <h2 className="text-xl font-bold text-gray-900">Allowance Policy Configuration</h2>
        </div>

        {policyLoading ? (
          <div className="card animate-pulse text-gray-500 text-center py-8">Loading policy...</div>
        ) : (
          <div className="card space-y-6">
            {/* Time Allowance Section */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
                Time Allowance
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="allowanceAmount" className="label">
                    Allowance Amount (minutes)
                  </label>
                  <input
                    id="allowanceAmount"
                    type="number"
                    className="input"
                    min={60}
                    max={10080}
                    value={policy.allowanceAmount}
                    onChange={(e) => handlePolicyChange("allowanceAmount", parseInt(e.target.value) || 0)}
                  />
                  <p className="text-xs text-gray-500 mt-1">Range: 60–10080 min (1 hour to 1 week)</p>
                  {validationErrors.allowanceAmount && (
                    <p className="text-xs text-danger-600 mt-1">{validationErrors.allowanceAmount}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="policyPeriod" className="label">
                    Policy Period
                  </label>
                  <select
                    id="policyPeriod"
                    className="input"
                    value={policy.policyPeriod}
                    onChange={(e) => handlePolicyChange("policyPeriod", e.target.value)}
                  >
                    {POLICY_PERIODS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="gracePeriod" className="label">
                    Grace Period (minutes)
                  </label>
                  <input
                    id="gracePeriod"
                    type="number"
                    className="input"
                    min={0}
                    max={60}
                    value={policy.gracePeriod}
                    onChange={(e) => handlePolicyChange("gracePeriod", parseInt(e.target.value) || 0)}
                  />
                  <p className="text-xs text-gray-500 mt-1">Range: 0–60 min</p>
                  {validationErrors.gracePeriod && (
                    <p className="text-xs text-danger-600 mt-1">{validationErrors.gracePeriod}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="enforcement" className="label">
                    Enforcement Mode
                  </label>
                  <select
                    id="enforcement"
                    className="input"
                    value={policy.enforcement}
                    onChange={(e) => handlePolicyChange("enforcement", e.target.value)}
                  >
                    {ENFORCEMENT_MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Reliability Settings Section */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
                Reliability Settings
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="minimumSampleSize" className="label">
                    Minimum Sample Size
                  </label>
                  <input
                    id="minimumSampleSize"
                    type="number"
                    className="input"
                    min={3}
                    max={20}
                    value={policy.minimumSampleSize}
                    onChange={(e) => handlePolicyChange("minimumSampleSize", parseInt(e.target.value) || 0)}
                  />
                  <p className="text-xs text-gray-500 mt-1">Movements required before score is shown (3–20)</p>
                  {validationErrors.minimumSampleSize && (
                    <p className="text-xs text-danger-600 mt-1">{validationErrors.minimumSampleSize}</p>
                  )}
                </div>
              </div>
            </div>

            {/* Severity Thresholds Section */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
                Late Return Severity Thresholds (minutes past grace)
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label htmlFor="severityMinorMax" className="label">
                    Minor Max
                  </label>
                  <input
                    id="severityMinorMax"
                    type="number"
                    className="input"
                    min={1}
                    value={policy.severityMinorMax}
                    onChange={(e) => handlePolicyChange("severityMinorMax", parseInt(e.target.value) || 0)}
                  />
                  <p className="text-xs text-gray-500 mt-1">1 to this value = minor</p>
                  {validationErrors.severityMinorMax && (
                    <p className="text-xs text-danger-600 mt-1">{validationErrors.severityMinorMax}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="severityModerateMax" className="label">
                    Moderate Max
                  </label>
                  <input
                    id="severityModerateMax"
                    type="number"
                    className="input"
                    min={2}
                    value={policy.severityModerateMax}
                    onChange={(e) => handlePolicyChange("severityModerateMax", parseInt(e.target.value) || 0)}
                  />
                  <p className="text-xs text-gray-500 mt-1">{policy.severityMinorMax + 1} to this value = moderate</p>
                  {validationErrors.severityModerateMax && (
                    <p className="text-xs text-danger-600 mt-1">{validationErrors.severityModerateMax}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="severitySignificantMax" className="label">
                    Significant Max
                  </label>
                  <input
                    id="severitySignificantMax"
                    type="number"
                    className="input"
                    min={3}
                    value={policy.severitySignificantMax}
                    onChange={(e) => handlePolicyChange("severitySignificantMax", parseInt(e.target.value) || 0)}
                  />
                  <p className="text-xs text-gray-500 mt-1">{policy.severityModerateMax + 1} to this value = significant, above = severe</p>
                  {validationErrors.severitySignificantMax && (
                    <p className="text-xs text-danger-600 mt-1">{validationErrors.severitySignificantMax}</p>
                  )}
                </div>
              </div>
            </div>

            {/* Save status messages */}
            {policyMessage && (
              <div
                className={`px-4 py-3 rounded-lg text-sm ${
                  policyMessage.type === "success"
                    ? "bg-green-50 text-green-700"
                    : "bg-danger-50 text-danger-700"
                }`}
              >
                {policyMessage.text}
              </div>
            )}

            {/* Save button */}
            <div className="flex justify-end">
              <button
                className="btn-primary"
                onClick={handlePolicySave}
                disabled={policySaving}
              >
                {policySaving ? "Saving..." : "Save Policy"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
