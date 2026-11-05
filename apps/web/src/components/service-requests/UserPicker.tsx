"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InlineError } from "@/components/ui-ext/InlineError";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { describeApiError } from "@/lib/apiErrors";
import { useUserLookup } from "@/features/service-requests/hooks";
import { useDebouncedValue } from "@/features/service-requests/useDebouncedValue";
import { LOOKUP_HINT } from "@/features/service-requests/formSchemas";
import type { UserLookupItem } from "@/features/service-requests/types";

/** Agent lookup (G-SR1). Shows the selected user as a clearable chip. */
export function UserPicker({
  label = "Agent (name or email)",
  value,
  onChange,
}: {
  label?: string;
  value: UserLookupItem | null;
  onChange: (u: UserLookupItem | null) => void;
}) {
  const [text, setText] = useState("");
  const debounced = useDebouncedValue(text, 300);
  const lookup = useUserLookup(debounced);
  const long = debounced.trim().length >= 2;

  if (!lookup.allowed) return <NoAccess what="the agent lookup" />;

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2 text-sm">
        <span>
          <span className="font-medium">{value.name ?? value.email}</span>
          {value.name ? `, ${value.email}` : ""}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
          Clear
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="sr-user-q">{label}</Label>
      <Input id="sr-user-q" value={text} onChange={(e) => setText(e.target.value)} maxLength={100} autoComplete="off" />
      {text.trim().length > 0 && !long ? (
        <p className="text-xs text-gray-500">{LOOKUP_HINT}</p>
      ) : !long ? (
        <p className="text-xs text-gray-500">Type at least 2 characters to search staff.</p>
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
