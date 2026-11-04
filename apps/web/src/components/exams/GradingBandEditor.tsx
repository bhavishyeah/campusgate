"use client";

import { useEffect } from "react";
import { useFieldArray, useFormContext, useWatch, type Control } from "react-hook-form";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { InlineError } from "@/components/ui-ext/InlineError";
import { validateBands } from "@/features/exams/gradingBands";
import { rowsToBands, bandRowSchema, type GradingFormValues } from "@/features/exams/formSchemas";

/** Returns an error message when the current rows are invalid, else null. */
export function bandsError(rows: GradingFormValues["bands"]): string | null {
  if (rows.length === 0) return "At least one band is required";
  if (!rows.every((r) => bandRowSchema.safeParse(r).success)) {
    return "Complete every band row";
  }
  const result = validateBands(rowsToBands(rows));
  return result.ok ? null : result.message;
}

export function GradingBandEditor({ control }: { control: Control<GradingFormValues> }) {
  const { fields, append, remove } = useFieldArray({ control, name: "bands" });
  const rows = useWatch({ control, name: "bands" });
  const { setValue } = useFormContext<GradingFormValues>();
  const count = fields.length;

  // Keep the fixed boundary cells in form state so row validation passes.
  useEffect(() => {
    if (count === 0) return;
    setValue("bands.0.minPct", "0");
    setValue(`bands.${count - 1}.maxPct`, "100");
  }, [count, setValue]);

  const error = bandsError(rows ?? []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-900">Grade bands</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            append({ minPct: "", maxPct: "", gradeLabel: "", gradePoints: "0", isPassing: true })
          }
        >
          <Plus className="w-4 h-4 mr-1" /> Add band
        </Button>
      </div>
      <p className="text-xs text-gray-500">
        List bands from lowest to highest. The first band starts at 0% and the last
        ends at 100%.
      </p>
      {fields.map((f, i) => {
        const isFirst = i === 0;
        const isLast = i === fields.length - 1;
        return (
          <div key={f.id} className="grid grid-cols-12 gap-2 items-start">
            <div className="col-span-2">
              <FormField
                control={control}
                name={`bands.${i}.minPct`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Min %</FormLabel>
                    <FormControl>
                      {isFirst ? (
                        <Input value="0" readOnly aria-label="Minimum percent (fixed at 0)" />
                      ) : (
                        <Input inputMode="decimal" {...field} />
                      )}
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="col-span-2">
              <FormField
                control={control}
                name={`bands.${i}.maxPct`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Max %</FormLabel>
                    <FormControl>
                      {isLast ? (
                        <Input value="100" readOnly aria-label="Maximum percent (fixed at 100)" />
                      ) : (
                        <Input inputMode="decimal" {...field} />
                      )}
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="col-span-3">
              <FormField
                control={control}
                name={`bands.${i}.gradeLabel`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Grade</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="col-span-2">
              <FormField
                control={control}
                name={`bands.${i}.gradePoints`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Points</FormLabel>
                    <FormControl>
                      <Input inputMode="numeric" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="col-span-2">
              <FormField
                control={control}
                name={`bands.${i}.isPassing`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Passing</FormLabel>
                    <FormControl>
                      <input
                        type="checkbox"
                        className="h-4 w-4 mt-2 block"
                        checked={field.value}
                        onChange={(e) => field.onChange(e.target.checked)}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>
            <div className="col-span-1 pt-6">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove band ${i + 1}`}
                disabled={fields.length <= 1}
                onClick={() => remove(i)}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          </div>
        );
      })}
      {error && <InlineError message={error} />}
    </div>
  );
}
