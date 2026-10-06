"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { CalendarClock, Clock3, Plus } from "lucide-react";

type Gate = { id: string; name: string; location: string | null };
type GuardOption = { id: string; name: string; email: string };

type ShiftRow = {
  id: string;
  status: "SCHEDULED" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  scheduledStartAt: string;
  scheduledEndAt: string;
  actualStartAt: string | null;
  actualEndAt: string | null;
  note: string | null;
  guard: { id: string; name: string };
  gate: { id: string; name: string; location: string | null };
};

const statusStyles: Record<ShiftRow["status"], string> = {
  SCHEDULED: "bg-primary-50 text-primary-700",
  ACTIVE: "bg-success-50 text-success-700",
  COMPLETED: "bg-gray-100 text-gray-700",
  CANCELLED: "bg-danger-50 text-danger-700",
};

function toLocalInputValue(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${y}-${m}-${d}T${h}:${min}`;
}

export default function AdminGuardShiftsPage() {
  const [guards, setGuards] = useState<GuardOption[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [guardId, setGuardId] = useState("");
  const [gateId, setGateId] = useState("");
  const [startAt, setStartAt] = useState(() => toLocalInputValue(new Date()));
  const [endAt, setEndAt] = useState(() => toLocalInputValue(new Date(Date.now() + 4 * 60 * 60 * 1000)));
  const [note, setNote] = useState("");

  const selectedGuard = useMemo(() => guards.find((g) => g.id === guardId) ?? null, [guards, guardId]);
  const selectedGate = useMemo(() => gates.find((g) => g.id === gateId) ?? null, [gates, gateId]);

  const load = async () => {
    try {
      setError("");
      const [usersRes, gatesRes, shiftsRes] = await Promise.all([
        api.get<{ users: any[] }>("/api/admin/users?role=GUARD&limit=100"),
        api.get<any[]>("/api/admin/gates"),
        api.get<ShiftRow[]>("/api/admin/guard-shifts"),
      ]);

      const guardRows: GuardOption[] = usersRes.users
        .map((u) => {
          const profile = u.guardProfile;
          if (!profile) return null;
          return { id: profile.id as string, name: profile.name as string, email: u.email as string };
        })
        .filter(Boolean) as GuardOption[];

      setGuards(guardRows);
      setGates(gatesRes.map((g) => ({ id: g.id, name: g.name, location: g.location })));
      setShifts(shiftsRes);

      if (!guardId && guardRows[0]) setGuardId(guardRows[0].id);
      if (!gateId && gatesRes[0]) setGateId(gatesRes[0].id);
    } catch (err: any) {
      setError(err.message || "Failed to load shift data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const createShift = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!guardId || !gateId) {
      setError("Guard and gate are required");
      return;
    }

    const startIso = new Date(startAt).toISOString();
    const endIso = new Date(endAt).toISOString();
    if (new Date(endIso) <= new Date(startIso)) {
      setError("End time must be after start time");
      return;
    }

    setSaving(true);
    try {
      await api.post("/api/admin/guard-shifts", {
        guardId,
        gateId,
        scheduledStartAt: startIso,
        scheduledEndAt: endIso,
        note: note || undefined,
      });

      setNote("");
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to create shift");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Guard Shifts</h1>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card lg:col-span-1">
          <h2 className="text-sm font-medium text-gray-500 mb-4">Create Shift</h2>

          <form onSubmit={createShift} className="space-y-4">
            <div>
              <label className="label">Guard</label>
              <select className="input" value={guardId} onChange={(e) => setGuardId(e.target.value)} required>
                {guards.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.email})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Gate</label>
              <select className="input" value={gateId} onChange={(e) => setGateId(e.target.value)} required>
                {gates.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} {g.location ? `• ${g.location}` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Scheduled Start</label>
              <input type="datetime-local" className="input" value={startAt} onChange={(e) => setStartAt(e.target.value)} required />
            </div>

            <div>
              <label className="label">Scheduled End</label>
              <input type="datetime-local" className="input" value={endAt} onChange={(e) => setEndAt(e.target.value)} required />
            </div>

            <div>
              <label className="label">Note (optional)</label>
              <textarea className="input min-h-[80px]" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </div>

            {error && <div className="bg-danger-50 text-danger-700 px-3 py-2 rounded-lg text-sm">{error}</div>}

            <button type="submit" className="btn-primary w-full flex items-center justify-center gap-2" disabled={saving}>
              <Plus className="w-4 h-4" />
              {saving ? "Creating..." : "Create Shift"}
            </button>
          </form>

          <div className="mt-4 text-xs text-gray-500 space-y-1">
            <p>Selected Guard: {selectedGuard?.name || "-"}</p>
            <p>Selected Gate: {selectedGate?.name || "-"}</p>
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="card mb-3">
            <h2 className="text-sm font-medium text-gray-500">Scheduled Shifts</h2>
          </div>

          {loading ? (
            <div className="card text-center text-gray-500 py-10 animate-pulse">Loading shifts...</div>
          ) : shifts.length === 0 ? (
            <div className="card text-center text-gray-500 py-10">No shifts scheduled yet</div>
          ) : (
            <div className="space-y-3">
              {shifts.map((shift) => (
                <div key={shift.id} className="card">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center shrink-0">
                      <CalendarClock className="w-5 h-5 text-primary-700" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-gray-900">{shift.guard.name}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusStyles[shift.status]}`}>
                          {shift.status}
                        </span>
                      </div>

                      <p className="text-xs text-gray-600 mt-1">
                        {shift.gate.name}
                        {shift.gate.location ? ` • ${shift.gate.location}` : ""}
                      </p>

                      <div className="mt-2 text-xs text-gray-600 space-y-1">
                        <p className="flex items-center gap-1">
                          <Clock3 className="w-3.5 h-3.5 text-gray-400" />
                          Scheduled: {new Date(shift.scheduledStartAt).toLocaleString()} → {new Date(shift.scheduledEndAt).toLocaleString()}
                        </p>
                        {shift.actualStartAt && (
                          <p>Started: {new Date(shift.actualStartAt).toLocaleString()}</p>
                        )}
                        {shift.actualEndAt && <p>Ended: {new Date(shift.actualEndAt).toLocaleString()}</p>}
                        {shift.note && <p>Note: {shift.note}</p>}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
