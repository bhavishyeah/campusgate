"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { InlineError } from "@/components/ui-ext/InlineError";
import { useSetInstitutionStatus } from "@/features/platform/hooks";
import { platformKeys } from "@/features/platform/keys";
import type { InstitutionRow } from "@/features/platform/types";
import { describeApiError } from "@/lib/apiErrors";

/**
 * Confirm suspend/activate for an institution. Suspend warns that the
 * institution's users immediately lose access; activate is the symmetric
 * restore. Cancel issues no request.
 */
export function InstitutionStatusConfirm({
  open,
  institution,
  onOpenChange,
}: {
  open: boolean;
  institution: InstitutionRow;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const setStatus = useSetInstitutionStatus(institution.id);
  const suspending = institution.status === "ACTIVE";
  const nextStatus = suspending ? "SUSPENDED" : "ACTIVE";

  const onConfirm = () => {
    setStatus.mutate(
      { status: nextStatus },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: platformKeys.institutions() });
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <ConfirmDialog
      open={open}
      title={
        suspending
          ? `Suspend ${institution.name}?`
          : `Activate ${institution.name}?`
      }
      description={
        suspending
          ? `All of ${institution.name}'s users will immediately lose access until it is reactivated.`
          : `${institution.name}'s users will regain access immediately.`
      }
      confirmLabel={suspending ? "Suspend" : "Activate"}
      destructive={suspending}
      pending={setStatus.isPending}
      onConfirm={onConfirm}
      onOpenChange={(next) => {
        if (!next) setStatus.reset();
        onOpenChange(next);
      }}
    >
      {setStatus.isError && (
        <InlineError message={describeApiError(setStatus.error)} />
      )}
    </ConfirmDialog>
  );
}
