"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { PickerError } from "@/components/forms/Fields";
import type { FieldDef } from "@/features/service-requests/types";

/**
 * Renders a single data-driven field: TEXT -> text, NUMBER -> number, DATE -> date,
 * SELECT -> SimpleSelect of options. `required` marks the field. Blank date inputs are
 * never coerced (the value is the raw input string; the builder omits blanks).
 */
export function DynamicFieldInput({
  field,
  value,
  onChange,
  error,
}: {
  field: FieldDef;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const id = `sr-field-${field.fieldKey}`;
  const label = field.required ? `${field.label} *` : field.label;

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {field.dataType === "SELECT" ? (
        <SimpleSelect
          ariaLabel={field.label}
          value={value}
          onChange={onChange}
          noneLabel={field.required ? undefined : "None"}
          placeholder="Select"
          options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
        />
      ) : (
        <Input
          id={id}
          type={field.dataType === "NUMBER" ? "number" : field.dataType === "DATE" ? "date" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <PickerError message={error} />
    </div>
  );
}
