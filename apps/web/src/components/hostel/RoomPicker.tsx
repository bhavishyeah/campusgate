"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InlineError } from "@/components/ui-ext/InlineError";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { describeApiError } from "@/lib/apiErrors";
import { OPTION_PAGE_SIZE, useBuildingOptions, useRoomOptions } from "@/features/hostel/hooks";
import { filterRooms, mergeRoomPages } from "@/features/hostel/format";
import type { RoomRow } from "@/features/hostel/types";

/**
 * Building select, then the rooms of that building, 100 per page with "Load more rooms" so every
 * room is reachable. A client-side filter runs over the loaded pages. Rooms with no free bed are
 * disabled when `disableFull` is set; `disabledRoomId` disables one room (the current room).
 */
export function RoomPicker({
  value,
  onChange,
  status,
  disableFull,
  disabledRoomId,
  initialBuildingId,
}: {
  value: string;
  onChange: (roomId: string) => void;
  status?: string;
  disableFull?: boolean;
  disabledRoomId?: string;
  initialBuildingId?: string;
}) {
  const [buildingId, setBuildingId] = useState(initialBuildingId ?? "");
  const [text, setText] = useState("");
  const key = `${buildingId}|${status ?? ""}`;
  const [pageState, setPageState] = useState({ key, page: 1 });
  const page = pageState.key === key ? pageState.page : 1;
  const [loaded, setLoaded] = useState<{ key: string; rooms: RoomRow[] }>({ key, rooms: [] });

  const buildings = useBuildingOptions();
  const rooms = useRoomOptions({ buildingId, status, page });

  useEffect(() => {
    const data = rooms.data;
    if (!data || rooms.isPlaceholderData) return;
    setLoaded((prev) => ({
      key,
      rooms: mergeRoomPages(prev.key === key ? prev.rooms : [], data.rooms),
    }));
  }, [rooms.data, rooms.isPlaceholderData, key]);

  const current = useMemo(() => (loaded.key === key ? loaded.rooms : []), [loaded, key]);
  const visible = useMemo(() => filterRooms(current, text), [current, text]);
  const total = rooms.data && !rooms.isPlaceholderData ? rooms.data.total : undefined;
  const hasMore = total !== undefined && current.length < total;

  if (!buildings.allowed) return <NoAccess what="the room picker" />;

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label>Building</Label>
        <SimpleSelect
          ariaLabel="Building"
          value={buildingId}
          onChange={(v) => {
            setBuildingId(v);
            setText("");
            onChange("");
          }}
          placeholder="Select a building"
          options={(buildings.data?.buildings ?? []).map((b) => ({ value: b.id, label: b.name }))}
        />
        {buildings.data && buildings.data.total > OPTION_PAGE_SIZE ? (
          <p className="text-xs text-gray-500">Showing the first {OPTION_PAGE_SIZE} buildings.</p>
        ) : null}
        {buildings.isError ? <InlineError message={describeApiError(buildings.error)} /> : null}
      </div>
      {buildingId ? (
        <div className="space-y-1">
          <Label htmlFor="room-picker-filter">Filter by room number</Label>
          <Input
            id="room-picker-filter"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={32}
            autoComplete="off"
          />
          {rooms.isError ? (
            <InlineError message={describeApiError(rooms.error)} />
          ) : current.length === 0 && (rooms.isLoading || rooms.isFetching) ? (
            <p className="text-xs text-gray-500">Loading rooms...</p>
          ) : current.length === 0 ? (
            <p className="text-xs text-gray-500">
              {status === "AVAILABLE" ? "No available rooms in this building." : "No rooms in this building."}
            </p>
          ) : visible.length === 0 ? (
            <p className="text-xs text-gray-500">
              {hasMore ? "No loaded room matches. Load more rooms." : "No room matches."}
            </p>
          ) : (
            <ul role="listbox" aria-label="Rooms" className="max-h-48 overflow-auto rounded-md border border-gray-200 divide-y">
              {visible.map((r) => {
                const disabled = (disableFull && r.occupancy.available === 0) || r.id === disabledRoomId;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={r.id === value}
                      disabled={disabled}
                      onClick={() => onChange(r.id)}
                      className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 ${
                        r.id === value ? "bg-primary-50 font-medium" : ""
                      }`}
                    >
                      {r.roomNumber} ({r.occupancy.available} free of {r.occupancy.capacity})
                      {r.id === disabledRoomId ? ", current room" : ""}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {hasMore ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={rooms.isFetching}
              onClick={() => setPageState({ key, page: page + 1 })}
            >
              {rooms.isFetching ? "Loading..." : "Load more rooms"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
