"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { UserPlus, Check, Ban, RotateCcw, X } from "lucide-react";

interface Department {
  id: string;
  name: string;
  code: string;
}

interface Gate {
  id: string;
  name: string;
}

interface UserRow {
  id: string;
  email: string;
  role: "STUDENT" | "HOD" | "GUARD" | "ADMIN";
  accountStatus: "ACTIVE" | "INACTIVE" | "PENDING_APPROVAL";
  createdAt: string;
  studentProfile?: { name: string; enrollmentNo: string; department?: { name: string } };
  hodProfile?: { name: string; department?: { name: string } };
  guardProfile?: { name: string; assignedGates?: { gate: { name: string } }[] };
}

interface UsersResponse {
  users: UserRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

const statusStyles: Record<string, string> = {
  ACTIVE: "bg-success-50 text-success-700",
  INACTIVE: "bg-gray-100 text-gray-600",
  PENDING_APPROVAL: "bg-warning-50 text-warning-600",
};

const roleStyles: Record<string, string> = {
  STUDENT: "bg-primary-50 text-primary-700",
  HOD: "bg-purple-50 text-purple-700",
  GUARD: "bg-green-50 text-green-700",
  ADMIN: "bg-gray-800 text-white",
};

function profileName(u: UserRow) {
  return u.studentProfile?.name || u.hodProfile?.name || u.guardProfile?.name || "—";
}

function profileDetail(u: UserRow) {
  if (u.studentProfile)
    return `${u.studentProfile.enrollmentNo} · ${u.studentProfile.department?.name ?? ""}`;
  if (u.hodProfile) return u.hodProfile.department?.name ?? "";
  if (u.guardProfile)
    return (u.guardProfile.assignedGates ?? []).map((a) => a.gate.name).join(", ") || "No gate assigned";
  return "";
}

export default function AdminUsersPage() {
  const [data, setData] = useState<UsersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (roleFilter) params.set("role", roleFilter);
      if (statusFilter) params.set("status", statusFilter);
      const result = await api.get<UsersResponse>(`/api/admin/users?${params}`);
      setData(result);
    } catch (err: any) {
      setError(err.message || "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [page, roleFilter, statusFilter]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    api.get<Department[]>("/api/admin/departments").then(setDepartments).catch(() => {});
    api.get<Gate[]>("/api/admin/gates").then(setGates).catch(() => {});
  }, []);

