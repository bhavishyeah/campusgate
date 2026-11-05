"use client";

import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { Label } from "@/components/ui/label";
import { InlineError } from "@/components/ui-ext/InlineError";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { describeApiError } from "@/lib/apiErrors";

interface Department {
  id: string;
  name: string;
  code: string;
}

/**
 * Optional custody-by-department picker. Uses the public cross-tenant
 * /auth/departments list (documented Known Limitation — the only department list
 * a manager can reach).
 */
export function DepartmentPicker({
  value,
  onChange,
  label = "Department (optional)",
}: {
  value: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  const q = useQuery<Department[], ApiError>({
    queryKey: ["inventory", "departments"],
    queryFn: () => api.get("/api/auth/departments"),
  });

  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <SimpleSelect
        ariaLabel={label}
        value={value}
        onChange={onChange}
        noneLabel="None"
        placeholder={q.isLoading ? "Loading..." : "Select a department"}
        options={(q.data ?? []).map((d) => ({ value: d.id, label: `${d.code} - ${d.name}` }))}
      />
      {q.isError ? <InlineError message={describeApiError(q.error)} /> : null}
    </div>
  );
}
