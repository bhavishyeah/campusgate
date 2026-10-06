"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { BarChart3, CalendarDays } from "lucide-react";

type AnalyticsResponse = {
  range: { from: string; to: string };
  overview: {
    totalRequests: number;
    approvedRequests: number;
    rejectedRequests: number;
    revokedRequests: number;
    revokedWhileOutside: number;
    completedMovements: number;
    currentlyOutside: number;
    overdueStudents: number;
    avgOutsideMinutes: number;
    totalOutsideMinutes: number;
  };
  departmentStats: Array<{
    department: string;
    requests: number;
    approved: number;
    rejected: number;
    avgOutsideMinutes: number;
  }>;
  reasonStats: Array<{ reason: string; count: number; percentage: number }>;
  gateStats: Array<{ gate: string; exits: number; returns: number; total: number }>;
  hourlyExitDistribution: Array<{ hour: number; label: string; count: number }>;
  dailyTrend: Array<{ date: string; requests: number; exits: number; returns: number }>;
  emergencyOverview: {
    declaredCount: number;
    resolvedCount: number;
    activeNow: boolean;
    avgResolutionMinutes: number;
    activeAlert: { id: string; declaredAt: string; type: string; title: string } | null;
  };
  emergencyByType: Array<{ type: string; count: number }>;
  emergencyDailyTrend: Array<{ date: string; declared: number; resolved: number }>;
};

function asDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function minutesToHuman(minutes: number) {
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hrs === 0) return `${mins}m`;
  return `${hrs}h ${mins}m`;
}

