"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { Grid } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ApiError } from "@/lib/api";
import { useTimetable, usePublishTimetable } from "@/features/classes/hooks";
import type { ConflictReport, DayOfWeek, ScheduledClass } from "@/features/classes/types";
import { minuteToLabel } from "@/features/classes/utils";

const DAYS: DayOfWeek[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

export default function TimetableViewPage() {
  return (
    <RouteGuard>
      <TimetableViewInner />
    </RouteGuard>
  );
}

function TimetableViewInner() {
  const params = useParams();
  const id = Array.isArray(params.id) ? params.id[0] : params.id ?? "";
  const [conflictData, setConflictData] = useState<ConflictReport | null>(null);

  const { data: timetable, isLoading, isError, error } = useTimetable(id);
  const publishMutation = usePublishTimetable(id);

  function handlePublish(acceptWarnings = false) {
    publishMutation.mutate(
      { acceptWarnings },
      {
        onSuccess: () => {
          toast.success("Timetable published.");
          setConflictData(null);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) {
            if (err.data?.error === "Timetable conflict") {
              setConflictData(err.data?.conflicts ?? {});
            } else {
              toast.error(err.message);
            }
          } else {
            toast.error(err instanceof ApiError ? err.message : "Publish failed.");
          }
        },
      },
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
    );
  }

  if (isError) {
    return (
      <InlineError
        message={error instanceof ApiError ? error.message : "Failed to load timetable."}
      />
    );
  }

  if (!timetable) {
    return <EmptyState icon={Grid} label="Timetable not found" />;
  }

  const scheduledClasses = timetable.scheduledClasses ?? [];

  // Group scheduled classes by day
  const byDay: Record<DayOfWeek, ScheduledClass[]> = {
    SUN: [], MON: [], TUE: [], WED: [], THU: [], FRI: [], SAT: [],
  };
  for (const sc of scheduledClasses) {
    if (sc.dayOfWeek) {
      byDay[sc.dayOfWeek].push(sc);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{timetable.name}</h1>
          <Badge variant={timetable.status === "PUBLISHED" ? "default" : "outline"} className="mt-1">
            {timetable.status}
          </Badge>
        </div>
        <Can permission="classes.timetable.manage">
          {timetable.status === "DRAFT" && (
            <Button onClick={() => handlePublish(false)} disabled={publishMutation.isPending}>
              {publishMutation.isPending ? "Publishing…" : "Publish"}
            </Button>
          )}
        </Can>
      </div>

      {scheduledClasses.length === 0 ? (
        <EmptyState
          icon={Grid}
          label="No scheduled classes"
          description="This timetable has no scheduled classes yet."
        />
      ) : (
        <div className="overflow-x-auto">
          <div className="grid grid-cols-7 gap-2 min-w-[900px]">
            {DAYS.map((day) => (
              <div key={day} className={day === "SUN" ? "opacity-40" : ""}>
                <div className="text-xs font-semibold text-center py-2 border-b">{day}</div>
                <div className="space-y-2 pt-2">
                  {byDay[day].length === 0 ? (
                    <p className="text-xs text-gray-400 text-center">—</p>
                  ) : (
                    byDay[day].map((sc) => (
                      <div
                        key={sc.id}
                        className={`rounded p-2 text-xs border ${
                          sc.status === "CANCELLED"
                            ? "opacity-40 bg-gray-50 border-gray-200"
                            : "bg-blue-50 border-blue-200"
                        }`}
                      >
                        <div className="font-medium truncate">{sc.subjectId}</div>
                        <div className="text-gray-600 truncate">{sc.facultyId}</div>
                        {sc.room && <div className="text-gray-500">{sc.room}</div>}
                        {sc.period && <div className="text-gray-500">Period {sc.period}</div>}
                        <div className="text-gray-500">
                          {minuteToLabel(sc.startTime)}–{minuteToLabel(sc.endTime)}
                        </div>
                        {sc.status === "CANCELLED" && (
                          <Badge variant="destructive" className="text-xs mt-1">Cancelled</Badge>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Conflict confirmation dialog */}
      <Dialog open={conflictData !== null} onOpenChange={(v) => { if (!v) setConflictData(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Timetable conflicts detected</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600 mb-2">
            The following conflicts were found. You can publish anyway or cancel to resolve them.
          </p>
          <pre className="text-xs bg-gray-50 p-3 rounded border overflow-auto max-h-48">
            {JSON.stringify(conflictData, null, 2)}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConflictData(null)}>Cancel</Button>
            <Button
              onClick={() => handlePublish(true)}
              disabled={publishMutation.isPending}
            >
              {publishMutation.isPending ? "Publishing…" : "Publish anyway"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
