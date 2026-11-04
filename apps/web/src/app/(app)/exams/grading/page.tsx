"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus, Scale } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
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
import { GradingBandEditor, bandsError } from "@/components/exams/GradingBandEditor";
import { ApiError } from "@/lib/api";
import {
  useCreateGradingScheme,
  useGradingSchemes,
  useUpdateGradingScheme,
  type GradingSchemeBody,
} from "@/features/exams/hooks";
import { EXAM_PERM } from "@/features/exams/permissions";
import {
  gradingFormSchema,
  rowsToBands,
  type GradingFormValues,
} from "@/features/exams/formSchemas";
import { bpsToPct } from "@/features/exams/gradingBands";
import type { GradingScheme } from "@/features/exams/types";

export default function GradingSchemesPage() {
  return (
    <RouteGuard requirePermission={EXAM_PERM.view}>
      <GradingSchemesInner />
    </RouteGuard>
  );
}

function GradingSchemesInner() {
  const { data, isLoading, isError, error } = useGradingSchemes();
  const [dialog, setDialog] = useState<{ editing: GradingScheme | null } | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Grading schemes</h1>
          <p className="text-sm text-gray-500">Grade bands used when results are published.</p>
        </div>
        <Can permission={EXAM_PERM.gradingManage}>
          <Button onClick={() => setDialog({ editing: null })}>
            <Plus className="w-4 h-4 mr-1" /> Create
          </Button>
        </Can>
      </div>

      {isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : isError ? (
        <InlineError
          message={error instanceof ApiError ? error.message : "Failed to load grading schemes."}
        />
      ) : !data || data.gradingSchemes.length === 0 ? (
        <EmptyState
          icon={Scale}
          label="No grading schemes yet"
          description="Create a scheme and mark it active before publishing results."
        />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Bands</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.gradingSchemes.map((g) => (
                <TableRow key={g.id}>
                  <TableCell className="font-medium">{g.name}</TableCell>
                  <TableCell>
                    <Badge variant={g.isActive ? "default" : "outline"}>
                      {g.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell>{g.bands.length}</TableCell>
                  <TableCell className="text-right">
                    <Can permission={EXAM_PERM.gradingManage}>
                      <Button variant="ghost" size="sm" onClick={() => setDialog({ editing: g })}>
                        Edit
                      </Button>
                    </Can>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {dialog && <SchemeDialog editing={dialog.editing} onClose={() => setDialog(null)} />}
    </div>
  );
}

function SchemeDialog({
  editing,
  onClose,
}: {
  editing: GradingScheme | null;
  onClose: () => void;
}) {
  const create = useCreateGradingScheme();
  const update = useUpdateGradingScheme(editing?.id ?? "");
  const form = useForm<GradingFormValues>({
    resolver: zodResolver(gradingFormSchema),
    defaultValues: {
      name: editing?.name ?? "",
      isActive: editing?.isActive ?? false,
      bands: editing
        ? [...editing.bands]
            .sort((a, b) => a.minPercentBps - b.minPercentBps)
            .map((b) => ({
              minPct: String(bpsToPct(b.minPercentBps)),
              maxPct: String(bpsToPct(b.maxPercentBps)),
              gradeLabel: b.gradeLabel,
              gradePoints: String(b.gradePoints),
              isPassing: b.isPassing,
            }))
        : [{ minPct: "0", maxPct: "100", gradeLabel: "", gradePoints: "0", isPassing: true }],
    },
  });

  const watchedBands = form.watch("bands");
  const invalid = bandsError(watchedBands) !== null;
  const pending = create.isPending || update.isPending;

  const onSubmit = form.handleSubmit((v) => {
    const body: GradingSchemeBody = {
      name: v.name,
      isActive: v.isActive,
      bands: rowsToBands(v.bands),
    };
    const handlers = {
      onSuccess: () => {
        toast.success(editing ? "Grading scheme updated." : "Grading scheme created.");
        onClose();
      },
      onError: (err: ApiError) => {
        if (err.status === 409) form.setError("name", { message: err.message });
        else toast.error(err.message);
      },
    };
    if (editing) update.mutate(body, handlers);
    else create.mutate(body, handlers);
  });

  const isActive = form.watch("isActive");

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit grading scheme" : "Create grading scheme"}</DialogTitle>
          <DialogDescription>
            Bands must cover 0% to 100% with no gaps or overlaps.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="isActive"
              render={({ field }) => (
                <FormItem>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={field.value}
                      onChange={(e) => field.onChange(e.target.checked)}
                    />
                    Active
                  </label>
                  {isActive && (
                    <p className="text-xs text-amber-700">
                      Activating this scheme deactivates any other active scheme.
                    </p>
                  )}
                </FormItem>
              )}
            />
            <GradingBandEditor control={form.control} />
            <DialogFooter>
              <Button type="submit" disabled={pending || invalid}>
                {pending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
