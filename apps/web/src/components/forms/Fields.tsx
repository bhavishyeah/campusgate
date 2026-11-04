"use client";

import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";

// Thin field wrappers over react-hook-form + the shadcn Form primitives. The control type is
// intentionally loose: each dialog types its own useForm<z.input<S>, unknown, z.output<S>>.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyControl = any;

export function TextField({
  control,
  name,
  label,
  type = "text",
  help,
  step,
  disabled,
}: {
  control: AnyControl;
  name: string;
  label: string;
  type?: "text" | "date" | "number" | "time" | "datetime-local";
  help?: string;
  step?: string;
  disabled?: boolean;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input type={type} step={step} disabled={disabled} {...field} value={String(field.value ?? "")} />
          </FormControl>
          {help ? <p className="text-xs text-gray-500">{help}</p> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function TextareaField({
  control,
  name,
  label,
  help,
  rows = 3,
}: {
  control: AnyControl;
  name: string;
  label: string;
  help?: string;
  rows?: number;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Textarea rows={rows} {...field} value={String(field.value ?? "")} />
          </FormControl>
          {help ? <p className="text-xs text-gray-500">{help}</p> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function SelectField({
  control,
  name,
  label,
  options,
  noneLabel,
  help,
  disabled,
  onValueChange,
}: {
  control: AnyControl;
  name: string;
  label: string;
  options: { value: string; label: string }[];
  noneLabel?: string;
  help?: string;
  disabled?: boolean;
  onValueChange?: (v: string) => void;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <SimpleSelect
            ariaLabel={label}
            value={String(field.value ?? "")}
            onChange={(v) => {
              field.onChange(v);
              onValueChange?.(v);
            }}
            options={options}
            noneLabel={noneLabel}
            disabled={disabled}
          />
          {help ? <p className="text-xs text-gray-500">{help}</p> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** Error line for picker-backed values that are not rendered through a FormField. */
export function PickerError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-[0.8rem] font-medium text-destructive">
      {message}
    </p>
  );
}
