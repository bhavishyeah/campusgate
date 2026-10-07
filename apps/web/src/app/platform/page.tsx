"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Plus, Ban, CheckCircle2, X, Copy } from "lucide-react";

interface PlatformStats {
  institutions: { total: number; active: number; suspended: number };
  users: { total: number; students: number };
  movement: { totalPasses: number; currentlyOutside: number };
}

interface InstitutionRow {
  id: string;
  name: string;
  code: string;
  domain: string | null;
  status: "ACTIVE" | "SUSPENDED";
  _count: {
    users: number;
    departments: number;
    gates: number;
    exitReasons: number;
  };
}

interface CreateInstitutionResult {
  institution: InstitutionRow;
  admin: { id: string; email: string; role: string };
  tempPassword: string;
}

export default function PlatformPage() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [institutions, setInstitutions] = useState<InstitutionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", code: "", domain: "", adminEmail: "" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [created, setCreated] = useState<CreateInstitutionResult | null>(null);

  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError("");
    Promise.all([
      api.get<PlatformStats>("/api/platform/stats"),
      api.get<InstitutionRow[]>("/api/platform/institutions"),
    ])
      .then(([s, i]) => {
        setStats(s);
        setInstitutions(i);
      })
      .catch((e: any) => setError(e.message || "Failed to load platform data"))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError("");
    setCreating(true);
    try {
      const result = await api.post<CreateInstitutionResult>("/api/platform/institutions", {
        name: form.name.trim(),
        code: form.code.trim(),
        domain: form.domain.trim() || undefined,
        adminEmail: form.adminEmail.trim(),
      });
      setCreated(result);
      setForm({ name: "", code: "", domain: "", adminEmail: "" });
      load();
    } catch (err: any) {
      setCreateError(err.message || "Failed to create institution");
    } finally {
      setCreating(false);
    }
  };

  const closeCreateModal = () => {
    setShowCreate(false);
    setCreated(null);
    setCreateError("");
  };

  const toggleStatus = async (inst: InstitutionRow) => {
    const nextStatus = inst.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    const confirmed = window.confirm(
      nextStatus === "SUSPENDED"
        ? `Suspend "${inst.name}"? All its users will immediately lose access.`
        : `Reactivate "${inst.name}"? Its users will regain access.`
    );
    if (!confirmed) return;

    setStatusBusyId(inst.id);
    try {
      await api.put(`/api/platform/institutions/${inst.id}/status`, { status: nextStatus });
      load();
    } catch (err: any) {
      alert(err.message || "Failed to update institution status");
    } finally {
      setStatusBusyId(null);
    }
  };

  if (loading) return <div className="animate-pulse text-gray-500">Loading...</div>;
  if (error) return <div className="text-danger-600">{error}</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Platform Dashboard</h2>
        <button
          className="btn-primary flex items-center gap-2"
          onClick={() => setShowCreate(true)}
        >
          <Plus className="w-4 h-4" />
          New Institution
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card">
          <p className="text-sm text-gray-500">Institutions</p>
          <p className="text-2xl font-bold text-gray-900">{stats?.institutions.total ?? 0}</p>
          <p className="text-xs text-gray-500 mt-1">
            Active: {stats?.institutions.active ?? 0} · Suspended: {stats?.institutions.suspended ?? 0}
          </p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">Users</p>
          <p className="text-2xl font-bold text-gray-900">{stats?.users.total ?? 0}</p>
          <p className="text-xs text-gray-500 mt-1">Students: {stats?.users.students ?? 0}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">Movement</p>
          <p className="text-2xl font-bold text-gray-900">{stats?.movement.totalPasses ?? 0}</p>
          <p className="text-xs text-gray-500 mt-1">
            Currently Outside: {stats?.movement.currentlyOutside ?? 0}
          </p>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Institutions</h3>
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Code</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Users</th>
              <th className="py-2 pr-4">Departments</th>
              <th className="py-2 pr-4">Gates</th>
              <th className="py-2 pr-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {institutions.map((inst) => (
              <tr key={inst.id} className="border-b last:border-0">
                <td className="py-2 pr-4 font-medium text-gray-900">{inst.name}</td>
                <td className="py-2 pr-4 font-mono text-xs">{inst.code}</td>
                <td className="py-2 pr-4">
                  <span
                    className={`text-xs px-2 py-1 rounded-full font-medium ${
                      inst.status === "ACTIVE"
                        ? "bg-success-50 text-success-700"
                        : "bg-danger-50 text-danger-700"
                    }`}
                  >
                    {inst.status}
                  </span>
                </td>
                <td className="py-2 pr-4">{inst._count.users}</td>
                <td className="py-2 pr-4">{inst._count.departments}</td>
                <td className="py-2 pr-4">{inst._count.gates}</td>
                <td className="py-2 pr-4">
                  <button
                    onClick={() => toggleStatus(inst)}
                    disabled={statusBusyId === inst.id}
                    className={`flex items-center gap-1 text-xs px-2 py-1 rounded font-medium disabled:opacity-50 ${
                      inst.status === "ACTIVE"
                        ? "bg-danger-50 text-danger-700 hover:bg-danger-100"
                        : "bg-success-50 text-success-700 hover:bg-success-100"
                    }`}
                  >
                    {inst.status === "ACTIVE" ? (
                      <>
                        <Ban className="w-3 h-3" /> Suspend
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-3 h-3" /> Activate
                      </>
                    )}
                  </button>
                </td>
              </tr>
            ))}
            {institutions.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-gray-500">
                  No institutions yet. Create the first one above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            {!created ? (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-gray-900">New Institution</h3>
                  <button onClick={closeCreateModal} aria-label="Close">
                    <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
                  </button>
                </div>

                <form onSubmit={handleCreate} className="space-y-4">
                  <div>
                    <label htmlFor="inst-name" className="label">Institution Name</label>
                    <input
                      id="inst-name"
                      className="input"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="ITM College"
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="inst-code" className="label">Institution Code</label>
                    <input
                      id="inst-code"
                      className="input uppercase"
                      value={form.code}
                      onChange={(e) => setForm({ ...form, code: e.target.value })}
                      placeholder="ITM001"
                      required
                    />
                    <p className="text-xs text-gray-500 mt-1">Unique identifier, cannot be changed later.</p>
                  </div>
                  <div>
                    <label htmlFor="inst-domain" className="label">Domain (optional)</label>
                    <input
                      id="inst-domain"
                      className="input"
                      value={form.domain}
                      onChange={(e) => setForm({ ...form, domain: e.target.value })}
                      placeholder="itm.edu"
                    />
                  </div>
                  <div>
                    <label htmlFor="inst-admin-email" className="label">Initial Admin Email</label>
                    <input
                      id="inst-admin-email"
                      type="email"
                      className="input"
                      value={form.adminEmail}
                      onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
                      placeholder="admin@itm.edu"
                      required
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      This account becomes the institution's first admin.
                    </p>
                  </div>

                  {createError && (
                    <div className="bg-danger-50 text-danger-700 px-4 py-3 rounded-lg text-sm" role="alert">
                      {createError}
                    </div>
                  )}

                  <div className="flex gap-3 pt-2">
                    <button type="button" className="btn-secondary flex-1" onClick={closeCreateModal}>
                      Cancel
                    </button>
                    <button type="submit" className="btn-primary flex-1" disabled={creating}>
                      {creating ? "Creating..." : "Create Institution"}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-4 text-success-700">
                  <CheckCircle2 className="w-5 h-5" />
                  <h3 className="text-lg font-semibold">Institution Created</h3>
                </div>
                <p className="text-sm text-gray-600 mb-4">
                  <strong>{created.institution.name}</strong> ({created.institution.code}) is now active.
                  Share these credentials with the institution's admin — the password is shown only once.
                </p>
                <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm mb-4">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Admin Email</span>
                    <span className="font-mono">{created.admin.email}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Temporary Password</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium">{created.tempPassword}</span>
                      <button
                        type="button"
                        onClick={() => navigator.clipboard.writeText(created.tempPassword)}
                        aria-label="Copy temporary password"
                        className="text-gray-400 hover:text-gray-700"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
                <button className="btn-primary w-full" onClick={closeCreateModal}>
                  Done
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
