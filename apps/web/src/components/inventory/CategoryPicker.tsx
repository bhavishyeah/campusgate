"use client";

import { Label } from "@/components/ui/label";
import { InlineError } from "@/components/ui-ext/InlineError";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { describeApiError } from "@/lib/apiErrors";
import { OPTION_PAGE_SIZE, useCategoryOptions } from "@/features/inventory/hooks";
import { categoryLabel } from "@/features/inventory/format";

/** Category <SimpleSelect> from the first 100 categories. */
export function CategoryPicker({
  value,
  onChange,
  label = "Category",
  kind,
  noneLabel,
}: {
  value: string;
  onChange: (id: string) => void;
  label?: string;
  kind?: string;
  noneLabel?: string;
}) {
  const options = useCategoryOptions();
  const categories = (options.data?.categories ?? []).filter((c) => (kind ? c.kind === kind : true));

  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <SimpleSelect
        ariaLabel={label}
        value={value}
        onChange={onChange}
        noneLabel={noneLabel}
        placeholder={options.isLoading ? "Loading..." : "Select a category"}
        options={categories.map((c) => ({ value: c.id, label: categoryLabel(c) }))}
      />
      {options.data && options.data.total > OPTION_PAGE_SIZE ? (
        <p className="text-xs text-gray-500">Showing the first {OPTION_PAGE_SIZE} categories.</p>
      ) : null}
      {options.isError ? <InlineError message={describeApiError(options.error)} /> : null}
    </div>
  );
}
