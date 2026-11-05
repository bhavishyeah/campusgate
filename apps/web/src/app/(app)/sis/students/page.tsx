"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Users, Search } from "lucide-react";
import Link from "next/link";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Button } from "@/components/ui/button";
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
import { useStudents } from "@/features/sis/hooks";
import { programLabel } from "@/features/sis/format";
import type { StudentListParams, StudentStatus } from "@/features/sis/types";

const STATUS_VARIANT: Record<
  string,
  "outline" | "default" | "secondary" | "destructive"
> = {
  ACTIVE: "default",
  SUSPENDED: "destructive",
  WITHDRAWN: "secondary",
  GRADUATED: "outline",
  ON_LEAVE: "secondary",
};

// Students list wrapped in <RouteGuard> (authentication-only, no requirePermission
// per MUST-FIX 2).
export default function StudentsPage() {
  return (
    <RouteGuard>
      <StudentsInner />
    </RouteGuard>
  );
}

function StudentsInner() {
  const router = useRouter();
  const [params, setParams] = useState<StudentListParams>({
    page: 1,
    pageSize: 20,
  });
  const [searchInput, setSearchInput] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce the search input by 300ms (no extra library per the plan).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setParams((p) => ({ ...p, q: searchInput || undefined, page: 1 }));
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchInput]);

  const { data, isLoading, isError, error } = useStudents(params);

  const totalPages = data?.pagination.totalPages ?? 1;
  const currentPage = data?.pagination.page ?? params.page ?? 1;
  const total = data?.pagination.total ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Students</h1>
        <p className="text-sm text-gray-500">
          Search and manage student records.
        </p>
      </div>

      {/* Search + filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            placeholder="Search by name, enrollment no…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select
          value={params.status ?? "all"}
          onValueChange={(v) =>
            setParams((p) => ({
              ...p,
              status: v === "all" ? undefined : (v as StudentStatus),
              page: 1,
            }))
          }
        >
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="SUSPENDED">Suspended</SelectItem>
            <SelectItem value="WITHDRAWN">Withdrawn</SelectItem>
            <SelectItem value="GRADUATED">Graduated</SelectItem>
            <SelectItem value="ON_LEAVE">On Leave</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="Program ID filter"
          value={params.programId ?? ""}
          onChange={(e) =>
            setParams((p) => ({
              ...p,
              programId: e.target.value || undefined,
              page: 1,
            }))
          }
          className="w-full sm:w-48"
        />
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
              : "Failed to load students."
          }
        />
      ) : !data || data.students.length === 0 ? (
        <EmptyState
          icon={Users}
          label="No students found"
          description="Adjust filters or search to find students."
        />
      ) : (
        <>
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Enrollment No</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Program</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.students.map((s) => (
                  <TableRow
                    key={s.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/sis/students/${s.id}`)}
                  >
                    <TableCell className="font-medium">
                      {s.enrollmentNo}
                    </TableCell>
                    <TableCell className="font-medium">
                      <span className="text-primary-700 hover:underline">
                        {s.name}
                      </span>
                    </TableCell>
                    <TableCell className="text-gray-600">{s.email}</TableCell>
                    <TableCell className="text-gray-600">
                      {programLabel(s)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[s.status] ?? "outline"}>
                        {s.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage <= 1}
              onClick={() =>
                setParams((p) => ({ ...p, page: (p.page ?? 1) - 1 }))
              }
            >
              ← Previous
            </Button>
            <span className="text-sm text-gray-600">
              Page {currentPage} of {totalPages} · {total} students
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= totalPages}
              onClick={() =>
                setParams((p) => ({ ...p, page: (p.page ?? 1) + 1 }))
              }
            >
              Next →
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
