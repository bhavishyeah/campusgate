"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Megaphone } from "lucide-react";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Form, FormItem, FormLabel } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { DynamicFormFields } from "@/components/admissions/DynamicFormFields";
import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";
import { useCreateApplication, useOpenCampaign } from "@/features/admissions/hooks";
import { buildApplyFormSchema, toFormData } from "@/features/admissions/formSchemas";
import type { OpenCampaign } from "@/features/admissions/types";

export default function ApplyPage() {
  return (
    <RouteGuard requirePermission="admissions.view_own">
      <ApplyInner />
    </RouteGuard>
  );
}

function ApplyInner() {
  const params = useParams<{ campaignId: string }>();
  const campaign = useOpenCampaign(params.campaignId);

  if (campaign.isLoading) return <Skeleton className="h-64 w-full" />;
  if (campaign.isError || !campaign.data) {
    const notOpen = campaign.error instanceof ApiError && campaign.error.status === 404;
    return notOpen ? (
      <EmptyState
        icon={Megaphone}
        label="This campaign is not open for applications."
        action={
          <Button variant="outline" asChild>
            <Link href="/admissions/my">Back to my application</Link>
          </Button>
        }
      />
    ) : (
      <InlineError message={describeApiError(campaign.error)} />
    );
  }
  return <ApplyForm campaign={campaign.data} />;
}

function ApplyForm({ campaign }: { campaign: OpenCampaign }) {
  const router = useRouter();
  const create = useCreateApplication();
  const keys = campaign.config.requiredFields;
  const schema = buildApplyFormSchema(keys);
  const [programId, setProgramId] = useState(campaign.programs.length === 1 ? campaign.programs[0].id : "");
  const [error, setError] = useState<{ text: string; showLink: boolean } | null>(null);
  const form = useForm<{ values: string[] }>({
    resolver: zodResolver(schema),
    defaultValues: { values: keys.map(() => "") },
  });

  const onSubmit = form.handleSubmit((data) => {
    setError(null);
    if (!programId) {
      setError({ text: "Choose a program.", showLink: false });
      return;
    }
    let formData: Record<string, unknown>;
    try {
      formData = toFormData(keys, data.values);
    } catch (err) {
      setError({ text: err instanceof Error ? err.message : "Invalid form.", showLink: false });
      return;
    }
    create.mutate(
      { campaignId: campaign.id, programId, formData },
      {
        onSuccess: (app) => {
          toast.success("Draft saved. Add your documents, then submit.");
          router.push(`/admissions/my/${app.id}`);
        },
        onError: (err) =>
          setError({
            text: describeApiError(err),
            showLink: err instanceof ApiError && (err.status === 409 || err.status === 422),
          }),
      },
    );
  });

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Apply: {campaign.name}</h1>
        {campaign.config.requiredDocTypes.length > 0 ? (
          <p className="text-sm text-gray-500">
            You will add: {campaign.config.requiredDocTypes.join(", ")}
          </p>
        ) : null}
      </div>
      <Form {...form}>
        <form onSubmit={onSubmit} className="space-y-4">
          <FormItem>
            <FormLabel>Program</FormLabel>
            <SimpleSelect
              ariaLabel="Program"
              value={programId}
              onChange={setProgramId}
              placeholder="Select a program"
              options={campaign.programs.map((p) => ({ value: p.id, label: p.name }))}
            />
          </FormItem>
          <DynamicFormFields keys={keys} control={form.control} />
          {error ? (
            <div className="space-y-1">
              <InlineError message={error.text} />
              {error.showLink ? (
                <Link href="/admissions/my" className="text-sm text-primary-700 underline">
                  Go to my application
                </Link>
              ) : null}
            </div>
          ) : null}
          <Can permission="admissions.view_own">
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Saving…" : "Save as draft"}
            </Button>
          </Can>
        </form>
      </Form>
    </div>
  );
}
