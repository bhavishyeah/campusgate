"use client";

import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CopyFormDialog } from "@/components/library/CopyFormDialog";
import { ReasonDialog } from "@/components/library/ReasonDialog";
import { useMarkCopyDamaged, useWithdrawCopy } from "@/features/library/hooks";
import type { BookCopy } from "@/features/library/types";

/**
 * Per-copy actions. Labels name what the endpoint does: "Withdraw copy" sets
 * WITHDRAWN, "Mark damaged" sets DAMAGED. Every item is gated on books.manage.
 */
export function CopyActionsMenu({ copy, titleId }: { copy: BookCopy; titleId: string }) {
  const [edit, setEdit] = useState(false);
  const [damaged, setDamaged] = useState(false);
  const [withdraw, setWithdraw] = useState(false);
  const withdrawMut = useWithdrawCopy(titleId);
  const damagedMut = useMarkCopyDamaged(titleId);

  const onLoan = copy.status === "ISSUED";
  const showWithdraw = copy.status !== "WITHDRAWN";
  const showDamaged = !["DAMAGED", "WITHDRAWN", "LOST"].includes(copy.status);

  return (
    <Can permission="library.books.manage">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={`Actions for copy ${copy.accessionNumber}`}>
            <MoreHorizontal className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEdit(true)}>Edit details</DropdownMenuItem>
          {showDamaged ? (
            <DropdownMenuItem disabled={onLoan} onSelect={() => setDamaged(true)}>
              Mark damaged{onLoan ? " (on an active loan)" : ""}
            </DropdownMenuItem>
          ) : null}
          {showWithdraw ? (
            <DropdownMenuItem disabled={onLoan} onSelect={() => setWithdraw(true)}>
              Withdraw copy{onLoan ? " (on an active loan)" : ""}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {edit ? <CopyFormDialog open onOpenChange={setEdit} titleId={titleId} copy={copy} /> : null}
      <ReasonDialog
        open={damaged}
        onOpenChange={setDamaged}
        title={`Mark copy ${copy.accessionNumber} as damaged`}
        description="Sets the copy status to Damaged."
        confirmLabel="Mark damaged"
        pending={damagedMut.isPending}
        onConfirm={async (note) => {
          await damagedMut.mutateAsync({ id: copy.id, note: note || undefined });
          toast.success("Copy marked damaged.");
        }}
      />
      <ReasonDialog
        open={withdraw}
        onOpenChange={setWithdraw}
        title={`Withdraw copy ${copy.accessionNumber}`}
        description="Sets the copy status to Withdrawn. It can no longer be issued."
        confirmLabel="Withdraw copy"
        destructive
        hideField
        pending={withdrawMut.isPending}
        onConfirm={async () => {
          await withdrawMut.mutateAsync(copy.id);
          toast.success("Copy withdrawn.");
        }}
      />
    </Can>
  );
}
