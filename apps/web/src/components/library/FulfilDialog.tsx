"use client";

import { useState } from "react";
import { PackageX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/apiErrors";
import { useFulfilReservation, useTitle } from "@/features/library/hooks";
import type { ReservationListItem } from "@/features/library/types";

/** Parks an available copy for the head of the queue ("Allot copy"). 409s render verbatim. */
export function FulfilDialog({
  reservation,
  onOpenChange,
}: {
  reservation: ReservationListItem;
  onOpenChange: (open: boolean) => void;
}) {
  const title = useTitle(reservation.bookTitleId);
  const fulfil = useFulfilReservation();
  const [copyId, setCopyId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const available = (title.data?.copies ?? []).filter((c) => c.status === "AVAILABLE");

  function submit() {
    setError(null);
    fulfil.mutate(
      { id: reservation.id, bookCopyId: copyId },
      {
        onSuccess: () => {
          toast.success("Copy allotted. The student can now collect it.");
          onOpenChange(false);
        },
        onError: (err) => setError(describeApiError(err)),
      },
    );
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Allot copy</DialogTitle>
          <DialogDescription>
            {reservation.bookTitle.title} for {reservation.student.name}. The copy is parked for pickup.
          </DialogDescription>
        </DialogHeader>
        {title.isLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : title.isError ? (
          <InlineError message={describeApiError(title.error)} />
        ) : available.length === 0 ? (
          <EmptyState icon={PackageX} label="No available copy to allot" />
        ) : (
          <SimpleSelect
            ariaLabel="Copy to allot"
            value={copyId}
            onChange={setCopyId}
            placeholder="Select an available copy"
            options={available.map((c) => ({
              value: c.id,
              label: `${c.accessionNumber}${c.shelfLocation ? `, ${c.shelfLocation}` : ""}`,
            }))}
          />
        )}
        {error ? <InlineError message={error} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={fulfil.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!copyId || available.length === 0 || fulfil.isPending}>
            {fulfil.isPending ? "Allotting…" : "Allot copy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
