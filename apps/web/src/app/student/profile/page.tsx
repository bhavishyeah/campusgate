"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function StudentProfile() {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get("/api/auth/me")
      .then(setProfile)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="animate-pulse text-gray-500 text-center py-12">Loading...</div>;
  }

  if (!profile) return null;

  const student = profile.profile;

  return (
    <div className="max-w-lg mx-auto">
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
    </div>
  );
}
