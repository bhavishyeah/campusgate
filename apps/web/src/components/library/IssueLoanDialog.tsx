"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InlineError } from "@/components/ui-ext/InlineError";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { StudentPicker } from "@/components/library/StudentPicker";
import { describeApiError } from "@/lib/apiErrors";
import { useIssueLoan, useTitle, useTitles } from "@/features/library/hooks";
import { libraryErrorOverrides } from "@/features/library/labels";
import { useDebouncedValue } from "@/features/library/useDebouncedValue";
import type { StudentSummary } from "@/features/library/types";

export interface PreselectedCopy {
  id: string;
  accessionNumber: string;
  titleLabel: string;
}

/**
 * Issues one AVAILABLE copy to a student. The server is the only arbiter of
 * the single-issue rule: a 409 is rendered inline and the dialog stays open.
 */
export function IssueLoanDialog({
  open,
  onOpenChange,
  copy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  copy?: PreselectedCopy;
}) {
  const issue = useIssueLoan();
  const [student, setStudent] = useState<StudentSummary | null>(null);
  const [titleSearch, setTitleSearch] = useState("");
  const [titleId, setTitleId] = useState<string>("");
  const [copyId, setCopyId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const debouncedSearch = useDebouncedValue(titleSearch, 300);
  const needsCopyPicker = !copy;
  const titles = useTitles({ q: needsCopyPicker ? debouncedSearch : undefined, page: 1 });
  const titleDetail = useTitle(needsCopyPicker && titleId ? titleId : undefined);
  const availableCopies = (titleDetail.data?.copies ?? []).filter((c) => c.status === "AVAILABLE");

  const bookCopyId = copy ? copy.id : copyId;
  const canSubmit = Boolean(student && bookCopyId) && !issue.isPending;

  function reset() {
    setStudent(null);
    setTitleSearch("");
    setTitleId("");
    setCopyId("");
    setError(null);
  }

  function submit() {
    if (!student || !bookCopyId) return;
    setError(null);
    issue.mutate(
      { bookCopyId, studentId: student.id },
      {
        onSuccess: (loan) => {
          toast.success(`Issued. Due ${new Date(loan.dueDate).toLocaleDateString()}`);
          reset();
          onOpenChange(false);
        },
        onError: (err) => {
          setError(describeApiError(err, libraryErrorOverrides));
          // Stale copy list: pick again from fresh data.
          setCopyId("");
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Issue a copy</DialogTitle>
          <DialogDescription>
            {copy
              ? `Copy ${copy.accessionNumber} of ${copy.titleLabel}.`
              : "Choose a title and an available copy, then the student."}
          </DialogDescription>
        </DialogHeader>

        {needsCopyPicker ? (
          <div className="space-y-2">
            <Label htmlFor="issue-title-search">Search title, author or ISBN</Label>
            <Input
              id="issue-title-search"
              value={titleSearch}
              onChange={(e) => {
                setTitleSearch(e.target.value);
                setTitleId("");
                setCopyId("");
              }}
              maxLength={300}
            />
            {titles.data && titles.data.titles.length > 0 ? (
              <SimpleSelect
                ariaLabel="Title"
                value={titleId}
                onChange={(v) => {
                  setTitleId(v);
                  setCopyId("");
                }}
                placeholder="Select a title"
                options={titles.data.titles.map((t) => ({
                  value: t.id,
                  label: `${t.title} (${t.availableCopies} available)`,
                }))}
              />
            ) : (
              <p className="text-xs text-gray-500">No titles to show.</p>
            )}
            {titleId ? (
              availableCopies.length > 0 ? (
                <SimpleSelect
                  ariaLabel="Copy"
                  value={copyId}
                  onChange={setCopyId}
                  placeholder="Select an available copy"
                  options={availableCopies.map((c) => ({
                    value: c.id,
                    label: `${c.accessionNumber}${c.shelfLocation ? `, ${c.shelfLocation}` : ""}`,
                  }))}
                />
              ) : titleDetail.isLoading ? (
                <p className="text-xs text-gray-500">Loading copies…</p>
              ) : (
                <p className="text-xs text-gray-500">No available copy for this title.</p>
              )
            ) : null}
          </div>
        ) : null}

        <StudentPicker value={student} onChange={setStudent} />

        {error ? <InlineError message={error} /> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={issue.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {issue.isPending ? "Issuing…" : "Issue copy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
