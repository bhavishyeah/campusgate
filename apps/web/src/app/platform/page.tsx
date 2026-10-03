"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

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

export default function PlatformPage() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [institutions, setInstitutions] = useState<InstitutionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
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
  }, []);

  if (loading) return <div className="animate-pulse text-gray-500">Loading...</div>;
  if (error) return <div className="text-danger-600">{error}</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900">Platform Dashboard</h2>

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
            </tr>
          </thead>
          <tbody>
            {institutions.map((inst) => (
              <tr key={inst.id} className="border-b last:border-0">
                <td className="py-2 pr-4 font-medium text-gray-900">{inst.name}</td>
                <td className="py-2 pr-4">{inst.code}</td>
                <td className="py-2 pr-4">{inst.status}</td>
                <td className="py-2 pr-4">{inst._count.users}</td>
                <td className="py-2 pr-4">{inst._count.departments}</td>
                <td className="py-2 pr-4">{inst._count.gates}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
