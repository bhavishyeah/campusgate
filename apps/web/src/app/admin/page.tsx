"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { Users, Shield, DoorOpen, Activity, Settings, Download, CalendarDays, Building2 } from "lucide-react";

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

interface InstitutionConfig {
  timezone: string;
  weekStartDay: string;
  workingDaysOfWeek: number[];
  lowAllowanceThresholdMinutes: number;
}

interface AcademicCalendarDay {
  id: string;
  date: string;
  dayType: string;
  note?: string | null;
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

const WEEK_START_DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

const DAY_TYPES = [
  "WORKING_DAY",
  "HOLIDAY",
  "WEEKEND",
  "EXAM_DAY",
  "VACATION",
  "SPECIAL_WORKING_DAY",
  "INSTITUTION_EVENT",
];

const WEEKDAY_OPTIONS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
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

const DEFAULT_CONFIG: InstitutionConfig = {
  timezone: "Asia/Kolkata",
  weekStartDay: "MONDAY",
  workingDaysOfWeek: [1, 2, 3, 4, 5, 6],
  lowAllowanceThresholdMinutes: 60,
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

  const [policy, setPolicy] = useState<PolicyConfig>(DEFAULT_POLICY);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [policySaving, setPolicySaving] = useState(false);
  const [policyMessage, setPolicyMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});

