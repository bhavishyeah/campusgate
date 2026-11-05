"use client";

import { useState } from "react";
import { LifeBuoy } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { useRevokeSupportGrant } from "@/features/platform/hooks";
import { platformKeys } from "@/features/platform/keys";
import type { SupportGrant, SupportGrantStatus } from "@/features/platform/types";
import { describeApiError } from "@/lib/apiErrors";

const STATUS_VARIANT: Record<
  SupportGrantStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  REQUESTED: "secondary",
  ACTIVE: "default",
  EXPIRED: "outline",
  REVOKED: "destructive",
};

function RevokeButton({ grant }: { grant: SupportGrant }) {
  const qc = useQueryClient();
  const revoke = useRevokeSupportGrant(grant.id);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const onConfirm = () => {
    revoke.mutate(undefined, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: platformKeys.grants() });
        setOpen(false);
      },
    });
  };

  const revocable = grant.status === "ACTIVE" || grant.status === "REQUESTED";

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        disabled={!revocable}
        onClick={() => setOpen(true)}
      >
        Revoke
      </Button>
      <ConfirmDialog
        open={open}
        title="Revoke support grant?"
        description="This ends the break-glass access immediately. The grant stays in the audit trail."
        confirmLabel="Revoke grant"
        destructive
        pending={revoke.isPending}
        onConfirm={onConfirm}
        onOpenChange={(next) => {
          if (!next) {
            revoke.reset();
            setReason("");
          }
          setOpen(next);
        }}
      >
        <div className="space-y-1">
          <Label htmlFor={`revoke-reason-${grant.id}`}>Reason (optional)</Label>
          <Textarea
            id={`revoke-reason-${grant.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Noted locally for your records."
          />
        </div>
        {revoke.isError && <InlineError message={describeApiError(revoke.error)} />}
      </ConfirmDialog>
    </>
  );
}

/**
 * Table of support grants with a confirm-gated revoke per row. Shows an empty
 * state when there are none.
 */
export function GrantList({
  grants,
  isLoading,
  isError,
  error,
}: {
  grants: SupportGrant[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}) {
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (isError) return <InlineError message={describeApiError(error)} />;
  if (!grants || grants.length === 0) {
    return (
      <EmptyState
        icon={LifeBuoy}
        label="No support grants."
        description="Grants you create appear here."
      />
    );
  }

  return (
    <div className="card p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Institution</TableHead>
            <TableHead>Purpose</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Expires at</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {grants.map((grant) => (
            <TableRow key={grant.id}>
              <TableCell className="font-mono text-xs">
                {grant.institutionId}
              </TableCell>
              <TableCell className="max-w-xs truncate">{grant.purpose}</TableCell>
              <TableCell>
                <Badge variant={STATUS_VARIANT[grant.status]}>{grant.status}</Badge>
              </TableCell>
              <TableCell className="text-xs">
                {new Date(grant.expiresAt).toLocaleString()}
              </TableCell>
              <TableCell className="text-right">
                <RevokeButton grant={grant} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
