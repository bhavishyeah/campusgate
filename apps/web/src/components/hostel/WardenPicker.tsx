"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InlineError } from "@/components/ui-ext/InlineError";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { describeApiError } from "@/lib/apiErrors";
import { useUserLookup } from "@/features/hostel/hooks";
import { useDebouncedValue } from "@/features/hostel/useDebouncedValue";
import { LOOKUP_HINT } from "@/features/hostel/formSchemas";
import type { UserLookupItem } from "@/features/hostel/types";

/** Staff user search for the building warden. Shows the selected user as a chip with "Remove warden". */
export function WardenPicker({
  value,
  onChange,
}: {
  value: UserLookupItem | null;
  onChange: (u: UserLookupItem | null) => void;
}) {
  const [text, setText] = useState("");
  const debounced = useDebouncedValue(text, 300);
  const lookup = useUserLookup(debounced);
  const long = debounced.trim().length >= 2;

  if (!lookup.allowed) return <NoAccess what="the warden lookup" />;

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2 text-sm">
        <span>
          <span className="font-medium">{value.name ?? value.email}</span>
          {value.name ? `, ${value.email}` : ""}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
          Remove warden
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="hostel-warden-q">Warden (name or email)</Label>
      <Input
        id="hostel-warden-q"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={100}
        autoComplete="off"
      />
      {text.trim().length > 0 && !long ? (
        <p className="text-xs text-gray-500">{LOOKUP_HINT}</p>
      ) : !long ? (
        <p className="text-xs text-gray-500">Optional. Type at least 2 characters to search staff.</p>
      ) : lookup.isLoading ? (
        <p className="text-xs text-gray-500">Searching...</p>
      ) : lookup.isError ? (
        <InlineError message={describeApiError(lookup.error)} />
      ) : (lookup.data?.users.length ?? 0) === 0 ? (
        <p className="text-xs text-gray-500">No matching staff.</p>
      ) : (
        <ul className="max-h-48 overflow-auto rounded-md border border-gray-200 divide-y">
          {lookup.data?.users.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                onClick={() => onChange(u)}
              >
                <span className="font-medium">{u.name ?? u.email}</span>
                {u.name ? `, ${u.email}` : ""}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
