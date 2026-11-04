"use client";

import { useState } from "react";
import { useForm, type ControllerRenderProps } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { InlineError } from "@/components/ui-ext/InlineError";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";
import {
  useAdmissionLookups,
  useCreateCampaign,
  useUpdateCampaign,
} from "@/features/admissions/hooks";
import {
  buildCampaignCreate,
  buildCampaignPatch,
  campaignFormSchema,
  type CampaignFormValues,
} from "@/features/admissions/formSchemas";
import type { Campaign } from "@/features/admissions/types";

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultsFor(c?: Campaign): CampaignFormValues {
  const joinIds = (c?.programs ?? []).map((p) => p.programId).filter((id) => id !== c?.targetProgramId);
  return {
    name: c?.name ?? "",
    intakeSessionId: c?.intakeSessionId ?? "",
    targetProgramId: c?.targetProgramId ?? "",
    programIds: joinIds,
    openAt: toLocalInput(c?.openAt ?? null),
    closeAt: toLocalInput(c?.closeAt ?? null),
    requiredFields: c?.config?.requiredFields ?? [],
    requiredDocTypes: c?.config?.requiredDocTypes ?? [],
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Create or edit a campaign. Mount only inside <Can admissions.campaigns.manage>. */
export function CampaignFormDialog({
  open,
  onOpenChange,
  campaign,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaign?: Campaign;
}) {
  const lookups = useAdmissionLookups();
  const create = useCreateCampaign();
  const update = useUpdateCampaign(campaign?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const initial = defaultsFor(campaign);
  const form = useForm<CampaignFormValues>({
    resolver: zodResolver(campaignFormSchema),
    defaultValues: initial,
  });
  const pending = create.isPending || update.isPending;

  function handleError(err: unknown) {
    if (err instanceof ApiError && err.status === 409 && err.data?.error === "campaign name already exists") {
      form.setError("name", { message: "A campaign with this name already exists." });
      return;
    }
    setError(describeApiError(err));
  }

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    if (campaign) {
      // Own dirty comparison: RHF's dirtyFields for primitive arrays is unreliable.
      const dirty: Partial<Record<keyof CampaignFormValues, boolean>> = {};
      for (const k of Object.keys(initial) as (keyof CampaignFormValues)[]) {
        if (!sameValue(initial[k], values[k])) dirty[k] = true;
      }
      const body = buildCampaignPatch(dirty, values);
      if (Object.keys(body).length === 0) {
        onOpenChange(false);
        return;
      }
      update.mutate(body, {
        onSuccess: () => {
          toast.success("Campaign updated.");
          onOpenChange(false);
        },
        onError: handleError,
      });
      return;
    }
    create.mutate(buildCampaignCreate(values), {
      onSuccess: () => {
        toast.success("Campaign created as a draft.");
        onOpenChange(false);
      },
      onError: handleError,
    });
  });

  const programs = lookups.data?.programs ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{campaign ? "Edit campaign" : "New campaign"}</DialogTitle>
        </DialogHeader>
        {!lookups.allowed ? (
          <NoAccess what="programs and sessions" />
        ) : lookups.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : lookups.isError ? (
          <InlineError message={describeApiError(lookups.error)} />
        ) : (
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-3">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl><Input {...field} maxLength={200} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="intakeSessionId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Intake session</FormLabel>
                    <SimpleSelect
                      ariaLabel="Intake session"
                      value={field.value}
                      onChange={field.onChange}
                      noneLabel={campaign ? "None" : "None"}
                      placeholder="None"
                      options={(lookups.data?.sessions ?? []).map((s) => ({ value: s.id, label: s.name }))}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="targetProgramId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Target program</FormLabel>
                    <SimpleSelect
                      ariaLabel="Target program"
                      value={field.value}
                      onChange={field.onChange}
                      noneLabel="None"
                      placeholder="None"
                      options={programs.map((p) => ({ value: p.id, label: p.name }))}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="programIds"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Additional programs</FormLabel>
                    <div className="space-y-1">
                      {programs.map((p) => (
                        <label key={p.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-gray-300"
                            checked={field.value.includes(p.id)}
                            onChange={(e) =>
                              field.onChange(
                                e.target.checked ? [...field.value, p.id] : field.value.filter((id) => id !== p.id),
                              )
                            }
                          />
                          {p.name}
                        </label>
                      ))}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="openAt"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Applications open at</FormLabel>
                      <FormControl><Input type="datetime-local" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="closeAt"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Applications close at</FormLabel>
                      <FormControl><Input type="datetime-local" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="requiredFields"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Required form fields</FormLabel>
                    <FormDescription>
                      Letters, digits and underscore only. Applicants must fill these in.
                    </FormDescription>
                    <StringList field={field} addLabel="Add field" itemLabel="Field key" />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="requiredDocTypes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Required document types</FormLabel>
                    <StringList field={field} addLabel="Add document type" itemLabel="Document type" />
                    <FormMessage />
                  </FormItem>
                )}
              />
              {error ? <InlineError message={error} /> : null}
              <DialogFooter>
                <Button type="submit" disabled={pending}>
                  {pending ? "Saving…" : campaign ? "Save changes" : "Create campaign"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Repeatable text inputs addressed by index only (key text is never a field name). */
function StringList({
  field,
  addLabel,
  itemLabel,
}: {
  field: ControllerRenderProps<CampaignFormValues, "requiredFields" | "requiredDocTypes">;
  addLabel: string;
  itemLabel: string;
}) {
  const items = field.value as string[];
  return (
    <div className="space-y-2">
      {items.map((v, i) => (
        <div key={i} className="flex gap-2">
          <Input
            aria-label={`${itemLabel} ${i + 1}`}
            value={v}
            maxLength={100}
            onChange={(e) => field.onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove ${itemLabel.toLowerCase()} ${i + 1}`}
            onClick={() => field.onChange(items.filter((_, j) => j !== i))}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => field.onChange([...items, ""])}>
        <Plus className="w-4 h-4 mr-1" /> {addLabel}
      </Button>
    </div>
  );
}
