"use client";

import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

/** projected = existingSum - originalWeight + newWeight */
export function projectWeight(
  existingSum: number,
  originalWeight: number,
  newWeight: number,
): number {
  return existingSum - originalWeight + newWeight;
}

/** Running-total chip: green at 100, amber below, red above. */
export function WeightTotalChip({ total }: { total: number }) {
  const tone =
    total === 100
      ? "bg-green-100 text-green-800 border-green-300"
      : total > 100
        ? "bg-red-100 text-red-800 border-red-300"
        : "bg-amber-100 text-amber-800 border-amber-300";
  return (
    <Badge variant="outline" className={tone}>
      {total} / 100 (remaining: {100 - total})
    </Badge>
  );
}

export function AssessmentWeightInput({
  value,
  onChange,
  existingSum,
  originalWeight,
}: {
  value: string;
  onChange: (v: string) => void;
  existingSum: number;
  /** Weight of the assessment being edited; 0 when adding. */
  originalWeight: number;
}) {
  const parsed = value === "" ? 0 : Number(value);
  const projected = projectWeight(existingSum, originalWeight, Number.isFinite(parsed) ? parsed : 0);
  const headroom = 100 - (existingSum - originalWeight);
  return (
    <div className="space-y-2">
      <Input
        type="number"
        min={1}
        max={Math.max(1, Math.min(100, headroom))}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby="weight-total"
      />
      <div id="weight-total" className="flex items-center gap-2 text-xs">
        <WeightTotalChip total={projected} />
        {projected > 100 && (
          <span className="text-red-700">Exceeds remaining headroom ({Math.max(0, headroom)})</span>
        )}
      </div>
    </div>
  );
}
