"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { ClipboardCheck } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { InlineError } from "@/components/ui-ext/InlineError";
import { INVENTORY_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { AuditLineDialog } from "@/components/inventory/AuditLineDialog";
import { useCloseAudit } from "@/features/inventory/hooks";
import { appendAuditLine, closeAuditSession, readAuditSession } from "@/features/inventory/auditState";
import { discrepancy } from "@/features/inventory/format";
import { describeApiError } from "@/lib/apiErrors";
import { readIdParam } from "@/lib/paging";
import { can } from "@/lib/authz";
import { useAuthStore } from "@/stores/auth";
import type { AuditLine, AuditSession } from "@/features/inventory/types";

export default function AuditDetailPage() {
  return (
    <RouteGuard requirePermission="inventory.view">
      <AuditDetailInner />
    </RouteGuard>
  );
}

function AuditDetailInner() {
  const params = useParams<{ id: string }>();
  const id = readIdParam(params.id) ?? "";
  const perms = useAuthStore((s) => s.permissions);
  const allowed = can("inventory.view", perms);

  const [session, setSession] = useState<AuditSession | null>(null);
  const [lines, setLines] = useState<AuditLine[]>([]);
  const [hasState, setHasState] = useState<boolean | null>(null);
  const [lineOpen, setLineOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const closeAudit = useCloseAudit(id, { toast: false });

  useEffect(() => {
    const stored = readAuditSession(id);
    if (stored) {
      setSession(stored.session);
      setLines(stored.lines);
      setHasState(true);
    } else {
      setHasState(false);
    }
  }, [id]);

  async function onClose() {
    setCloseError(null);
    try {
      await closeAudit.mutateAsync();
      const next = closeAuditSession(id);
      if (next) setSession(next.session);
      toast.success("Session closed");
      setCloseOpen(false);
    } catch (err) {
      setCloseError(describeApiError(err));
    }
  }

  const open = session?.status === "OPEN";

  return (
    <div className="space-y-6">
      <SectionNav items={INVENTORY_STAFF_NAV} />
      {!allowed ? (
        <NoAccess what="this audit session" />
      ) : hasState === false || !session ? (
        <EmptyState
          icon={ClipboardCheck}
          label="Open a stock-take session to add lines."
          action={
            <Link href="/inventory/audits" className="text-sm text-primary-600 underline">
              Back to audits
            </Link>
          }
        />
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <h1 className="text-2xl font-semibold text-gray-900">{session.name}</h1>
                <p className="text-sm text-gray-500">Status: {session.status === "OPEN" ? "Open" : "Closed"}</p>
              </div>
              {open ? (
                <Can permission="inventory.audits.manage">
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setLineOpen(true)}>
                      Add line
                    </Button>
                    <Button variant="destructive" onClick={() => setCloseOpen(true)}>
                      Close session
                    </Button>
                  </div>
                </Can>
              ) : null}
            </CardContent>
          </Card>

          <div>
            <h2 className="text-lg font-semibold text-gray-900">Lines</h2>
            {lines.length === 0 ? (
              <p className="text-sm text-gray-500">No lines added yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Expected</TableHead>
                    <TableHead>Found</TableHead>
                    <TableHead>Discrepancy</TableHead>
                    <TableHead>Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>{l.assetId ? `Asset ${l.assetId}` : `Stock ${l.stockItemId}`}</TableCell>
                      <TableCell>{l.expectedQuantity ?? "-"}</TableCell>
                      <TableCell>{l.foundQuantity ?? "-"}</TableCell>
                      <TableCell>{discrepancy(l) ?? "-"}</TableCell>
                      <TableCell>{l.note ?? "-"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <Can permission="inventory.audits.manage">
            {lineOpen ? (
              <AuditLineDialog
                open
                onOpenChange={setLineOpen}
                sessionId={id}
                onAdded={(line) => {
                  const next = appendAuditLine(id, line);
                  if (next) setLines(next.lines);
                }}
              />
            ) : null}
            <ConfirmDialog
              open={closeOpen}
              title="Close session"
              description="Closing is final; no more lines can be added."
              confirmLabel="Close session"
              destructive
              pending={closeAudit.isPending}
              onConfirm={() => void onClose()}
              onOpenChange={setCloseOpen}
            >
              {closeError ? <InlineError message={closeError} /> : null}
            </ConfirmDialog>
          </Can>
        </>
      )}
    </div>
  );
}
