"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { DOCUMENTS_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { StatusBadge } from "@/components/documents/StatusBadge";
import { UploadDialog } from "@/components/documents/UploadDialog";
import { PAGE_SIZE, useDocuments, useRetentionPolicies } from "@/features/documents/hooks";
import { DOC_STATUS_LABEL } from "@/features/documents/labels";
import type { DocStatus } from "@/features/documents/types";
import { can } from "@/lib/authz";
import { readIdParam } from "@/lib/paging";
import { useAuthStore } from "@/stores/auth";

const VALID_STATUS = new Set<DocStatus>(["ACTIVE", "ARCHIVED", "PURGE_PENDING", "PURGED"]);
const STATUS_OPTIONS = (Object.keys(DOC_STATUS_LABEL) as DocStatus[]).map((s) => ({
  value: s,
  label: DOC_STATUS_LABEL[s],
}));

export default function DocumentsPage() {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <DocumentsInner />
    </Suspense>
  );
}

function DocumentsInner() {
  const perms = useAuthStore((s) => s.permissions);
  const allowed = can("documents.view_own", perms) || can("documents.admin.view_all", perms);
  const isAdmin = can("documents.admin.view_all", perms);
  const params = useSearchParams();

  const [status, setStatus] = useState<string>(() => {
    const s = params.get("status") ?? "";
    return VALID_STATUS.has(s as DocStatus) ? s : "";
  });
  const [scope, setScope] = useState<string>(() => (params.get("scope") === "mine" ? "mine" : ""));
  const [ownerUserId, setOwnerUserId] = useState<string>(() => readIdParam(params.get("ownerUserId")) ?? "");
  const [category, setCategory] = useState<string>(() => params.get("category")?.slice(0, 120) ?? "");
  const [page, setPage] = useState(1);
  const [uploadOpen, setUploadOpen] = useState(false);

  const policies = useRetentionPolicies();
  const list = useDocuments({
    status: status || undefined,
    scope: scope === "mine" ? "mine" : undefined,
    ownerUserId: ownerUserId || undefined,
    category: category || undefined,
    page,
  });
  const filtered = Boolean(status || scope || ownerUserId || category);
  const canUpload = can("documents.upload_own", perms);

  if (!allowed) {
    return (
      <div className="space-y-6">
        <NoAccess what="documents" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionNav items={DOCUMENTS_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Documents</h1>
          <p className="text-sm text-gray-500">
            {isAdmin ? "All institution documents." : "Documents you own or have been granted."}
          </p>
        </div>
        {canUpload ? <Button onClick={() => setUploadOpen(true)}>Upload document</Button> : null}
      </div>

      {isAdmin ? (
        <div className="flex flex-wrap gap-3">
          <div className="w-48">
            <SimpleSelect
              ariaLabel="Scope"
              value={scope}
              onChange={(v) => {
                setScope(v);
                setPage(1);
              }}
              noneLabel="All documents"
              placeholder="Scope"
              options={[{ value: "mine", label: "Only mine" }]}
            />
          </div>
          <div className="w-48">
            <SimpleSelect
              ariaLabel="Status"
              value={status}
              onChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
              noneLabel="Active only"
              placeholder="Status"
              options={STATUS_OPTIONS}
            />
          </div>
          <div className="w-56">
            <Label htmlFor="documents-owner" className="sr-only">
              Owner user id
            </Label>
            <Input
              id="documents-owner"
              placeholder="Owner user id"
              value={ownerUserId}
              maxLength={64}
              onChange={(e) => {
                setOwnerUserId(e.target.value.trim());
                setPage(1);
              }}
            />
          </div>
          <div className="w-56">
            <Label htmlFor="documents-category" className="sr-only">
              Category
            </Label>
            <Input
              id="documents-category"
              placeholder="Category"
              value={category}
              maxLength={120}
              onChange={(e) => {
                setCategory(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>
      ) : null}

      {list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.data.length === 0 ? (
        <EmptyState icon={FileText} label={filtered ? "No documents match these filters." : "No documents yet."} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.data.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.title}</TableCell>
                  <TableCell>{d.category ?? "-"}</TableCell>
                  <TableCell>
                    <StatusBadge status={d.status} />
                  </TableCell>
                  <TableCell>{new Date(d.updatedAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Link href={`/documents/${d.id}`} className="text-sm text-primary-600 underline">
                        Open
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination page={list.data.page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      )}

      {canUpload && uploadOpen ? (
        <UploadDialog open onOpenChange={setUploadOpen} policies={policies.data ?? []} />
      ) : null}
    </div>
  );
}
