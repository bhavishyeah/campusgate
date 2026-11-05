"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { describeApiError } from "@/lib/apiErrors";
import { useArchive, usePurge, usePurgeRequest, useUnarchive } from "@/features/documents/hooks";
import { lifecycleActions, type LifecycleAction } from "@/features/documents/transitions";
import type { DocStatus } from "@/features/documents/types";

const LABEL: Record<LifecycleAction, string> = {
  archive: "Archive",
  unarchive: "Unarchive",
  "purge-request": "Request purge",
  purge: "Purge now",
};

const DESTRUCTIVE: Record<LifecycleAction, boolean> = {
  archive: false,
  unarchive: false,
  "purge-request": true,
  purge: true,
};

const CONFIRM_DESCRIPTION: Record<LifecycleAction, string> = {
  archive: "",
  unarchive: "",
  "purge-request": "This queues the document for purge. It can no longer be downloaded once pending.",
  purge: "This permanently deletes every version's bytes. This cannot be undone.",
};

/** Lifecycle buttons for retention managers. Destructive steps are confirmed. */
export function LifecycleActions({ documentId, status }: { documentId: string; status: DocStatus }) {
  const archive = useArchive(documentId, { toast: false });
  const unarchive = useUnarchive(documentId, { toast: false });
  const purgeRequest = usePurgeRequest(documentId, { toast: false });
  const purge = usePurge(documentId, { toast: false });
  const [confirm, setConfirm] = useState<LifecycleAction | null>(null);

  const mutations = {
    archive,
    unarchive,
    "purge-request": purgeRequest,
    purge,
  } as const;

  const actions = lifecycleActions(status);
  if (actions.length === 0) return <p className="text-sm text-gray-500">No further lifecycle actions.</p>;

  async function run(action: LifecycleAction) {
    try {
      await mutations[action].mutateAsync();
      toast.success(`${LABEL[action]} done`);
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setConfirm(null);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => (
        <Button
          key={action}
          type="button"
          size="sm"
          variant={DESTRUCTIVE[action] ? "destructive" : "outline"}
          disabled={mutations[action].isPending}
          onClick={() => (DESTRUCTIVE[action] ? setConfirm(action) : void run(action))}
        >
          {LABEL[action]}
        </Button>
      ))}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm ? LABEL[confirm] : ""}
        description={confirm ? CONFIRM_DESCRIPTION[confirm] : ""}
        confirmLabel={confirm ? LABEL[confirm] : "Confirm"}
        destructive
        pending={confirm ? mutations[confirm].isPending : false}
        onConfirm={() => confirm && void run(confirm)}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
      />
    </div>
  );
}
