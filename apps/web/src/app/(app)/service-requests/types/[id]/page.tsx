"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ListChecks } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { SERVICE_REQUESTS_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { FieldFormDialog } from "@/components/service-requests/FieldFormDialog";
import { useTypeFields, useTypes } from "@/features/service-requests/hooks";
import { fieldDefSort } from "@/features/service-requests/format";
import { fieldTypeLabel } from "@/features/service-requests/labels";
import { readIdParam } from "@/lib/paging";
import type { FieldDef } from "@/features/service-requests/types";

export default function TypeFieldsPage() {
  return (
    <RouteGuard requirePermission="service_requests.view">
      <TypeFieldsInner />
    </RouteGuard>
  );
}

function TypeFieldsInner() {
  const params = useParams<{ id: string }>();
  const id = readIdParam(params.id) ?? "";
  const types = useTypes();
  const fields = useTypeFields(id);
  const [dialog, setDialog] = useState<{ field?: FieldDef } | null>(null);
  const type = (types.data ?? []).find((t) => t.id === id);
  const sorted = fieldDefSort(fields.data ?? []);

  return (
    <div className="space-y-6">
      <SectionNav items={SERVICE_REQUESTS_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{type ? `${type.name} fields` : "Type fields"}</h1>
          <p className="text-sm text-gray-500">
            {type ? `${type.category} · ${type.code}. ` : ""}Fields are frozen once this type has requests.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/service-requests/types" className="text-sm text-primary-600 underline self-center">
            Back to types
          </Link>
          <Can permission="service_requests.types.manage">
            <Button onClick={() => setDialog({})}>Add field</Button>
          </Can>
        </div>
      </div>

      {!fields.allowed ? (
        <NoAccess what="these fields" />
      ) : fields.isLoading ? (
        <TableSkeleton />
      ) : fields.isError ? (
        <ErrorBlock error={fields.error} onRetry={() => void fields.refetch()} />
      ) : sorted.length === 0 ? (
        <EmptyState icon={ListChecks} label="No fields configured for this type." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Field key</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Required</TableHead>
              <TableHead>Options</TableHead>
              <TableHead>Sort order</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((f) => (
              <TableRow key={f.id}>
                <TableCell className="font-medium">{f.label}</TableCell>
                <TableCell>{f.fieldKey}</TableCell>
                <TableCell>{fieldTypeLabel[f.dataType] ?? f.dataType}</TableCell>
                <TableCell>{f.required ? "Yes" : "No"}</TableCell>
                <TableCell>{f.dataType === "SELECT" ? (f.options ?? []).join(", ") : "-"}</TableCell>
                <TableCell>{f.sortOrder}</TableCell>
                <TableCell>
                  <Can permission="service_requests.types.manage">
                    <div className="flex justify-end">
                      <Button size="sm" variant="outline" onClick={() => setDialog({ field: f })}>
                        Edit
                      </Button>
                    </div>
                  </Can>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Can permission="service_requests.types.manage">
        {dialog ? (
          <FieldFormDialog
            key={dialog.field?.id ?? "new"}
            open
            onOpenChange={(o) => !o && setDialog(null)}
            typeId={id}
            field={dialog.field}
          />
        ) : null}
      </Can>
    </div>
  );
}
