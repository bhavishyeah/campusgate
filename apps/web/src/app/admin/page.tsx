"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Users, Shield, DoorOpen, Activity } from "lucide-react";

export default function AdminDashboard() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get("/api/admin/stats")
      .then(setStats)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

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
    </div>
  );
}
