"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InlineError } from "@/components/ui-ext/InlineError";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { describeApiError } from "@/lib/apiErrors";
import { useStudentLookup } from "@/features/hostel/hooks";
import { useDebouncedValue } from "@/features/hostel/useDebouncedValue";
import { LOOKUP_HINT } from "@/features/hostel/formSchemas";
import type { StudentLookupItem } from "@/features/hostel/types";

/** Debounced student search (hostel.allocations.manage). Students with a room are disabled. */
export function StudentPicker({
  value,
  onChange,
}: {
  value: StudentLookupItem | null;
  onChange: (s: StudentLookupItem | null) => void;
}) {
  const [text, setText] = useState("");
  const debounced = useDebouncedValue(text, 300);
  const lookup = useStudentLookup(debounced);
  const long = debounced.trim().length >= 2;

  if (!lookup.allowed) return <NoAccess what="the student lookup" />;

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2 text-sm">
        <span>
          <span className="font-medium">{value.name}</span>
          {value.enrollmentNo ? `, ${value.enrollmentNo}` : ""}
          {value.program ? `, ${value.program}` : ""}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="hostel-student-q">Student name or enrollment no</Label>
      <Input
        id="hostel-student-q"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={100}
        autoComplete="off"
      />
      {text.trim().length > 0 && !long ? (
        <p className="text-xs text-gray-500">{LOOKUP_HINT}</p>
      ) : !long ? (
        <p className="text-xs text-gray-500">Type at least 2 characters.</p>
      ) : lookup.isLoading ? (
        <p className="text-xs text-gray-500">Searching...</p>
      ) : lookup.isError ? (
        <InlineError message={describeApiError(lookup.error)} />
      ) : (lookup.data?.students.length ?? 0) === 0 ? (
        <p className="text-xs text-gray-500">No matching students.</p>
      ) : (
        <ul className="max-h-48 overflow-auto rounded-md border border-gray-200 divide-y">
          {lookup.data?.students.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                disabled={s.hasActiveAllocation}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => onChange(s)}
              >
                <span>
                  <span className="font-medium">{s.name}</span>
                  {s.enrollmentNo ? `, ${s.enrollmentNo}` : ""}
                  {s.program ? `, ${s.program}` : ""}
                </span>
                {s.hasActiveAllocation ? (
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">Has a room</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
