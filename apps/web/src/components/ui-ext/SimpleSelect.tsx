"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NONE = "__none__";

/**
 * Thin wrapper over the shadcn Select. Radix forbids an empty-string item
 * value, so an optional "None" entry is mapped to/from "".
 */
export function SimpleSelect({
  value,
  onChange,
  options,
  placeholder = "Select",
  noneLabel,
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  /** When set, shows a first option with this label that maps to "". */
  noneLabel?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <Select
      value={value === "" ? (noneLabel ? NONE : "") : value}
      onValueChange={(v) => onChange(v === NONE ? "" : v)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {noneLabel ? <SelectItem value={NONE}>{noneLabel}</SelectItem> : null}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
