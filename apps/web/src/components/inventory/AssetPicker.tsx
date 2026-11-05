"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InlineError } from "@/components/ui-ext/InlineError";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { describeApiError } from "@/lib/apiErrors";
import { useAssetOptions } from "@/features/inventory/hooks";
import { assetLabel, filterByText, mergeOptionPages } from "@/features/inventory/format";
import type { Asset } from "@/features/inventory/types";

/**
 * Asset picker: 100 per page with "Load more" so every asset is reachable, plus a
 * client-side asset-tag filter over the loaded pages (the RoomPicker precedent).
 */
export function AssetPicker({ value, onChange }: { value: string; onChange: (assetId: string) => void }) {
  const [text, setText] = useState("");
  const [page, setPage] = useState(1);
  const [loaded, setLoaded] = useState<Asset[]>([]);
  const assets = useAssetOptions(page);

  useEffect(() => {
    const data = assets.data;
    if (!data || assets.isPlaceholderData) return;
    setLoaded((prev) => mergeOptionPages(prev, data.assets));
  }, [assets.data, assets.isPlaceholderData]);

  const visible = useMemo(() => filterByText(loaded, text), [loaded, text]);
  const total = assets.data && !assets.isPlaceholderData ? assets.data.total : undefined;
  const hasMore = total !== undefined && loaded.length < total;

  if (!assets.allowed) return <NoAccess what="the asset picker" />;

  return (
    <div className="space-y-2">
      <Label htmlFor="asset-picker-filter">Filter by asset tag</Label>
      <Input
        id="asset-picker-filter"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={128}
        autoComplete="off"
      />
      {assets.isError ? (
        <InlineError message={describeApiError(assets.error)} />
      ) : loaded.length === 0 && (assets.isLoading || assets.isFetching) ? (
        <p className="text-xs text-gray-500">Loading assets...</p>
      ) : loaded.length === 0 ? (
        <p className="text-xs text-gray-500">No assets yet.</p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-gray-500">{hasMore ? "No loaded asset matches. Load more." : "No asset matches."}</p>
      ) : (
        <ul role="listbox" aria-label="Assets" className="max-h-48 overflow-auto rounded-md border border-gray-200 divide-y">
          {visible.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                role="option"
                aria-selected={a.id === value}
                onClick={() => onChange(a.id)}
                className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-50 ${a.id === value ? "bg-primary-50 font-medium" : ""}`}
              >
                {assetLabel(a)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {hasMore ? (
        <Button type="button" variant="outline" size="sm" disabled={assets.isFetching} onClick={() => setPage((p) => p + 1)}>
          {assets.isFetching ? "Loading..." : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