export default function AdminAnalyticsPage() {
  const [fromDate, setFromDate] = useState(() => asDateInput(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)));
  const [toDate, setToDate] = useState(() => asDateInput(new Date()));

  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (silent) setRefreshing(true);
    else setLoading(true);

    setError("");
    try {
      const fromIso = new Date(`${fromDate}T00:00:00.000Z`).toISOString();
      const toIso = new Date(`${toDate}T23:59:59.999Z`).toISOString();

      const res = await api.get<AnalyticsResponse>(
        `/api/admin/analytics?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
      );
      setData(res);
    } catch (err: any) {
      setError(err.message || "Failed to load analytics");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const maxHourCount = useMemo(() => {
    if (!data?.hourlyExitDistribution?.length) return 0;
    return Math.max(...data.hourlyExitDistribution.map((x) => x.count));
  }, [data]);

  const maxDaily = useMemo(() => {
    if (!data?.dailyTrend?.length) return 0;
    return Math.max(...data.dailyTrend.map((x) => Math.max(x.requests, x.exits, x.returns)));
  }, [data]);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-6 h-6 text-primary-700" />
          <h1 className="text-2xl font-bold text-gray-900">Movement Analytics</h1>
        </div>

        <div className="flex items-end gap-2 flex-wrap">
          <div>
            <label className="label">From</label>
            <input type="date" className="input" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div>
            <label className="label">To</label>
            <input type="date" className="input" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
          <button className="btn-primary" onClick={() => load({ silent: true })} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Apply"}
          </button>
        </div>
      </div>

      {error && <div className="mb-4 bg-danger-50 text-danger-700 px-4 py-3 rounded-lg text-sm">{error}</div>}

      {loading ? (
        <div className="card text-center py-12 text-gray-500 animate-pulse">Loading analytics...</div>
      ) : !data ? (
        <div className="card text-center py-12 text-gray-500">No analytics data</div>
      ) : (
        <div className="space-y-6">
          <div className="text-xs text-gray-500 flex items-center gap-2">
            <CalendarDays className="w-4 h-4" />
            {new Date(data.range.from).toLocaleDateString()} - {new Date(data.range.to).toLocaleDateString()}
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              ["Total Requests", data.overview.totalRequests],
              ["Approved", data.overview.approvedRequests],
              ["Rejected", data.overview.rejectedRequests],
              ["Revoked", data.overview.revokedRequests],
              ["Revoked While Outside", data.overview.revokedWhileOutside],
              ["Completed", data.overview.completedMovements],
              ["Currently Outside", data.overview.currentlyOutside],
              ["Overdue", data.overview.overdueStudents],
              ["Avg Outside", minutesToHuman(data.overview.avgOutsideMinutes)],
              ["Total Outside", minutesToHuman(data.overview.totalOutsideMinutes)],
            ].map(([label, value]) => (
              <div key={String(label)} className="card">
                <p className="text-xs text-gray-500">{label}</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{value as any}</p>
              </div>
            ))}
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            <div className="card">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">Emergency Overview</h2>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="rounded-lg bg-gray-50 p-3">
                  <p className="text-xs text-gray-500">Declared</p>
                  <p className="text-xl font-semibold text-gray-900">{data.emergencyOverview.declaredCount}</p>
                </div>
                <div className="rounded-lg bg-gray-50 p-3">
                  <p className="text-xs text-gray-500">Resolved</p>
                  <p className="text-xl font-semibold text-gray-900">{data.emergencyOverview.resolvedCount}</p>
                </div>
                <div className="rounded-lg bg-gray-50 p-3">
                  <p className="text-xs text-gray-500">Active Now</p>
                  <p className={`text-xl font-semibold ${data.emergencyOverview.activeNow ? "text-danger-700" : "text-success-700"}`}>
                    {data.emergencyOverview.activeNow ? "Yes" : "No"}
                  </p>
                </div>
                <div className="rounded-lg bg-gray-50 p-3">
                  <p className="text-xs text-gray-500">Avg Resolution</p>
                  <p className="text-xl font-semibold text-gray-900">
                    {data.emergencyOverview.avgResolutionMinutes > 0
                      ? minutesToHuman(data.emergencyOverview.avgResolutionMinutes)
                      : "-"}
                  </p>
                </div>
              </div>

              {data.emergencyOverview.activeAlert && (
                <div className="rounded-lg border border-danger-200 bg-danger-50 p-3 mb-3">
                  <p className="text-xs text-danger-700 font-medium">Active Alert</p>
                  <p className="text-sm text-danger-800 mt-1">
                    {data.emergencyOverview.activeAlert.type} · {data.emergencyOverview.activeAlert.title}
                  </p>
                  <p className="text-xs text-danger-700 mt-1">
                    Since {new Date(data.emergencyOverview.activeAlert.declaredAt).toLocaleString()}
                  </p>
                </div>
              )}

              <h3 className="text-xs font-semibold text-gray-600 mb-2">By Type</h3>
              {data.emergencyByType.length === 0 ? (
                <p className="text-sm text-gray-500">No emergency records in selected range</p>
              ) : (
                <div className="space-y-2">
                  {data.emergencyByType.map((e) => (
                    <div key={e.type} className="flex items-center justify-between text-sm border border-gray-100 rounded-lg p-2">
                      <span className="text-gray-700">{e.type}</span>
                      <span className="font-medium text-gray-900">{e.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">Department-wise Movement</h2>
              {data.departmentStats.length === 0 ? (
                <p className="text-sm text-gray-500">No records in selected range</p>
              ) : (
                <div className="space-y-3">
                  {data.departmentStats.map((d) => (
                    <div key={d.department} className="border border-gray-100 rounded-lg p-3">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-gray-900">{d.department}</p>
                        <p className="text-xs text-gray-500">Avg: {minutesToHuman(d.avgOutsideMinutes)}</p>
                      </div>
                      <p className="text-xs text-gray-600 mt-1">
                        Requests: {d.requests} · Approved: {d.approved} · Rejected: {d.rejected}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">Reason Distribution</h2>
              {data.reasonStats.length === 0 ? (
                <p className="text-sm text-gray-500">No records in selected range</p>
              ) : (
                <div className="space-y-3">
                  {data.reasonStats.map((r) => (
                    <div key={r.reason}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-gray-700">{r.reason}</span>
                        <span className="text-gray-500">
                          {r.count} ({r.percentage}%)
                        </span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full bg-primary-500" style={{ width: `${Math.min(100, r.percentage)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            <div className="card">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">Gate-wise Movement</h2>
              {data.gateStats.length === 0 ? (
                <p className="text-sm text-gray-500">No gate events in selected range</p>
              ) : (
                <div className="space-y-2">
                  {data.gateStats.map((g) => (
                    <div key={g.gate} className="text-sm border border-gray-100 rounded-lg p-3">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-gray-900">{g.gate}</p>
                        <p className="text-xs text-gray-500">Total {g.total}</p>
                      </div>
                      <p className="text-xs text-gray-600 mt-1">Exits: {g.exits} · Returns: {g.returns}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">Exit Peak Hours</h2>
              <div className="space-y-1 max-h-[360px] overflow-y-auto pr-1">
                {data.hourlyExitDistribution.map((h) => {
                  const width = maxHourCount > 0 ? Math.max(2, (h.count / maxHourCount) * 100) : 0;
                  return (
                    <div key={h.hour} className="flex items-center gap-2 text-xs">
                      <span className="w-12 text-gray-500">{h.label}</span>
                      <div className="flex-1 h-3 bg-gray-100 rounded overflow-hidden">
                        {h.count > 0 && <div className="h-full bg-primary-500" style={{ width: `${width}%` }} />}
                      </div>
                      <span className="w-8 text-right text-gray-700">{h.count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            <div className="card">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">Daily Movement Trend</h2>
              {data.dailyTrend.length === 0 ? (
                <p className="text-sm text-gray-500">No activity in selected range</p>
              ) : (
                <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
                  {data.dailyTrend.map((d) => {
                    const maxForDay = Math.max(d.requests, d.exits, d.returns);
                    const reqW = maxDaily > 0 ? (d.requests / maxDaily) * 100 : 0;
                    const exitW = maxDaily > 0 ? (d.exits / maxDaily) * 100 : 0;
                    const retW = maxDaily > 0 ? (d.returns / maxDaily) * 100 : 0;

                    return (
                      <div key={d.date} className="border border-gray-100 rounded-lg p-2">
                        <p className="text-xs text-gray-500 mb-2">{new Date(d.date).toLocaleDateString()}</p>
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className="w-14 text-gray-600">Requests</span>
                            <div className="flex-1 h-2 bg-gray-100 rounded">{d.requests > 0 && <div className="h-full bg-purple-500 rounded" style={{ width: `${reqW}%` }} />}</div>
                            <span className="w-6 text-right">{d.requests}</span>
                          </div>
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className="w-14 text-gray-600">Exits</span>
                            <div className="flex-1 h-2 bg-gray-100 rounded">{d.exits > 0 && <div className="h-full bg-green-500 rounded" style={{ width: `${exitW}%` }} />}</div>
                            <span className="w-6 text-right">{d.exits}</span>
                          </div>
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className="w-14 text-gray-600">Returns</span>
                            <div className="flex-1 h-2 bg-gray-100 rounded">{d.returns > 0 && <div className="h-full bg-blue-500 rounded" style={{ width: `${retW}%` }} />}</div>
                            <span className="w-6 text-right">{d.returns}</span>
                          </div>
                        </div>
                        <p className="text-[10px] text-gray-400 mt-1">Daily max metric: {maxForDay}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="card">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">Daily Emergency Trend</h2>
              {data.emergencyDailyTrend.length === 0 ? (
                <p className="text-sm text-gray-500">No emergency activity in selected range</p>
              ) : (
                <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
                  {data.emergencyDailyTrend.map((d) => (
                    <div key={d.date} className="border border-gray-100 rounded-lg p-2">
                      <p className="text-xs text-gray-500 mb-1">{new Date(d.date).toLocaleDateString()}</p>
                      <p className="text-xs text-gray-700">Declared: {d.declared} · Resolved: {d.resolved}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
