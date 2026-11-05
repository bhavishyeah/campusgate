"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { DOCUMENTS_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { StatusBadge } from "@/components/documents/StatusBadge";
import { NewVersionDialog } from "@/components/documents/NewVersionDialog";
import { GrantFormDialog } from "@/components/documents/GrantFormDialog";
import { LifecycleActions } from "@/components/documents/LifecycleActions";
import { useDocument, useMintDownloadUrl, useRevokeGrant } from "@/features/documents/hooks";
import { canManageDocument, type AclSubject } from "@/features/documents/acl";
import { ACCESS_LEVEL_LABEL, canDownloadStatus, formatBytes } from "@/features/documents/labels";
import type { DocumentGrant } from "@/features/documents/types";
import { can } from "@/lib/authz";
import { describeApiError } from "@/lib/apiErrors";
import { readIdParam } from "@/lib/paging";
import { useAuthStore } from "@/stores/auth";

export default function DocumentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = readIdParam(params.id) ?? "";
  return <DetailInner id={id} />;
}

function DetailInner({ id }: { id: string }) {
  const perms = useAuthStore((s) => s.permissions);
  const userId = useAuthStore((s) => s.user?.id ?? "");
  const detail = useDocument(id);
  const mint = useMintDownloadUrl({ toast: false });
  const [versionDialog, setVersionDialog] = useState(false);
  const [grantDialog, setGrantDialog] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<DocumentGrant | null>(null);
  const revoke = useRevokeGrant(id, { toast: false });

  const me: AclSubject = useMemo(
    () => ({ userId, departmentScope: null, hasAdminViewAll: can("documents.admin.view_all", perms) }),
    [userId, perms],
  );

  const doc = detail.data?.doc;
  const canManage =
    doc !== undefined && can("documents.grants.manage", perms) && canManageDocument(doc, detail.data?.grants ?? [], me);
  const canRetention = can("documents.retention.manage", perms);
  const canAudit = can("documents.audit.view", perms);

  async function download(vid: string) {
    try {
      const minted = await mint.mutateAsync({ id, vid });
      window.open(minted.url, "_blank", "noopener");
    } catch (err) {
      toast.error(describeApiError(err));
    }
  }

  async function onRevoke() {
    if (!revokeTarget) return;
    try {
      await revoke.mutateAsync(revokeTarget.id);
      toast.success("Access revoked");
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setRevokeTarget(null);
    }
  }

  function granteeLabel(g: DocumentGrant): string {
    if (g.granteeUserId) return `User ${g.granteeUserId}`;
    if (g.granteeDepartmentId) return `Department ${g.granteeDepartmentId}`;
    return "-";
  }

  return (
    <div className="space-y-6">
      <SectionNav items={DOCUMENTS_STAFF_NAV} />
      {!detail.allowed ? (
        <NoAccess what="this document" />
      ) : detail.isLoading ? (
        <TableSkeleton />
      ) : detail.notFound ? (
        <NoAccess what="this document" />
      ) : detail.isError || !detail.data || !doc ? (
        <ErrorBlock error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">{doc.title}</h1>
              <div className="mt-1 flex items-center gap-2">
                <StatusBadge status={doc.status} />
                {doc.category ? <span className="text-sm text-gray-500">{doc.category}</span> : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {canManage && doc.status === "ACTIVE" ? (
                <Button size="sm" variant="outline" onClick={() => setVersionDialog(true)}>
                  Upload new version
                </Button>
              ) : null}
              {canManage ? (
                <Button size="sm" variant="outline" onClick={() => setGrantDialog(true)}>
                  Grant access
                </Button>
              ) : null}
            </div>
          </div>

          {doc.description ? (
            <Card>
              <CardContent className="p-4 text-sm text-gray-700">{doc.description}</CardContent>
            </Card>
          ) : null}

          <section>
            <h2 className="text-lg font-semibold text-gray-900">Versions</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Filename</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.data.versions.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="font-medium">
                      v{v.version}
                      {v.id === doc.currentVersionId ? (
                        <Badge variant="secondary" className="ml-2">
                          Current
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-xs truncate" title={v.filename}>
                      {v.filename}
                    </TableCell>
                    <TableCell>{formatBytes(v.sizeBytes)}</TableCell>
                    <TableCell>{new Date(v.createdAt).toLocaleString()}</TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        {canDownloadStatus(doc.status) ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={mint.isPending}
                            onClick={() => void download(v.id)}
                          >
                            Download
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          <section>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Access grants</h2>
            </div>
            {detail.data.grants.length === 0 ? (
              <p className="text-sm text-gray-500">No grants on this document.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Grantee</TableHead>
                    <TableHead>Level</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.data.grants.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell className="max-w-xs truncate" title={granteeLabel(g)}>
                        {granteeLabel(g)}
                      </TableCell>
                      <TableCell>{ACCESS_LEVEL_LABEL[g.accessLevel]}</TableCell>
                      <TableCell>
                        {g.revokedAt ? (
                          <Badge variant="outline">Revoked {new Date(g.revokedAt).toLocaleDateString()}</Badge>
                        ) : (
                          <Badge variant="default">Active</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          {canManage && !g.revokedAt ? (
                            <Button size="sm" variant="ghost" onClick={() => setRevokeTarget(g)}>
                              Revoke
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          {canRetention ? (
            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-gray-900">Lifecycle</h2>
              <LifecycleActions documentId={id} status={doc.status} />
            </section>
          ) : null}

          {canAudit ? (
            <Link href={`/documents/${id}/access-log`} className="text-sm text-primary-600 underline">
              View access log
            </Link>
          ) : null}

          {canManage && doc.status === "ACTIVE" && versionDialog ? (
            <NewVersionDialog open onOpenChange={setVersionDialog} documentId={id} />
          ) : null}
          {canManage && grantDialog ? <GrantFormDialog open onOpenChange={setGrantDialog} documentId={id} /> : null}
          <ConfirmDialog
            open={revokeTarget !== null}
            title="Revoke access"
            description={revokeTarget ? `Revoke access for ${granteeLabel(revokeTarget)}?` : ""}
            confirmLabel="Revoke"
            destructive
            pending={revoke.isPending}
            onConfirm={() => void onRevoke()}
            onOpenChange={(o) => {
              if (!o) setRevokeTarget(null);
            }}
          />
        </>
      )}
    </div>
  );
}
