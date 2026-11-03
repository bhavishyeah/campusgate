"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { LayoutGrid, Plus } from "lucide-react";
import Link from "next/link";
import { RouteGuard } from "@/components/auth/RouteGuard";
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ApiError } from "@/lib/api";
import {
  useSections,
  useCreateSection,
  useUpdateSection,
  type CreateSectionBody,
  type PatchSectionBody,
} from "@/features/classes/hooks";
import type { ClassSection, SectionStatus } from "@/features/classes/types";
import {
  createSectionSchema,
  editSectionSchema,
  type CreateSectionInput,
  type EditSectionInput,
} from "@/features/classes/formSchemas";

const STATUS_VARIANT: Record<SectionStatus, "outline" | "default" | "secondary" | "destructive"> = {
  PLANNED: "outline",
  ACTIVE: "default",
  CLOSED: "secondary",
  CANCELLED: "destructive",
};

const STATUS_TABS = ["ALL", "PLANNED", "ACTIVE", "CLOSED", "CANCELLED"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

export default function ClassSectionsPage() {
  return (
    <RouteGuard>
      <ClassSectionsInner />
    </RouteGuard>
  );
}

function ClassSectionsInner() {
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ClassSection | null>(null);
  const [statusTab, setStatusTab] = useState<StatusTab>("ALL");

  const { data, isLoading, isError, error } = useSections();

  const filtered =
    !data?.sections
      ? []
      : statusTab === "ALL"
        ? data.sections
        : data.sections.filter((s) => s.status === statusTab);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Class Sections</h1>
          <p className="text-sm text-gray-500">Manage class sections across programs and terms.</p>
        </div>
        <Can anyOf={["classes.sections.manage"]}>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Create
          </Button>
        </Can>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setStatusTab(tab)}
            className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
              statusTab === tab
                ? "bg-primary-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {tab === "ALL" ? "All" : tab.charAt(0) + tab.slice(1).toLowerCase()}
          </button>
        ))}
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
            error instanceof ApiError ? error.message : "Failed to load class sections."
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={LayoutGrid} label="No sections yet" description="Create a class section to begin." />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Program ID</TableHead>
                <TableHead>Session ID</TableHead>
                <TableHead>Term ID</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Capacity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((section) => (
                <TableRow key={section.id}>
                  <TableCell className="font-mono text-xs">{section.programId}</TableCell>
                  <TableCell className="font-mono text-xs">{section.academicSessionId}</TableCell>
                  <TableCell className="font-mono text-xs">{section.academicTermId}</TableCell>
                  <TableCell>{section.label ?? "—"}</TableCell>
                  <TableCell>{section.capacity ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[section.status] ?? "outline"}>
                      {section.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/classes/sections/${section.id}`}>View</Link>
                      </Button>
                      <Can permission="classes.sections.manage">
                        <Button variant="ghost" size="sm" onClick={() => setEditTarget(section)}>
                          Edit
                        </Button>
                      </Can>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateSectionDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editTarget && (
        <EditSectionDialog
          section={editTarget}
          open={editTarget !== null}
          onOpenChange={(v) => { if (!v) setEditTarget(null); }}
        />
      )}
    </div>
  );
}

function CreateSectionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const createMutation = useCreateSection();
  const form = useForm<CreateSectionInput>({
    resolver: zodResolver(createSectionSchema),
    defaultValues: {
      programId: "",
      academicSessionId: "",
      academicTermId: "",
      label: "",
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const body: CreateSectionBody = {
      programId: values.programId,
      academicSessionId: values.academicSessionId,
      academicTermId: values.academicTermId,
      label: values.label || undefined,
      capacity: values.capacity,
      status: values.status,
    };
    createMutation.mutate(body, {
      onSuccess: () => {
        toast.success("Section created.");
        form.reset();
        onOpenChange(false);
      },
      onError: (err) => {
        if (err instanceof ApiError) {
          if (err.status === 409) {
            form.setError("root", {
              message: "A section for this program, session, and term already exists.",
            });
          } else if (err.status === 404) {
            const msg: string = err.data?.error ?? "";
            if (msg.toLowerCase().includes("program")) {
              form.setError("programId", { message: msg });
            } else {
              form.setError("academicTermId", { message: msg });
            }
          }
        }
      },
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create class section</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="programId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Program ID</FormLabel>
                  <FormControl><Input placeholder="Program ID" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="academicSessionId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Academic Session ID</FormLabel>
                  <FormControl><Input placeholder="Session ID" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="academicTermId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Academic Term ID</FormLabel>
                  <FormControl><Input placeholder="Term ID" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Label (optional)</FormLabel>
                  <FormControl><Input placeholder="e.g. Section A" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="capacity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Capacity (optional)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder="e.g. 30"
                      {...field}
                      value={field.value ?? ""}
                      onChange={(e) => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
                    />
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
                  <FormLabel>Status (optional)</FormLabel>
                  <Select value={field.value ?? ""} onValueChange={(v) => field.onChange(v || undefined)}>
                    <FormControl>
                      <SelectTrigger><SelectValue placeholder="Select status" /></SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="PLANNED">Planned</SelectItem>
                      <SelectItem value="ACTIVE">Active</SelectItem>
                      <SelectItem value="CLOSED">Closed</SelectItem>
                      <SelectItem value="CANCELLED">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {form.formState.errors.root && (
              <p className="text-sm text-destructive">{form.formState.errors.root.message}</p>
            )}
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

function EditSectionDialog({
  section,
  open,
  onOpenChange,
}: {
  section: ClassSection;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const updateMutation = useUpdateSection(section.id);
  const form = useForm<EditSectionInput>({
    resolver: zodResolver(editSectionSchema),
    defaultValues: {
      label: section.label ?? "",
      capacity: section.capacity ?? undefined,
      status: section.status,
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const body: PatchSectionBody = {
      label: values.label || undefined,
      capacity: values.capacity,
      status: values.status,
    };
    updateMutation.mutate(body, {
      onSuccess: () => {
        toast.success("Section updated.");
        form.reset();
        onOpenChange(false);
      },
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit section</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Label</FormLabel>
                  <FormControl><Input placeholder="e.g. Section A" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="capacity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Capacity</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder="e.g. 30"
                      {...field}
                      value={field.value ?? ""}
                      onChange={(e) => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
                    />
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
                  <Select value={field.value ?? ""} onValueChange={(v) => field.onChange(v || undefined)}>
                    <FormControl>
                      <SelectTrigger><SelectValue placeholder="Select status" /></SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="PLANNED">Planned</SelectItem>
                      <SelectItem value="ACTIVE">Active</SelectItem>
                      <SelectItem value="CLOSED">Closed</SelectItem>
                      <SelectItem value="CANCELLED">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
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
