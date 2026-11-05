"use client";

import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { useTypes } from "@/features/service-requests/hooks";
import { typeLabel } from "@/features/service-requests/format";

/** Request-type filter from the staff /types list. */
export function TypePicker({
  value,
  onChange,
  ariaLabel = "Type",
  noneLabel = "All types",
}: {
  value: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
  noneLabel?: string;
}) {
  const types = useTypes();
  return (
    <SimpleSelect
      ariaLabel={ariaLabel}
      value={value}
      onChange={onChange}
      noneLabel={noneLabel}
      placeholder={types.isLoading ? "Loading..." : "Type"}
      options={(types.data ?? []).map((t) => ({ value: t.id, label: typeLabel(t) }))}
    />
  );
}
