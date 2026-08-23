"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ArrowUpRight, ArrowDownLeft } from "lucide-react";

export default function GuardActivity() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get("/api/guard/activity")
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="animate-pulse text-gray-400 text-center py-12">Loading...</div>;
  }

  return (
    <div className="max-w-lg mx-auto space-y-6">
      {/* Today's stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-gray-800 rounded-xl p-4 text-center">
          <p className="text-3xl font-bold text-green-400">{data?.todayExits || 0}</p>
          <p className="text-xs text-gray-400 mt-1">Exits Today</p>
        </div>
        <div className="bg-gray-800 rounded-xl p-4 text-center">
          <p className="text-3xl font-bold text-blue-400">{data?.todayReturns || 0}</p>
          <p className="text-xs text-gray-400 mt-1">Returns Today</p>
        </div>
      </div>

      {/* Recent events */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-3">Recent Events</h2>
        {data?.recentEvents?.length === 0 ? (
          <div className="bg-gray-800 rounded-xl p-6 text-center text-gray-500">
            No events today
          </div>
        ) : (
          <div className="space-y-2">
            {data?.recentEvents?.map((event: any) => (
              <div key={event.id} className="bg-gray-800 rounded-lg p-3 flex items-center gap-3">
                {event.eventType === "EXIT" ? (
                  <ArrowUpRight className="w-5 h-5 text-green-400" />
                ) : (
                  <ArrowDownLeft className="w-5 h-5 text-blue-400" />
                )}
                <div className="flex-1">
                  <p className="text-sm font-medium text-white">
                    {event.pass?.student?.name}
                  </p>
                  <p className="text-xs text-gray-400">
                    {event.gate?.name} •{" "}
                    {new Date(event.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
                <span className={`text-xs px-2 py-1 rounded ${
                  event.eventType === "EXIT"
                    ? "bg-green-900/50 text-green-400"
                    : "bg-blue-900/50 text-blue-400"
                }`}>
                  {event.eventType}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
