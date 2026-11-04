"use client";

import { useState } from "react";
import Link from "next/link";
import { Receipt, Copy as CopyIcon, Plus } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { SectionNav, LIBRARY_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { StudentPicker } from "@/components/library/StudentPicker";
import { ReasonDialog } from "@/components/library/ReasonDialog";
import { describeApiError } from "@/lib/apiErrors";
import { formatRupeeDecimal, parseRupeeInput } from "@/features/library/format";
import { LibraryStatusBadge } from "@/features/library/LibraryStatusBadge";
import { fineFormSchema, type FineFormValues } from "@/features/library/formSchemas";
import { fineReasonLabel } from "@/features/library/labels";
import { useCreateFine, useFines, usePayFine, useWaiveFine } from "@/features/library/hooks";
import type { LibraryFine, StudentSummary } from "@/features/library/types";

export default function FinesPage() {
  return (
    <RouteGuard requirePermission="library.fines.manage">
      <FinesInner />
    </RouteGuard>
  );
}

function FinesInner() {
  const [status, setStatus] = useState<string>("");
  const [createOpen, setCreateOpen] = useState(false);
  const [waiving, setWaiving] = useState<LibraryFine | null>(null);
  const [paying, setPaying] = useState<LibraryFine | null>(null);
  const fines = useFines(status || undefined);
  const waive = useWaiveFine();
  const pay = usePayFine();

  return (
    <div className="space-y-6">
      <SectionNav items={LIBRARY_STAFF_NAV} />

      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Fines</h1>
          <p className="text-sm text-gray-500">
            Amounts are in rupees. The API does not return a student name here, only the id.
          </p>
        </div>
        <Can permission="library.fines.manage">
          <Can permission="library.issue">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="w-4 h-4 mr-1" /> Add fine
            </Button>
          </Can>
        </Can>
      </div>

      <div className="max-w-[12rem]">
        <SimpleSelect
          ariaLabel="Fine status"
          value={status}
          onChange={setStatus}
          noneLabel="All"
          options={[
            { value: "PENDING", label: "Pending" },
            { value: "PAID", label: "Paid" },
            { value: "WAIVED", label: "Waived" },
          ]}
        />
      </div>

      {fines.isLoading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : fines.isError ? (
        <InlineError message={describeApiError(fines.error)} />
      ) : !fines.data || fines.data.fines.length === 0 ? (
        <EmptyState icon={Receipt} label="No fines" description="Nothing to show for this filter." />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fine</TableHead>
                <TableHead>Student</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fines.data.fines.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="font-mono text-xs">{f.id.slice(0, 8)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-xs">{f.studentId.slice(0, 8)}</span>
                      <button
                        type="button"
                        aria-label="Copy student id"
                        onClick={() => navigator.clipboard?.writeText(f.studentId)}
                      >
                        <CopyIcon className="w-3 h-3 text-gray-400" />
                      </button>
                    </div>
                    <Can permission="library.books.view">
                      <Link
                        href={`/library/circulation?studentId=${f.studentId}`}
                        className="text-xs text-primary-700 underline"
                      >
                        View loans
                      </Link>
                    </Can>
                  </TableCell>
                  <TableCell>{fineReasonLabel[f.reason]}</TableCell>
                  <TableCell className="tabular-nums">{formatRupeeDecimal(f.amount)}</TableCell>
                  <TableCell>
                    <LibraryStatusBadge kind="fine" status={f.status} />
                  </TableCell>
                  <TableCell className="text-gray-600">{f.note ?? "—"}</TableCell>
                  <TableCell>{new Date(f.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell className="text-right">
                    {f.status === "PENDING" ? (
                      <div className="flex gap-2 justify-end">
                        <Button variant="ghost" size="sm" onClick={() => setWaiving(f)}>
                          Waive
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setPaying(f)}>
                          Mark paid
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {createOpen ? <CreateFineDialog open onOpenChange={setCreateOpen} /> : null}

      {waiving ? (
        <ReasonDialog
          open
          onOpenChange={(v) => {
            if (!v) setWaiving(null);
          }}
          title="Waive fine"
          confirmLabel="Waive"
          pending={waive.isPending}
          onConfirm={async (note) => {
            await waive.mutateAsync({ id: waiving.id, note: note || undefined });
            toast.success("Fine waived.");
          }}
        />
      ) : null}
      {paying ? (
        <ReasonDialog
          open
          onOpenChange={(v) => {
            if (!v) setPaying(null);
          }}
          title="Mark fine paid"
          confirmLabel="Mark paid"
          pending={pay.isPending}
          onConfirm={async (note) => {
            await pay.mutateAsync({ id: paying.id, note: note || undefined });
            toast.success("Fine marked paid.");
          }}
        />
      ) : null}
    </div>
  );
}

function CreateFineDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const create = useCreateFine();
  const [student, setStudent] = useState<StudentSummary | null>(null);
  const form = useForm<FineFormValues>({
    resolver: zodResolver(fineFormSchema),
    defaultValues: { studentId: "", reason: "OVERDUE", amount: "", note: "" },
  });

  const onSubmit = form.handleSubmit((values) => {
    const amount = parseRupeeInput(values.amount);
    if (amount === null || !student) return;
    create.mutate(
      { studentId: student.id, reason: values.reason, amount, note: values.note.trim() || undefined },
      {
        onSuccess: () => {
          toast.success("Fine created.");
          form.reset();
          setStudent(null);
          onOpenChange(false);
        },
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add fine</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={(e) => {
              form.setValue("studentId", student?.id ?? "");
              onSubmit(e);
            }}
            className="space-y-3"
          >
            <StudentPicker value={student} onChange={setStudent} />
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason</FormLabel>
                  <SimpleSelect
                    ariaLabel="Reason"
                    value={field.value}
                    onChange={field.onChange}
                    options={Object.entries(fineReasonLabel).map(([value, label]) => ({ value, label }))}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount in rupees</FormLabel>
                  <FormControl>
                    <Input inputMode="decimal" placeholder="0.00" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note (optional)</FormLabel>
                  <FormControl><Input {...field} maxLength={2000} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={!student || create.isPending}>
                {create.isPending ? "Saving…" : "Add fine"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
