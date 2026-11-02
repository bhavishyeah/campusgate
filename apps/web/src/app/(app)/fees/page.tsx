"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Wallet, Plus } from "lucide-react";
import {
  createFeeStructureSchema,
  patchFeeStructureSchema,
  type CreateFeeStructureInput,
  type PatchFeeStructureInput,
} from "@campusgate/shared";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ApiError } from "@/lib/api";
import {
  useStructures,
  useCreateStructure,
  useUpdateStructure,
  type FeeStructure,
} from "@/features/fees/hooks";
import Link from "next/link";

const STATUS_OPTIONS = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;

export default function FeeStructuresPage() {
  const { data, isLoading, isError, error } = useStructures();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<FeeStructure | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Fee Structures</h1>
          <p className="text-sm text-gray-500">
            Manage fee structures and their components.
          </p>
        </div>
        <Can permission="fees.structures.manage">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Create
          </Button>
        </Can>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError ? (
        <InlineError
          message={
            error instanceof ApiError
              ? error.message
              : "Failed to load fee structures."
          }
        />
      ) : !data || data.structures.length === 0 ? (
        <EmptyState
          icon={Wallet}
          label="No fee structures yet"
          description="Create a fee structure to start posting charges."
        />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.structures.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/fees/structures/${s.id}`}
                      className="text-primary-700 hover:underline"
                    >
                      {s.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{s.status}</Badge>
                  </TableCell>
                  <TableCell className="text-gray-600">
                    {s.description ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Can permission="fees.structures.manage">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditTarget(s)}
                      >
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

      <CreateStructureDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EditStructureDialog
        target={editTarget}
        onClose={() => setEditTarget(null)}
      />
    </div>
  );
}

function CreateStructureDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const createMutation = useCreateStructure();
  const form = useForm<CreateFeeStructureInput>({
    resolver: zodResolver(createFeeStructureSchema),
    defaultValues: { name: "", status: "DRAFT", description: "" },
  });

  const onSubmit = form.handleSubmit((values) => {
    // Drop empty optional strings so the strict schema stays happy server-side.
    const body: Record<string, unknown> = { name: values.name };
    if (values.status) body.status = values.status;
    if (values.description) body.description = values.description;
    createMutation.mutate(body, {
      onSuccess: () => {
        toast.success("Fee structure created.");
        form.reset();
        onOpenChange(false);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) {
          form.setError("name", {
            message: "A structure with this name already exists.",
          });
        }
      },
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create fee structure</DialogTitle>
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
                    <Input placeholder="e.g. 2025 Tuition" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select
                    value={field.value ?? "DRAFT"}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {STATUS_OPTIONS.map((o) => (
                        <SelectItem key={o} value={o}>
                          {o}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description (optional)</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function EditStructureDialog({
  target,
  onClose,
}: {
  target: FeeStructure | null;
  onClose: () => void;
}) {
  return target ? (
    <EditStructureDialogInner key={target.id} target={target} onClose={onClose} />
  ) : null;
}

function EditStructureDialogInner({
  target,
  onClose,
}: {
  target: FeeStructure;
  onClose: () => void;
}) {
  const updateMutation = useUpdateStructure(target.id);
  const form = useForm<PatchFeeStructureInput>({
    resolver: zodResolver(patchFeeStructureSchema),
    defaultValues: {
      name: target.name,
      status: target.status as PatchFeeStructureInput["status"],
      description: target.description ?? "",
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const body: Record<string, unknown> = {};
    if (values.name !== undefined) body.name = values.name;
    if (values.status !== undefined) body.status = values.status;
    body.description = values.description ? values.description : null;
    updateMutation.mutate(body, {
      onSuccess: () => {
        toast.success("Fee structure updated.");
        onClose();
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) {
          form.setError("name", {
            message: "A structure with this name already exists.",
          });
        }
      },
    });
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit fee structure</DialogTitle>
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
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select
                    value={field.value ?? "DRAFT"}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {STATUS_OPTIONS.map((o) => (
                        <SelectItem key={o} value={o}>
                          {o}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description (optional)</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
