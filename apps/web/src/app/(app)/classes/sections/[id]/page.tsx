"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Users } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ApiError } from "@/lib/api";
import {
  useSection,
  useTimetables,
  useAssignFaculty,
  type AssignFacultyBody,
} from "@/features/classes/hooks";
import {
  assignFacultySchema,
  type AssignFacultyInput,
} from "@/features/classes/formSchemas";

// Maps error kind from API message "faculty not found" → form field name
const KIND_TO_FIELD: Record<string, keyof AssignFacultyInput> = {
  faculty:    "facultyId",
  subject:    "subjectId",
  term:       "academicTermId",
  section:    "classSectionId",
  assignment: "replacesAssignmentId",
};

export default function SectionDetailPage() {
  return (
    <RouteGuard>
      <SectionDetailInner />
    </RouteGuard>
  );
}

function SectionDetailInner() {
  const params = useParams();
  const id = Array.isArray(params.id) ? params.id[0] : params.id ?? "";
  const [assignOpen, setAssignOpen] = useState(false);

  const { data: section, isLoading, isError, error } = useSection(id);
  const { data: timetablesData } = useTimetables();

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
    );
  }

  if (isError) {
    return (
      <InlineError
        message={error instanceof ApiError ? error.message : "Failed to load section."}
      />
    );
  }

  if (!section) return null;

  // Faculty: derived from timetable scheduled classes for this section (API gap §4.3)
  const scheduledForSection = (timetablesData?.timetables ?? []).flatMap(
    (t) => (t.scheduledClasses ?? []).filter((sc) => sc.classSectionId === section.id),
  );

  // Timetables for this section's term
  const termTimetables = (timetablesData?.timetables ?? []).filter(
    (t) => t.academicTermId === section.academicTermId,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-semibold text-gray-900">
          {section.label ?? "Section"}
        </h1>
        <Badge>{section.status}</Badge>
      </div>

      <Tabs defaultValue="enrollments">
        <TabsList>
          <TabsTrigger value="enrollments">Enrollments</TabsTrigger>
          <TabsTrigger value="faculty">Faculty</TabsTrigger>
          <TabsTrigger value="timetable">Timetable</TabsTrigger>
        </TabsList>

        {/* Enrollments Tab */}
        <TabsContent value="enrollments" className="space-y-4">
          <p className="text-sm text-gray-500">
            {section.enrollments?.length ?? 0} enrolled student(s)
          </p>
          {!section.enrollments || section.enrollments.length === 0 ? (
            <EmptyState icon={Users} label="No enrollments" description="No students are enrolled in this section yet." />
          ) : (
            <div className="card p-0 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Student ID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Enrolled At</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {section.enrollments.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="font-mono text-xs">{e.studentId}</TableCell>
                      <TableCell>{e.status}</TableCell>
                      <TableCell className="text-gray-600">{e.enrolledAt}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* Faculty Tab */}
        <TabsContent value="faculty" className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500">Faculty shown from timetable scheduled classes.</p>
            {/* MF5: use only classes.faculty.assign permission */}
            <Can permission="classes.faculty.assign">
              <Button size="sm" onClick={() => setAssignOpen(true)}>Assign Faculty</Button>
            </Can>
          </div>
          {scheduledForSection.length === 0 ? (
            <EmptyState
              icon={Users}
              label="No scheduled classes"
              description="No faculty found in timetable for this section."
            />
          ) : (
            <div className="card p-0 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subject ID</TableHead>
                    <TableHead>Faculty ID</TableHead>
                    <TableHead>Room</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scheduledForSection.map((sc) => (
                    <TableRow key={sc.id}>
                      <TableCell className="font-mono text-xs">{sc.subjectId}</TableCell>
                      <TableCell className="font-mono text-xs">{sc.facultyId}</TableCell>
                      <TableCell>{sc.room ?? "—"}</TableCell>
                      <TableCell>{sc.period ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={sc.status === "CANCELLED" ? "destructive" : "outline"}>
                          {sc.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* Timetable Tab */}
        <TabsContent value="timetable" className="space-y-4">
          <Can anyOf={["classes.view", "classes.timetable.manage"]}>
            {termTimetables.length === 0 ? (
              <EmptyState
                icon={Users}
                label="No timetables"
                description="No timetables found for this section's term."
              />
            ) : (
              <div className="card p-0 overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {termTimetables.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="font-medium">{t.name}</TableCell>
                        <TableCell>
                          <Badge variant={t.status === "PUBLISHED" ? "default" : "outline"}>
                            {t.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" asChild>
                            <Link href={`/classes/timetables/${t.id}`}>View</Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Can>
        </TabsContent>
      </Tabs>

      <AssignFacultyDialog
        sectionId={section.id}
        defaultTermId={section.academicTermId}
        open={assignOpen}
        onOpenChange={setAssignOpen}
      />
    </div>
  );
}

function AssignFacultyDialog({
  sectionId,
  defaultTermId,
  open,
  onOpenChange,
}: {
  sectionId: string;
  defaultTermId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const assignMutation = useAssignFaculty();
  const form = useForm<AssignFacultyInput>({
    resolver: zodResolver(assignFacultySchema),
    defaultValues: {
      facultyId: "",
      subjectId: "",
      academicTermId: defaultTermId,
      classSectionId: sectionId,
      role: "PRIMARY",
      replacesAssignmentId: "",
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const body: AssignFacultyBody = {
      facultyId: values.facultyId,
      subjectId: values.subjectId,
      academicTermId: values.academicTermId,
      classSectionId: values.classSectionId || sectionId,
      role: values.role,
      replacesAssignmentId: values.replacesAssignmentId || undefined,
    };
    assignMutation.mutate(body, {
      onSuccess: () => {
        toast.success("Faculty assigned.");
        form.reset();
        onOpenChange(false);
      },
      onError: (err) => {
        if (err instanceof ApiError) {
          if (err.status === 404) {
            const match = /^(\w+) not found$/.exec(err.data?.error ?? "");
            const field = match ? KIND_TO_FIELD[match[1]] : undefined;
            if (field) {
              form.setError(field, { message: err.data?.error });
            } else {
              toast.error(err.message);
            }
          } else if (err.status === 409) {
            toast.error(err.message);
          }
        }
      },
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign Faculty</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="facultyId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Faculty ID</FormLabel>
                  <FormControl><Input placeholder="Faculty ID" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="subjectId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Subject ID</FormLabel>
                  <FormControl><Input placeholder="Subject ID" {...field} /></FormControl>
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
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Role</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="PRIMARY">Primary</SelectItem>
                      <SelectItem value="SUBSTITUTE">Substitute</SelectItem>
                      <SelectItem value="ASSISTANT">Assistant</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="replacesAssignmentId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Replaces Assignment ID (optional)</FormLabel>
                  <FormControl><Input placeholder="Assignment ID to replace" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={assignMutation.isPending}>
                {assignMutation.isPending ? "Assigning…" : "Assign"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
