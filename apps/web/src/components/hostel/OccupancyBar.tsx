import { occupancyPercent } from "@/features/hostel/format";

/** Progress bar with a text percentage; "No rooms" when capacity is zero. */
export function OccupancyBar({ occupied, capacity }: { occupied: number; capacity: number }) {
  const pct = occupancyPercent(occupied, capacity);
  if (pct === null) return <span className="text-sm text-gray-500">No rooms</span>;
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Occupancy"
        className="h-2 w-32 rounded-full bg-gray-100"
      >
        <div className="h-2 rounded-full bg-primary-600" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm text-gray-600">{pct}%</span>
    </div>
  );
}
