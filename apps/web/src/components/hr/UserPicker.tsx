"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InlineError } from "@/components/ui-ext/InlineError";
import { describeApiError } from "@/lib/apiErrors";
import { useUserLookup } from "@/features/hr/hooks";
import { displayName } from "@/features/hr/labels";
import { useDebouncedValue } from "@/features/hr/useDebouncedValue";
import type { UserLookupItem } from "@/features/hr/types";

/** Picks a user that has no employee record yet. Mount inside <Can hr.employees.manage>. */
export function UserPicker({
  selected,
  onSelect,
  error,
}: {
  selected: UserLookupItem | null;
  onSelect: (user: UserLookupItem | null) => void;
  error?: string;
}) {
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search.trim(), 300);
  const lookup = useUserLookup(debounced);

  if (selected) {
    return (
      <div className="space-y-1">
        <Label>User</Label>
        <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
          <span>
            {displayName(selected)} <span className="text-gray-500">({selected.email})</span>
          </span>
          <button type="button" className="text-primary-600 underline" onClick={() => onSelect(null)}>
            Change
          </button>
        </div>
      </div>
    );
  }

  const users = lookup.data?.users ?? [];
  return (
    <div className="space-y-1">
      <Label htmlFor="hr-user-search">User</Label>
      <Input
        id="hr-user-search"
        value={search}
        maxLength={100}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by email or name"
      />
      <p className="text-xs text-gray-500">Search by email or name (at least 2 characters).</p>
      {lookup.isError ? <InlineError message={describeApiError(lookup.error)} /> : null}
      {debounced.length >= 2 && lookup.isSuccess && users.length === 0 ? (
        <p className="text-sm text-gray-500">No users without an employee record match.</p>
      ) : null}
      {users.length > 0 ? (
        <ul className="max-h-40 divide-y overflow-auto rounded-md border" aria-label="Matching users">
          {users.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                onClick={() => onSelect(u)}
              >
                <span className="font-medium">{displayName(u)}</span>{" "}
                <span className="text-gray-500">
                  {u.email} ({u.role})
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="text-sm text-danger-700">{error}</p> : null}
    </div>
  );
}
