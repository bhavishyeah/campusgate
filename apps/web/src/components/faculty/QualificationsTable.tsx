import { GraduationCap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { qualificationKindLabel } from "@/features/faculty/labels";
import type { Qualification } from "@/features/faculty/types";

function DocumentRef({ value }: { value: string | null }) {
  if (!value) return <>-</>;
  if (/^https?:\/\//i.test(value)) {
    return (
      <a href={value} target="_blank" rel="noopener noreferrer" className="text-primary-600 underline">
        {value}
      </a>
    );
  }
  return <span title="Reference only">{value}</span>;
}

/** Read-only unless onEdit/onDelete are passed (staff mount those inside <Can>). */
export function QualificationsTable({
  rows,
  onEdit,
  onDelete,
}: {
  rows: Qualification[];
  onEdit?: (q: Qualification) => void;
  onDelete?: (q: Qualification) => void;
}) {
  if (rows.length === 0) {
    return <EmptyState icon={GraduationCap} label="No qualifications recorded" />;
  }
  const hasActions = Boolean(onEdit || onDelete);
  return (
    <div className="card p-0 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Issuing body</TableHead>
            <TableHead>Field</TableHead>
            <TableHead>Year</TableHead>
            <TableHead>Document reference</TableHead>
            {hasActions ? <TableHead className="text-right">Actions</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((q) => (
            <TableRow key={q.id}>
              <TableCell className="font-medium">{q.title}</TableCell>
              <TableCell>{qualificationKindLabel[q.kind] ?? q.kind}</TableCell>
              <TableCell>{q.issuingBody ?? "-"}</TableCell>
              <TableCell>{q.field ?? "-"}</TableCell>
              <TableCell>{q.year ?? "-"}</TableCell>
              <TableCell className="max-w-[16rem] break-all">
                <DocumentRef value={q.documentRef} />
              </TableCell>
              {hasActions ? (
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    {onEdit ? (
                      <Button variant="outline" size="sm" onClick={() => onEdit(q)}>
                        Edit
                      </Button>
                    ) : null}
                    {onDelete ? (
                      <Button variant="outline" size="sm" onClick={() => onDelete(q)}>
                        Delete
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
