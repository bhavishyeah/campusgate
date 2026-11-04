"use client";

import { useState } from "react";
import Link from "next/link";
import { Contact } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { SectionNav, FACULTY_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { PAGE_SIZE, useFacultyList, useFacultyLookups } from "@/features/faculty/hooks";
import { facultyStatusLabel } from "@/features/faculty/labels";
import { useDebouncedValue } from "@/features/hr/useDebouncedValue";

export default function FacultyDirectoryPage() {
  return (
    <RouteGuard requirePermission="faculty.directory.view">
      <FacultyDirectoryInner />
    </RouteGuard>
  );
}

function FacultyDirectoryInner() {
  const [search, setSearch] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const debounced = useDebouncedValue(search.trim(), 300);
  const list = useFacultyList({
    q: debounced || undefined,
    departmentId: departmentId || undefined,
    status: status || undefined,
    page,
  });
  const lookups = useFacultyLookups();
  const filtered = Boolean(debounced || departmentId || status);

  return (
    <div className="space-y-6">
      <SectionNav items={FACULTY_STAFF_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Faculty</h1>
        <p className="text-sm text-gray-500">Qualifications, workload and teaching history.</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search by name"
          aria-label="Search by name"
          value={search}
          maxLength={100}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="max-w-xs"
        />
        <div className="w-48">
          <SimpleSelect
            ariaLabel="Department"
            value={departmentId}
            onChange={(v) => {
              setDepartmentId(v);
              setPage(1);
            }}
            noneLabel="All departments"
            placeholder="Department"
            options={(lookups.data?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))}
          />
        </div>
        <div className="w-40">
          <SimpleSelect
            ariaLabel="Status"
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            noneLabel="All statuses"
            placeholder="Status"
            options={[
              { value: "ACTIVE", label: "Active" },
              { value: "INACTIVE", label: "Inactive" },
            ]}
          />
        </div>
      </div>

      {!list.allowed ? (
        <NoAccess what="the faculty directory" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.faculty.length === 0 ? (
        <EmptyState
          icon={Contact}
          label="No faculty match these filters."
          description={filtered ? undefined : "Faculty profiles are created from Classes > Assignments."}
          action={
            filtered ? undefined : (
              <Can permission="classes.faculty.assign">
                <Link href="/classes/assignments" className="text-sm text-primary-600 underline">
                  Go to Classes
                </Link>
              </Can>
            )
          }
        />
      ) : (
        <>
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.faculty.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="font-medium">{f.name}</TableCell>
                    <TableCell>{f.department?.name ?? "-"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{facultyStatusLabel[f.status] ?? f.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Link href={`/faculty-mgmt/${f.id}`} className="text-sm text-primary-600 underline">
                        View
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={list.data.page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}
