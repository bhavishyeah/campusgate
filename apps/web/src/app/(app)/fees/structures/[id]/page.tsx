"use client";

import { use, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Layers, Plus } from "lucide-react";
import {
  PaiseAmount,
  feeComponentCategoryEnum,
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
import { formatPaise, rupeesToPaiseString } from "@/lib/money";
import {
  addComponentFormSchema,
  type AddComponentFormValues,
} from "@/features/fees/formSchemas";
import {
  useStructure,
  useStructureComponents,
  useAddComponent,
} from "@/features/fees/hooks";

const CATEGORY_OPTIONS = feeComponentCategoryEnum.options;

export default function StructureDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const structureQuery = useStructure(id);
  const componentsQuery = useStructureComponents(id);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          {structureQuery.isLoading ? (
            <Skeleton className="h-8 w-48" />
          ) : (
            <h1 className="text-2xl font-semibold text-gray-900">
              {structureQuery.data?.name ?? "Fee structure"}
            </h1>
          )}
          {structureQuery.data && (
            <div className="mt-1 flex items-center gap-2 text-sm text-gray-500">
              <Badge variant="outline">{structureQuery.data.status}</Badge>
              {structureQuery.data.description && (
                <span>{structureQuery.data.description}</span>
              )}
            </div>
          )}
        </div>
        <Can permission="fees.structures.manage">
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Add component
          </Button>
        </Can>
      </div>

      {structureQuery.isError && (
        <InlineError
          message={
            structureQuery.error instanceof ApiError
              ? structureQuery.error.message
              : "Failed to load the structure."
          }
        />
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-medium text-gray-900">Components</h2>
        {componentsQuery.isLoading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : componentsQuery.isError ? (
          <InlineError
            message={
              componentsQuery.error instanceof ApiError
                ? componentsQuery.error.message
                : "Failed to load components."
            }
          />
        ) : !componentsQuery.data ||
          componentsQuery.data.components.length === 0 ? (
          <EmptyState
            icon={Layers}
            label="No components yet"
            description="Add a component to define what this structure charges."
          />
        ) : (
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Installment</TableHead>
                  <TableHead>Due date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {componentsQuery.data.components.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.category}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPaise(c.amountPaise)}
                    </TableCell>
                    <TableCell className="text-gray-600">
                      {c.installmentLabel ??
                        (c.installmentNumber != null
                          ? `#${c.installmentNumber}`
                          : "—")}
                    </TableCell>
                    <TableCell className="text-gray-600">
                      {c.dueDate
                        ? new Date(c.dueDate).toLocaleDateString()
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <AddComponentDialog
        structureId={id}
        open={addOpen}
        onOpenChange={setAddOpen}
      />
    </div>
  );
}

function AddComponentDialog({
  structureId,
  open,
  onOpenChange,
}: {
  structureId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const addMutation = useAddComponent(structureId);
  const form = useForm<AddComponentFormValues>({
    resolver: zodResolver(addComponentFormSchema),
    defaultValues: {
      category: "TUITION",
      amountRupees: "",
      installmentLabel: "",
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    // Convert rupee string -> integer paise STRING, then assert against
    // PaiseAmount as the final money gate before POST. No float arithmetic.
    let amountPaise: string;
    try {
      amountPaise = rupeesToPaiseString(values.amountRupees);
      PaiseAmount.parse(amountPaise);
    } catch {
      form.setError("amountRupees", { message: "Enter a valid amount." });
      return;
    }
    addMutation.mutate(
      {
        category: values.category,
        amountPaise,
        dueDate: values.dueDate || undefined,
        installmentLabel: values.installmentLabel || undefined,
        installmentNumber: values.installmentNumber ?? undefined,
      },
      {
        onSuccess: () => {
          toast.success("Component added.");
          form.reset();
          onOpenChange(false);
        },
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add component</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CATEGORY_OPTIONS.map((o) => (
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
              name="amountRupees"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount (₹)</FormLabel>
                  <FormControl>
                    <Input
                      inputMode="decimal"
                      placeholder="e.g. 12500.00"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="installmentLabel"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Installment label (optional)</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={addMutation.isPending}>
                {addMutation.isPending ? "Adding…" : "Add component"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
