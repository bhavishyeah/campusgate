"use client";

import { useState } from "react";
import { FileText } from "lucide-react";
import { toast } from "sonner";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { ContractFormDialog } from "@/components/hr/ContractFormDialog";
import { HrStatusBadge } from "@/components/hr/StatusBadges";
import { useContracts, useEndContract } from "@/features/hr/hooks";
import { formatDate } from "@/features/hr/format";
import { contractTypeLabel } from "@/features/hr/labels";
import { formatSalary } from "@/features/hr/money";
import { contractActions } from "@/features/hr/transitions";
import type { Contract } from "@/features/hr/types";

function TermsView({ terms }: { terms: Record<string, unknown> }) {
  return (
    <dl className="space-y-2 text-sm">
      {Object.entries(terms).map(([k, v]) => (
        <div key={k}>
          <dt className="font-medium text-gray-700">{k}</dt>
          <dd>
            {typeof v === "object" && v !== null ? (
              <pre className="overflow-auto rounded bg-gray-50 p-2 text-xs">{JSON.stringify(v, null, 2)}</pre>
            ) : (
              String(v)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Staff contracts tab: list, add, supersede and end. */
export function ContractsPanel({ employeeId, enabled }: { employeeId: string; enabled: boolean }) {
  const contracts = useContracts(employeeId, enabled);
  const end = useEndContract(employeeId);
  const [addOpen, setAddOpen] = useState(false);
  const [superseding, setSuperseding] = useState<Contract | null>(null);
  const [ending, setEnding] = useState<Contract | null>(null);
  const [viewing, setViewing] = useState<Contract | null>(null);

  if (!contracts.allowed) return <NoAccess what="contracts" />;
  if (contracts.isLoading) return <TableSkeleton />;
  if (contracts.isError) return <ErrorBlock error={contracts.error} onRetry={() => void contracts.refetch()} />;
  const rows = contracts.data?.contracts ?? [];

  return (
    <div className="space-y-3">
      <Can permission="hr.contracts.manage">
        <div className="flex justify-end">
          <Button onClick={() => setAddOpen(true)}>Add contract</Button>
        </div>
      </Can>
      {rows.length === 0 ? (
        <EmptyState icon={FileText} label="No contracts yet" />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Start</TableHead>
                <TableHead>End</TableHead>
                <TableHead>Salary</TableHead>
                <TableHead>Terms</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{contractTypeLabel[c.contractType] ?? c.contractType}</TableCell>
                  <TableCell>
                    <HrStatusBadge kind="contract" status={c.status} />
                  </TableCell>
                  <TableCell>{formatDate(c.startDate)}</TableCell>
                  <TableCell>{formatDate(c.endDate)}</TableCell>
                  <TableCell>{formatSalary(c.salaryAmount)}</TableCell>
                  <TableCell>
                    {c.termsMetadata ? (
                      <Button variant="ghost" size="sm" onClick={() => setViewing(c)}>
                        View
                      </Button>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Can permission="hr.contracts.manage">
                      <div className="flex justify-end gap-2">
                        {contractActions(c.status).includes("SUPERSEDED") ? (
                          <Button variant="outline" size="sm" onClick={() => setSuperseding(c)}>
                            Supersede (new version)
                          </Button>
                        ) : null}
                        {contractActions(c.status).includes("ENDED") ? (
                          <Button variant="outline" size="sm" onClick={() => setEnding(c)}>
                            End contract
                          </Button>
                        ) : null}
                      </div>
                    </Can>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Contract terms</DialogTitle>
          </DialogHeader>
          {viewing?.termsMetadata ? <TermsView terms={viewing.termsMetadata} /> : null}
        </DialogContent>
      </Dialog>

      <Can permission="hr.contracts.manage">
        {addOpen ? <ContractFormDialog open onOpenChange={setAddOpen} employeeId={employeeId} /> : null}
        {superseding ? (
          <ContractFormDialog
            key={superseding.id}
            open
            onOpenChange={(o) => !o && setSuperseding(null)}
            employeeId={employeeId}
            supersede={superseding}
          />
        ) : null}
        <ConfirmDialog
          open={ending !== null}
          onOpenChange={(o) => !o && setEnding(null)}
          title="End contract"
          description="End this contract? Its status becomes Ended and this cannot be undone."
          confirmLabel="End contract"
          destructive
          pending={end.isPending}
          onConfirm={() => {
            if (!ending) return;
            end.mutate(ending.id, {
              onSuccess: () => toast.success("Contract ended."),
              onSettled: () => setEnding(null),
            });
          }}
        />
      </Can>
    </div>
  );
}