  const [institutionConfig, setInstitutionConfig] = useState<InstitutionConfig>(DEFAULT_CONFIG);
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);

  const [calendarDays, setCalendarDays] = useState<AcademicCalendarDay[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [calendarSaving, setCalendarSaving] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [calendarForm, setCalendarForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    dayType: "HOLIDAY",
    note: "",
  });

  const [downloadingStudentsCsv, setDownloadingStudentsCsv] = useState(false);
  const [downloadingStudentsXlsx, setDownloadingStudentsXlsx] = useState(false);
  const token = useAuthStore((s) => s.token);

  const loadCalendar = async (monthValue: string) => {
    const [yearStr, monthStr] = monthValue.split("-");
    const year = Number(yearStr);
    const month = Number(monthStr);

    const startDate = new Date(year, month - 1, 1, 0, 0, 0, 0).toISOString();
    const endDate = new Date(year, month, 0, 23, 59, 59, 999).toISOString();

    const days = await api.get<AcademicCalendarDay[]>(
      `/api/admin/academic-calendar?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
    );
    setCalendarDays(days);
  };

  useEffect(() => {
    (async () => {
      try {
        const [statsData, policyData, configData] = await Promise.all([
          api.get<any>("/api/admin/stats"),
          api.get<PolicyConfig>("/api/admin/allowance-policy"),
          api.get<InstitutionConfig>("/api/admin/institution-config"),
        ]);

        setStats(statsData);
        setPolicy({
          allowanceAmount: policyData.allowanceAmount ?? DEFAULT_POLICY.allowanceAmount,
          policyPeriod: policyData.policyPeriod ?? DEFAULT_POLICY.policyPeriod,
          gracePeriod: policyData.gracePeriod ?? DEFAULT_POLICY.gracePeriod,
          enforcement: policyData.enforcement ?? DEFAULT_POLICY.enforcement,
          minimumSampleSize: policyData.minimumSampleSize ?? DEFAULT_POLICY.minimumSampleSize,
          severityMinorMax: policyData.severityMinorMax ?? DEFAULT_POLICY.severityMinorMax,
          severityModerateMax: policyData.severityModerateMax ?? DEFAULT_POLICY.severityModerateMax,
          severitySignificantMax: policyData.severitySignificantMax ?? DEFAULT_POLICY.severitySignificantMax,
        });
        setInstitutionConfig({
          timezone: configData.timezone ?? DEFAULT_CONFIG.timezone,
          weekStartDay: configData.weekStartDay ?? DEFAULT_CONFIG.weekStartDay,
          workingDaysOfWeek:
            Array.isArray(configData.workingDaysOfWeek) && configData.workingDaysOfWeek.length > 0
              ? configData.workingDaysOfWeek
              : DEFAULT_CONFIG.workingDaysOfWeek,
          lowAllowanceThresholdMinutes:
            configData.lowAllowanceThresholdMinutes ?? DEFAULT_CONFIG.lowAllowanceThresholdMinutes,
        });

        await loadCalendar(calendarMonth);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
        setPolicyLoading(false);
        setConfigLoading(false);
        setCalendarLoading(false);
      }
    })();
  }, []);

  const shiftCalendarMonth = async (delta: number) => {
    const [yearStr, monthStr] = calendarMonth.split("-");
    const year = Number(yearStr);
    const month = Number(monthStr);
    const date = new Date(year, month - 1 + delta, 1);
    const next = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

    setCalendarMonth(next);
    setCalendarLoading(true);
    try {
      await loadCalendar(next);
    } finally {
      setCalendarLoading(false);
    }
  };

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

  const toggleWorkingDay = (day: number) => {
    setInstitutionConfig((prev) => {
      const has = prev.workingDaysOfWeek.includes(day);
      const next = has
        ? prev.workingDaysOfWeek.filter((d) => d !== day)
        : [...prev.workingDaysOfWeek, day];
      return { ...prev, workingDaysOfWeek: next.sort((a, b) => a - b) };
    });
  };

  const saveInstitutionConfig = async () => {
    if (institutionConfig.workingDaysOfWeek.length === 0) {
      setPolicyMessage({ type: "error", text: "Select at least one working weekday" });
      return;
    }

    setConfigSaving(true);
    try {
      await api.put("/api/admin/institution-config", institutionConfig);
      setPolicyMessage({ type: "success", text: "Institution configuration saved" });
    } catch (err: any) {
      setPolicyMessage({ type: "error", text: err.message || "Failed to save institution config" });
    } finally {
      setConfigSaving(false);
    }
  };

  const upsertCalendarDay = async () => {
    setCalendarSaving(true);
    try {
      await api.put("/api/admin/academic-calendar/day", {
        date: calendarForm.date,
        dayType: calendarForm.dayType,
        note: calendarForm.note || undefined,
      });
      await loadCalendar(calendarMonth);
      setPolicyMessage({ type: "success", text: "Academic calendar day saved" });
    } catch (err: any) {
      setPolicyMessage({ type: "error", text: err.message || "Failed to save calendar day" });
    } finally {
      setCalendarSaving(false);
    }
  };

  const deleteCalendarDay = async (date: string) => {
    try {
      const dateOnly = new Date(date).toISOString().slice(0, 10);
      await api.delete(`/api/admin/academic-calendar/day/${dateOnly}`);
      await loadCalendar(calendarMonth);
      setPolicyMessage({ type: "success", text: "Calendar day deleted" });
    } catch (err: any) {
      setPolicyMessage({ type: "error", text: err.message || "Failed to delete calendar day" });
    }
  };

  const downloadStudents = async (format: "csv" | "xlsx") => {
    if (!token) return;

    if (format === "csv") setDownloadingStudentsCsv(true);
    else setDownloadingStudentsXlsx(true);

    setPolicyMessage(null);

    try {
      const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
      const endpoint = format === "xlsx" ? "/api/admin/students/export.xlsx" : "/api/admin/students/export";

      const response = await fetch(`${apiBase}${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to export students");
      }

      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const match = disposition.match(/filename="?([^\"]+)"?/i);
      const fallback = format === "xlsx" ? "students.xlsx" : "students.csv";
      const filename = match?.[1] || fallback;

      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);

      setPolicyMessage({
        type: "success",
        text: format === "xlsx" ? "Student .xlsx export downloaded successfully" : "Student CSV export downloaded successfully",
      });
    } catch (err: any) {
      setPolicyMessage({ type: "error", text: err.message || "Failed to export students" });
    } finally {
      if (format === "csv") setDownloadingStudentsCsv(false);
      else setDownloadingStudentsXlsx(false);
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

      <div className="mt-10">
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-gray-700" />
            <h2 className="text-xl font-bold text-gray-900">Policy & Institution Settings</h2>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button className="btn-secondary flex items-center gap-2" onClick={() => downloadStudents("xlsx")} disabled={downloadingStudentsXlsx || downloadingStudentsCsv}>
              <Download className="w-4 h-4" />
              {downloadingStudentsXlsx ? "Preparing..." : "Download .xlsx"}
            </button>
            <button className="btn-secondary flex items-center gap-2" onClick={() => downloadStudents("csv")} disabled={downloadingStudentsXlsx || downloadingStudentsCsv}>
              <Download className="w-4 h-4" />
              {downloadingStudentsCsv ? "Preparing..." : "Download CSV"}
            </button>
          </div>
        </div>

        {policyLoading ? (
          <div className="card animate-pulse text-gray-500 text-center py-8">Loading policy...</div>
        ) : (
          <div className="card space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Outside-Time Policy</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="allowanceAmount" className="label">Allowance Amount (minutes)</label>
                  <input id="allowanceAmount" type="number" className="input" min={60} max={10080} value={policy.allowanceAmount} onChange={(e) => handlePolicyChange("allowanceAmount", parseInt(e.target.value) || 0)} />
                  {validationErrors.allowanceAmount && <p className="text-xs text-danger-600 mt-1">{validationErrors.allowanceAmount}</p>}
                </div>
                <div>
                  <label htmlFor="policyPeriod" className="label">Policy Period</label>
                  <select id="policyPeriod" className="input" value={policy.policyPeriod} onChange={(e) => handlePolicyChange("policyPeriod", e.target.value)}>
                    {POLICY_PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="gracePeriod" className="label">Grace Period (minutes)</label>
                  <input id="gracePeriod" type="number" className="input" min={0} max={60} value={policy.gracePeriod} onChange={(e) => handlePolicyChange("gracePeriod", parseInt(e.target.value) || 0)} />
                  {validationErrors.gracePeriod && <p className="text-xs text-danger-600 mt-1">{validationErrors.gracePeriod}</p>}
                </div>
                <div>
                  <label htmlFor="enforcement" className="label">Enforcement Mode</label>
                  <select id="enforcement" className="input" value={policy.enforcement} onChange={(e) => handlePolicyChange("enforcement", e.target.value)}>
                    {ENFORCEMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Reliability Thresholds</h3>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label htmlFor="minimumSampleSize" className="label">Min Sample Size</label>
                  <input id="minimumSampleSize" type="number" className="input" min={3} max={20} value={policy.minimumSampleSize} onChange={(e) => handlePolicyChange("minimumSampleSize", parseInt(e.target.value) || 0)} />
                </div>
                <div>
                  <label htmlFor="severityMinorMax" className="label">Minor Max</label>
                  <input id="severityMinorMax" type="number" className="input" min={1} value={policy.severityMinorMax} onChange={(e) => handlePolicyChange("severityMinorMax", parseInt(e.target.value) || 0)} />
                </div>
                <div>
                  <label htmlFor="severityModerateMax" className="label">Moderate Max</label>
                  <input id="severityModerateMax" type="number" className="input" min={2} value={policy.severityModerateMax} onChange={(e) => handlePolicyChange("severityModerateMax", parseInt(e.target.value) || 0)} />
                </div>
                <div>
                  <label htmlFor="severitySignificantMax" className="label">Significant Max</label>
                  <input id="severitySignificantMax" type="number" className="input" min={3} value={policy.severitySignificantMax} onChange={(e) => handlePolicyChange("severitySignificantMax", parseInt(e.target.value) || 0)} />
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <button className="btn-primary" onClick={handlePolicySave} disabled={policySaving}>
                {policySaving ? "Saving..." : "Save Policy"}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mt-8 card">
        <div className="flex items-center gap-2 mb-4">
          <Building2 className="w-5 h-5 text-gray-700" />
          <h2 className="text-lg font-bold">Institution Configuration</h2>
        </div>

        {configLoading ? (
          <div className="animate-pulse text-gray-500 py-6">Loading institution config...</div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="label">Timezone</label>
                <input className="input" value={institutionConfig.timezone} onChange={(e) => setInstitutionConfig((prev) => ({ ...prev, timezone: e.target.value }))} />
              </div>
              <div>
                <label className="label">Week Start Day</label>
                <select className="input" value={institutionConfig.weekStartDay} onChange={(e) => setInstitutionConfig((prev) => ({ ...prev, weekStartDay: e.target.value }))}>
                  {WEEK_START_DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Low Allowance Threshold (minutes)</label>
                <input className="input" type="number" min={0} max={10080} value={institutionConfig.lowAllowanceThresholdMinutes} onChange={(e) => setInstitutionConfig((prev) => ({ ...prev, lowAllowanceThresholdMinutes: parseInt(e.target.value) || 0 }))} />
              </div>
            </div>

            <div>
              <p className="label mb-2">Working Days of Week</p>
              <div className="flex flex-wrap gap-3">
                {WEEKDAY_OPTIONS.map((w) => (
                  <label key={w.value} className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={institutionConfig.workingDaysOfWeek.includes(w.value)}
                      onChange={() => toggleWorkingDay(w.value)}
                    />
                    {w.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="flex justify-end">
              <button className="btn-primary" onClick={saveInstitutionConfig} disabled={configSaving}>
                {configSaving ? "Saving..." : "Save Institution Config"}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mt-8 card">
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <div className="flex items-center gap-2">
            <CalendarDays className="w-5 h-5 text-gray-700" />
            <h2 className="text-lg font-bold">Academic Calendar</h2>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-secondary" onClick={() => shiftCalendarMonth(-1)}>
              Prev
            </button>
            <input
              type="month"
              className="input"
              value={calendarMonth}
              onChange={async (e) => {
                const next = e.target.value;
                setCalendarMonth(next);
                setCalendarLoading(true);
                try {
                  await loadCalendar(next);
                } finally {
                  setCalendarLoading(false);
                }
              }}
            />
            <button className="btn-secondary" onClick={() => shiftCalendarMonth(1)}>
              Next
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
          <div>
            <label className="label">Date</label>
            <input type="date" className="input" value={calendarForm.date} onChange={(e) => setCalendarForm((prev) => ({ ...prev, date: e.target.value }))} />
          </div>
          <div>
            <label className="label">Day Type</label>
            <select className="input" value={calendarForm.dayType} onChange={(e) => setCalendarForm((prev) => ({ ...prev, dayType: e.target.value }))}>
              {DAY_TYPES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="label">Note (optional)</label>
            <input className="input" value={calendarForm.note} onChange={(e) => setCalendarForm((prev) => ({ ...prev, note: e.target.value }))} />
          </div>
        </div>

        <div className="flex justify-end mb-4">
          <button className="btn-primary" onClick={upsertCalendarDay} disabled={calendarSaving}>
            {calendarSaving ? "Saving..." : "Save Calendar Day"}
          </button>
        </div>

        {calendarLoading ? (
          <div className="animate-pulse text-gray-500 py-4">Loading calendar...</div>
        ) : calendarDays.length === 0 ? (
          <p className="text-sm text-gray-500">No calendar overrides saved for selected month.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2">Date</th>
                  <th className="py-2">Type</th>
                  <th className="py-2">Note</th>
                  <th className="py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {calendarDays.map((d) => (
                  <tr key={d.id} className="border-b">
                    <td className="py-2">{new Date(d.date).toLocaleDateString()}</td>
                    <td className="py-2">{d.dayType}</td>
                    <td className="py-2">{d.note || "-"}</td>
                    <td className="py-2">
                      <button className="btn-secondary" onClick={() => deleteCalendarDay(d.date)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {policyMessage && (
        <div className={`mt-6 px-4 py-3 rounded-lg text-sm ${policyMessage.type === "success" ? "bg-green-50 text-green-700" : "bg-danger-50 text-danger-700"}`}>
          {policyMessage.text}
        </div>
      )}
    </div>
  );
}
