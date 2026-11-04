"use client";

import type { Control, FieldValues } from "react-hook-form";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

function humanize(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Renders one text input per campaign-defined key, bound by INDEX
 * ("values.0", "values.1", ...) rather than by the raw key text — a key like
 * "address.line1" or "0" must never become an RHF field path (R1).
 */
export function DynamicFormFields<T extends FieldValues>({
  keys,
  control,
}: {
  keys: string[];
  control: Control<T>;
}) {
  return (
    <div className="space-y-3">
      {keys.map((key, i) => (
        <FormField
          key={`${key}-${i}`}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          control={control as any}
          name={`values.${i}` as any}
          render={({ field }) => (
            <FormItem>
              <FormLabel>{humanize(key)}</FormLabel>
              <FormControl>
                <Input {...field} maxLength={2000} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      ))}
    </div>
  );
}

/** Read-only rendering for a non-string existing formData value. */
export function ReadOnlyValue({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return <p className="text-sm text-gray-700 px-3 py-2 bg-gray-50 rounded-md">{text}</p>;
}
