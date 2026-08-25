"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Plus, Building } from "lucide-react";

interface Department {
  id: string;
  name: string;
  code: string;
  createdAt: string;
}

export default function AdminDepartmentsPage() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchDepartments = async () => {
    try {
      setDepartments(await api.get<Department[]>("/api/admin/departments"));
    } catch (err: any) {
      setError(err.message || "Failed to load departments");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDepartments();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await api.post("/api/admin/departments", { name, code: code.toUpperCase() });
      setName("");
      setCode("");
      await fetchDepartments();
    } catch (err: any) {
      setError(err.message || "Failed to create department");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Departments</h1>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Create form */}
        <div className="card lg:col-span-1">
          <h2 className="text-sm font-medium text-gray-500 mb-4">
            Add Department
          </h2>
          <form onSubmit={create} className="space-y-4">
            <div>
              <label htmlFor="dept-name" className="label">
                Name
              </label>
              <input
                id="dept-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Bachelor of Computer Applications"
                required
              />
            </div>
            <div>
              <label htmlFor="dept-code" className="label">
                Code
              </label>
              <input
                id="dept-code"
                className="input uppercase"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="BCA"
                required
                maxLength={16}
              />
              <p className="text-xs text-gray-500 mt-1">
                Used for CSV bulk import matching.
              </p>
            </div>

            {error && (
              <div
                className="bg-danger-50 text-danger-700 px-4 py-3 rounded-lg text-sm"
                role="alert"
              >
                {error}
              </div>
            )}

            <button type="submit" className="btn-primary w-full flex items-center justify-center gap-2" disabled={saving}>
              <Plus className="w-4 h-4" />
              {saving ? "Adding..." : "Add Department"}
            </button>
          </form>
        </div>

        {/* List */}
        <div className="lg:col-span-2">
          {loading ? (
            <div className="card text-center text-gray-500 py-10 animate-pulse">
              Loading departments...
            </div>
          ) : departments.length === 0 ? (
            <div className="card text-center text-gray-500 py-10">
              No departments yet
            </div>
          ) : (
            <div className="space-y-3">
              {departments.map((d) => (
                <div key={d.id} className="card flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center shrink-0">
                    <Building className="w-5 h-5 text-primary-600" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-gray-900 truncate">{d.name}</p>
                    <p className="text-xs text-gray-500 font-mono">{d.code}</p>
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
