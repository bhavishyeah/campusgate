"use client";

import { useState } from "react";
import { AlertTriangle, Blocks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import {
  useGrantModule,
  useModuleMatrix,
  useRevokeModule,
} from "@/features/platform/hooks";
import type { ModuleMatrixRow } from "@/features/platform/types";
import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";

type ModuleNotice =
  | { kind: "blocking"; moduleKey: string; dependents: string[] }
  | { kind: "affected"; moduleKey: string; dependents: string[] };

/**
 * Entitlement matrix for one institution. Every catalogue module is rendered,
 * including NOT_ENTITLED rows, each with a grant/revoke toggle. A revoke 409
 * surfaces its blockingDependents inline and does NOT flip the row; a revoke
 * success with warnings.affectedDependents shows a non-blocking notice.
 */
export function ModuleMatrix({ institutionId }: { institutionId: string }) {
  const matrix = useModuleMatrix(institutionId);
  const grant = useGrantModule(institutionId);
  const revoke = useRevokeModule(institutionId);
  const [notice, setNotice] = useState<ModuleNotice | null>(null);
  const [error, setError] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<ModuleMatrixRow | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  if (matrix.isLoading) return <Skeleton className="h-40 w-full" />;
  if (matrix.isError) return <InlineError message={describeApiError(matrix.error)} />;
  if (!matrix.data || matrix.data.modules.length === 0) {
    return <EmptyState icon={Blocks} label="No modules in the catalogue." />;
  }

  const onGrant = (row: ModuleMatrixRow) => {
    setError("");
    setNotice(null);
    setBusyKey(row.moduleKey);
    grant.mutate(
      { moduleKey: row.moduleKey },
      {
        onSettled: () => setBusyKey(null),
        onError: (err) => setError(describeApiError(err)),
      },
    );
  };

  const onRevokeConfirm = () => {
    if (!revokeTarget) return;
    const row = revokeTarget;
    setError("");
    setNotice(null);
    setBusyKey(row.moduleKey);
    revoke.mutate(
      { moduleKey: row.moduleKey },
      {
        onSettled: () => setBusyKey(null),
        onSuccess: (res) => {
          setRevokeTarget(null);
          // The hook's return type omits `warnings`; read it defensively.
          const warnings = (res as { warnings?: { affectedDependents?: string[] } })
            .warnings;
          const affected = warnings?.affectedDependents ?? [];
          if (affected.length > 0) {
            setNotice({
              kind: "affected",
              moduleKey: row.moduleKey,
              dependents: affected,
            });
          }
        },
        onError: (err) => {
          setRevokeTarget(null);
          // 409 blocking: list the dependents, do NOT flip state.
          if (
            err instanceof ApiError &&
            err.status === 409 &&
            err.data?.error === "Module has active or suspended dependents"
          ) {
            const dependents: string[] = Array.isArray(err.data?.blockingDependents)
              ? err.data.blockingDependents
              : [];
            setNotice({ kind: "blocking", moduleKey: row.moduleKey, dependents });
            return;
          }
          // 400 "Unknown moduleKey" / 404 surfaced verbatim.
          setError(describeApiError(err));
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      {error && <InlineError message={error} />}
      {notice?.kind === "blocking" && (
        <div
          role="alert"
          className="rounded-lg border border-danger-500 bg-danger-50 px-4 py-3 text-sm text-danger-700"
        >
          <p className="font-medium">
            Can&apos;t revoke {notice.moduleKey}: it has active or suspended
            dependents.
          </p>
          {notice.dependents.length > 0 && (
            <p className="mt-1">Blocking dependents: {notice.dependents.join(", ")}</p>
          )}
        </div>
      )}
      {notice?.kind === "affected" && (
        <div className="flex items-start gap-2 rounded-lg bg-warning-50 px-4 py-3 text-sm text-warning-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Revoked {notice.moduleKey}. Affected dependents:{" "}
            {notice.dependents.join(", ")}.
          </span>
        </div>
      )}

      <div className="card p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Module</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {matrix.data.modules.map((row) => {
              const entitled = row.state !== "NOT_ENTITLED";
              const busy = busyKey === row.moduleKey;
              return (
                <TableRow key={row.moduleKey}>
                  <TableCell className="font-medium text-gray-900">
                    {row.name}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.moduleKey}</TableCell>
                  <TableCell>
                    <Badge variant={entitled ? "default" : "outline"}>
                      {row.state}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {entitled ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busy}
                        onClick={() => setRevokeTarget(row)}
                      >
                        Revoke
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => onGrant(row)}
                      >
                        Grant
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {revokeTarget && (
        <ConfirmDialog
          open
          title={`Revoke ${revokeTarget.name}?`}
          description={`Revoking the ${revokeTarget.moduleKey} entitlement removes it from this institution. Dependent modules will be warned.`}
          confirmLabel="Revoke"
          destructive
          pending={revoke.isPending}
          onConfirm={onRevokeConfirm}
          onOpenChange={(next) => {
            if (!next) setRevokeTarget(null);
          }}
        />
      )}
    </div>
  );
}
