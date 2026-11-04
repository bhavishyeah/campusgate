"use client";

import { useState } from "react";
import Link from "next/link";
import { Briefcase } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { SectionNav, HR_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { EmployeeFormDialog } from "@/components/hr/EmployeeFormDialog";
import { HrStatusBadge } from "@/components/hr/StatusBadges";
import { PAGE_SIZE, useEmployees, useHrLookups } from "@/features/hr/hooks";
import { displayName, employeeStatusLabel, employmentTypeLabel, toOptions } from "@/features/hr/labels";
import { useDebouncedValue } from "@/features/hr/useDebouncedValue";

export default function HrDirectoryPage() {
  return (
    <RouteGuard requirePermission="hr.directory.view">
      <HrDirectoryInner />
    </RouteGuard>
  );
}

/** Department filter: mounted only for holders of hr.employees.manage (the lookup needs that key). */
function DepartmentFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const lookups = useHrLookups();
  return (
    <div className="w-48">
      <SimpleSelect
        ariaLabel="Department"
        value={value}
        onChange={onChange}
        noneLabel="All departments"
        placeholder="Department"
        options={(lookups.data?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))}
      />
    </div>
  );
}

function HrDirectoryInner() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [employmentType, setEmploymentType] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const debounced = useDebouncedValue(search.trim(), 300);
  const list = useEmployees({
    q: debounced || undefined,
    status: status || undefined,
    employmentType: employmentType || undefined,
    departmentId: departmentId || undefined,
    page,
  });
  const filtered = Boolean(debounced || status || employmentType || departmentId);

  return (
    <div className="space-y-6">
      <SectionNav items={HR_STAFF_NAV} />
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Employees</h1>
          <p className="text-sm text-gray-500">Employment records, contracts, leave and attendance.</p>
        </div>
        <Can permission="hr.employees.manage">
          <Button onClick={() => setAddOpen(true)}>Add employee</Button>
        </Can>
      </div>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search by employee no, designation, email or name"
          aria-label="Search employees"
          value={search}
          maxLength={100}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="max-w-sm"
        />
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
            options={toOptions(employeeStatusLabel)}
          />
        </div>
        <div className="w-44">
          <SimpleSelect
            ariaLabel="Employment type"
            value={employmentType}
            onChange={(v) => {
              setEmploymentType(v);
              setPage(1);
            }}
            noneLabel="All types"
            placeholder="Employment type"
            options={toOptions(employmentTypeLabel)}
          />
        </div>
        <Can permission="hr.employees.manage">
          <DepartmentFilter
            value={departmentId}
            onChange={(v) => {
              setDepartmentId(v);
              setPage(1);
            }}
          />
        </Can>
      </div>

      {!list.allowed ? (
        <NoAccess what="the employee directory" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.employees.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          label={filtered ? "No employees match these filters." : "No employees yet."}
        />
      ) : (
        <>
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Employee no</TableHead>
                  <TableHead>Designation</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.employees.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <div className="font-medium">{displayName(e)}</div>
                      {e.name ? <div className="text-xs text-gray-500">{e.email}</div> : null}
                    </TableCell>
                    <TableCell>{e.employeeNo}</TableCell>
                    <TableCell>{e.designation ?? "-"}</TableCell>
                    <TableCell>
                      <HrStatusBadge kind="employee" status={e.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Link href={`/hr/employees/${e.id}`} className="text-sm text-primary-600 underline">
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

      <Can permission="hr.employees.manage">
        {addOpen ? <EmployeeFormDialog open onOpenChange={setAddOpen} /> : null}
      </Can>
    </div>
  );
}
