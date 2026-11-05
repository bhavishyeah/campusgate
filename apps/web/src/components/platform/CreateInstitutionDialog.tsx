"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui-ext/InlineError";
import { BootstrapSecretPanel } from "@/components/platform/BootstrapSecretPanel";
import {
  createInstitutionSchema,
  type CreateInstitutionValues,
} from "@/features/platform/schemas";
import { useCreateInstitution } from "@/features/platform/hooks";
import type { CreateInstitutionResult } from "@/features/platform/types";
import { describeApiError } from "@/lib/apiErrors";

/**
 * Create-institution flow. On a 201 it hands off to <BootstrapSecretPanel> for
 * the show-once tempPassword reveal (held only in local state here — never a
 * store/cache). 409 conflicts surface verbatim via describeApiError.
 */
export function CreateInstitutionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateInstitution();
  const [created, setCreated] = useState<CreateInstitutionResult | null>(null);
  const [submitError, setSubmitError] = useState("");

  const form = useForm<CreateInstitutionValues>({
    resolver: zodResolver(createInstitutionSchema),
    defaultValues: { name: "", code: "", adminEmail: "", domain: "" },
  });

  const reset = () => {
    form.reset();
    setSubmitError("");
    setCreated(null);
    create.reset();
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitError("");
    try {
      const result = await create.mutateAsync({
        name: values.name,
        code: values.code,
        adminEmail: values.adminEmail,
        // Blank domain is sent as undefined, never "".
        domain: values.domain && values.domain.trim() ? values.domain.trim() : undefined,
      });
      setCreated(result);
    } catch (err) {
      // 409 "Institution code already exists" / "Admin email already in use"
      // surfaced verbatim.
      setSubmitError(describeApiError(err));
    }
  });

  // Once created, the reveal panel owns the surface until the operator is done.
  if (created) {
    return (
      <BootstrapSecretPanel
        result={created}
        onDone={() => {
          reset();
          onOpenChange(false);
        }}
      />
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New institution</DialogTitle>
          <DialogDescription>
            Create an institution and its first admin account.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Institution name</FormLabel>
                  <FormControl>
                    <Input placeholder="ITM College" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Institution code</FormLabel>
                  <FormControl>
                    <Input placeholder="ITM001" className="uppercase" {...field} />
                  </FormControl>
                  <FormDescription>
                    Unique identifier, cannot be changed later.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="domain"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Domain (optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="itm.edu" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="adminEmail"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Initial admin email</FormLabel>
                  <FormControl>
                    <Input type="email" placeholder="admin@itm.edu" {...field} />
                  </FormControl>
                  <FormDescription>
                    This account becomes the institution&apos;s first admin.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            {submitError && <InlineError message={submitError} />}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create institution"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