  const act = async (id: string, action: "approve" | "deactivate" | "reactivate") => {
    setBusyId(id);
    setError("");
    try {
      await api.post(`/api/admin/users/${id}/${action}`);
      await fetchUsers();
    } catch (err: any) {
      setError(err.message || `Failed to ${action} user`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-900">Users</h1>
        <button
          className="btn-primary flex items-center gap-2"
          onClick={() => setShowCreate(true)}
        >
          <UserPlus className="w-4 h-4" />
          Create User
        </button>
      </div>

      {/* Filters */}
      <div className="card mb-4 flex flex-wrap gap-4 items-end">
        <div>
          <label htmlFor="roleFilter" className="label">
            Role
          </label>
          <select
            id="roleFilter"
            className="input"
            value={roleFilter}
            onChange={(e) => {
              setPage(1);
              setRoleFilter(e.target.value);
            }}
          >
            <option value="">All roles</option>
            <option value="STUDENT">Student</option>
            <option value="HOD">HOD</option>
            <option value="GUARD">Guard</option>
            <option value="ADMIN">Admin</option>
          </select>
        </div>
        <div>
          <label htmlFor="statusFilter" className="label">
            Status
          </label>
          <select
            id="statusFilter"
            className="input"
            value={statusFilter}
            onChange={(e) => {
              setPage(1);
              setStatusFilter(e.target.value);
            }}
          >
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="PENDING_APPROVAL">Pending approval</option>
          </select>
        </div>
        {data && (
          <p className="text-sm text-gray-500 ml-auto">
            {data.pagination.total} user{data.pagination.total === 1 ? "" : "s"}
          </p>
        )}
      </div>

      {error && (
        <div
          className="bg-danger-50 border border-danger-500 text-danger-700 px-4 py-3 rounded-lg text-sm mb-4"
          role="alert"
        >
          {error}
        </div>
      )}

      {tempPassword && (
        <div className="bg-warning-50 border border-warning-500 text-warning-600 px-4 py-3 rounded-lg text-sm mb-4 flex items-start justify-between gap-4">
          <span>
            User created. Temporary password:{" "}
            <strong className="font-mono">{tempPassword}</strong> — share this
            securely, it will not be shown again.
          </span>
          <button
            onClick={() => setTempPassword(null)}
            aria-label="Dismiss temporary password"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="card text-center text-gray-500 py-10 animate-pulse">
          Loading users...
        </div>
      ) : !data || data.users.length === 0 ? (
        <div className="card text-center text-gray-500 py-10">No users found</div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <caption className="sr-only">Institution users</caption>
            <thead className="bg-gray-50 text-left">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium text-gray-600">Name</th>
                <th scope="col" className="px-4 py-3 font-medium text-gray-600">Email</th>
                <th scope="col" className="px-4 py-3 font-medium text-gray-600">Role</th>
                <th scope="col" className="px-4 py-3 font-medium text-gray-600">Status</th>
                <th scope="col" className="px-4 py-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{profileName(u)}</p>
                    <p className="text-xs text-gray-500">{profileDetail(u)}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{u.email}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${roleStyles[u.role]}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusStyles[u.accountStatus]}`}>
                      {u.accountStatus.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      {u.accountStatus === "PENDING_APPROVAL" && (
                        <button
                          className="flex items-center gap-1 text-xs bg-success-500 hover:bg-success-600 text-white px-2 py-1 rounded disabled:opacity-50"
                          onClick={() => act(u.id, "approve")}
                          disabled={busyId === u.id}
                        >
                          <Check className="w-3 h-3" />
                          Approve
                        </button>
                      )}
                      {u.accountStatus === "ACTIVE" && (
                        <button
                          className="flex items-center gap-1 text-xs bg-danger-500 hover:bg-danger-600 text-white px-2 py-1 rounded disabled:opacity-50"
                          onClick={() => act(u.id, "deactivate")}
                          disabled={busyId === u.id}
                        >
                          <Ban className="w-3 h-3" />
                          Deactivate
                        </button>
                      )}
                      {u.accountStatus === "INACTIVE" && (
                        <button
                          className="flex items-center gap-1 text-xs bg-primary-600 hover:bg-primary-700 text-white px-2 py-1 rounded disabled:opacity-50"
                          onClick={() => act(u.id, "reactivate")}
                          disabled={busyId === u.id}
                        >
                          <RotateCcw className="w-3 h-3" />
                          Reactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {data && data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 mt-4">
          <button
            className="btn-secondary"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            Previous
          </button>
          <span className="text-sm text-gray-600">
            Page {data.pagination.page} of {data.pagination.totalPages}
          </span>
          <button
            className="btn-secondary"
            onClick={() => setPage((p) => Math.min(data.pagination.totalPages, p + 1))}
            disabled={page >= data.pagination.totalPages}
          >
            Next
          </button>
        </div>
      )}

      {showCreate && (
        <CreateUserModal
          departments={departments}
          gates={gates}
          onClose={() => setShowCreate(false)}
          onCreated={(pw) => {
            setShowCreate(false);
            setTempPassword(pw);
            fetchUsers();
          }}
        />
      )}
    </div>
  );
}

function CreateUserModal({
  departments,
  gates,
  onClose,
  onCreated,
}: {
  departments: Department[];
  gates: Gate[];
  onClose: () => void;
  onCreated: (tempPassword: string) => void;
}) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    role: "STUDENT",
    departmentId: "",
    enrollmentNo: "",
    program: "",
    semester: "",
    section: "",
    gateIds: [] as string[],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        email: form.email,
        role: form.role,
      };
      if (form.role === "STUDENT") {
        payload.departmentId = form.departmentId;
        payload.enrollmentNo = form.enrollmentNo;
        payload.program = form.program;
        payload.semester = parseInt(form.semester);
        if (form.section) payload.section = form.section;
      } else if (form.role === "HOD") {
        payload.departmentId = form.departmentId;
      } else if (form.role === "GUARD") {
        payload.gateIds = form.gateIds;
      }

      const res = await api.post<{ tempPassword: string }>("/api/admin/users", payload);
      onCreated(res.tempPassword);
    } catch (err: any) {
      setError(err.message || "Failed to create user");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 overflow-y-auto">
      <div className="bg-white rounded-xl p-6 w-full max-w-lg my-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Create User</h2>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="cu-role" className="label">Role</label>
            <select
              id="cu-role"
              className="input"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              <option value="STUDENT">Student</option>
              <option value="HOD">HOD</option>
              <option value="GUARD">Guard</option>
              <option value="ADMIN">Admin</option>
            </select>
          </div>

          <div>
            <label htmlFor="cu-name" className="label">Full Name</label>
            <input
              id="cu-name"
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              minLength={2}
            />
          </div>

          <div>
            <label htmlFor="cu-email" className="label">Email</label>
            <input
              id="cu-email"
              type="email"
              className="input"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          </div>

          {(form.role === "STUDENT" || form.role === "HOD") && (
            <div>
              <label htmlFor="cu-dept" className="label">Course</label>
              <select
                id="cu-dept"
                className="input"
                value={form.departmentId}
                onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
                required
              >
                <option value="">Select course</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.code})
                  </option>
                ))}
              </select>
            </div>
          )}

          {form.role === "STUDENT" && (
            <>
              <div>
                <label htmlFor="cu-enroll" className="label">Enrollment Number</label>
                <input
                  id="cu-enroll"
                  className="input"
                  value={form.enrollmentNo}
                  onChange={(e) => setForm({ ...form, enrollmentNo: e.target.value })}
                  required
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label htmlFor="cu-program" className="label">Program</label>
                  <input
                    id="cu-program"
                    className="input"
                    value={form.program}
                    onChange={(e) => setForm({ ...form, program: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="cu-sem" className="label">Semester</label>
                  <input
                    id="cu-sem"
                    type="number"
                    min={1}
                    max={12}
                    className="input"
                    value={form.semester}
                    onChange={(e) => setForm({ ...form, semester: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="cu-section" className="label">Section</label>
                  <input
                    id="cu-section"
                    className="input"
                    value={form.section}
                    onChange={(e) => setForm({ ...form, section: e.target.value })}
                  />
                </div>
              </div>
            </>
          )}

          {form.role === "GUARD" && (
            <fieldset>
              <legend className="label">Assigned Gates</legend>
              <div className="space-y-2 border border-gray-200 rounded-lg p-3">
                {gates.length === 0 && (
                  <p className="text-sm text-gray-500">
                    No gates available. Create a gate first.
                  </p>
                )}
                {gates.map((g) => (
                  <label key={g.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={form.gateIds.includes(g.id)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          gateIds: e.target.checked
                            ? [...form.gateIds, g.id]
                            : form.gateIds.filter((id) => id !== g.id),
                        })
                      }
                    />
                    {g.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {error && (
            <div className="bg-danger-50 text-danger-700 px-4 py-3 rounded-lg text-sm" role="alert">
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary flex-1" disabled={loading}>
              {loading ? "Creating..." : "Create User"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
