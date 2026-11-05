"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { toast } from "sonner";
import { FolderOpen } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { DOCUMENTS_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { FormDialog } from "@/components/forms/FormDialog";
import { TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import {
  useCreateRetentionPolicy,
  useRetentionPolicies,
  useUpdateRetentionPolicy,
} from "@/features/documents/hooks";
import {
  buildRetentionPolicyBody,
  retentionPolicyFormSchema,
  type RetentionPolicyValues,
} from "@/features/documents/formSchemas";
import type { RetentionPolicy } from "@/features/documents/types";

export default function RetentionPoliciesPage() {
  return (
    <RouteGuard requirePermission="documents.retention.manage">
      <RetentionInner />
    </RouteGuard>
  );
}

function RetentionInner() {
  const list = useRetentionPolicies();
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; policy: RetentionPolicy } | null>(null);

  return (
    <div className="space-y-6">
      <SectionNav items={DOCUMENTS_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Retention policies</h1>
          <p className="text-sm text-gray-500">Named retention windows that documents can be assigned to.</p>
        </div>
        <Button onClick={() => setDialog({ mode: "create" })}>New policy</Button>
      </div>

      {!list.allowed ? (
        <NoAccess what="retention policies" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.length === 0 ? (
        <EmptyState icon={FolderOpen} label="No retention policies yet." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Retention (days)</TableHead>
              <TableHead>Category</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell>{p.retentionDays}</TableCell>
                <TableCell>{p.category ?? "-"}</TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ mode: "edit", policy: p })}>
                      Edit
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {dialog?.mode === "create" ? <CreateDialog onClose={() => setDialog(null)} /> : null}
      {dialog?.mode === "edit" ? <EditDialog policy={dialog.policy} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const create = useCreateRetentionPolicy({ toast: false });
  const form = useForm<z.input<typeof retentionPolicyFormSchema>, unknown, RetentionPolicyValues>({
    resolver: zodFormResolver(retentionPolicyFormSchema),
    defaultValues: { name: "", retentionDays: "", category: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await create.mutateAsync(buildRetentionPolicyBody(values));
      toast.success("Policy created");
      onClose();
    } catch (err) {
      setError(handleServerError(err, form, { "retention policy name already exists": "name" }));
    }
  });

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New retention policy"
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Create policy"
      pending={create.isPending}
      error={error}
    >
      <TextField control={form.control} name="name" label="Name" />
      <TextField control={form.control} name="retentionDays" label="Retention days" type="number" />
      <TextField control={form.control} name="category" label="Category (optional)" />
    </FormDialog>
  );
}

function EditDialog({ policy, onClose }: { policy: RetentionPolicy; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateRetentionPolicy(policy.id, { toast: false });
  const form = useForm<z.input<typeof retentionPolicyFormSchema>, unknown, RetentionPolicyValues>({
    resolver: zodFormResolver(retentionPolicyFormSchema),
    defaultValues: {
      name: policy.name,
      retentionDays: String(policy.retentionDays),
      category: policy.category ?? "",
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await update.mutateAsync(buildRetentionPolicyBody(values));
      toast.success("Policy updated");
      onClose();
    } catch (err) {
      setError(handleServerError(err, form, { "retention policy name already exists": "name" }));
    }
  });

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit retention policy"
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Save changes"
      pending={update.isPending}
      error={error}
      disableSubmit={!form.formState.isDirty}
    >
      <TextField control={form.control} name="name" label="Name" />
      <TextField control={form.control} name="retentionDays" label="Retention days" type="number" />
      <TextField control={form.control} name="category" label="Category (optional)" />
    </FormDialog>
  );
}
