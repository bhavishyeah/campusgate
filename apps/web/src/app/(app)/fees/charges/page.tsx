"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import {
  PaiseAmount,
  feeComponentCategoryEnum,
  bulkChargeSchema,
  type BulkChargeInput,
} from "@campusgate/shared";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
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
import { ApiError } from "@/lib/api";
import { rupeesToPaiseString } from "@/lib/money";
import {
  postChargeFormSchema,
  type PostChargeFormValues,
} from "@/features/fees/formSchemas";
import { usePostCharge, useBulkCharge } from "@/features/fees/hooks";

const CATEGORY_OPTIONS = feeComponentCategoryEnum.options;

export default function ChargesPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Charges</h1>
        <p className="text-sm text-gray-500">
          Post a charge to one student or in bulk from a structure.
        </p>
      </div>

      <Can
        permission="fees.charges.manage"
        fallback={
          <p className="text-sm text-gray-500">
            You don&apos;t have permission to post charges.
          </p>
        }
      >
        <div className="grid gap-8 md:grid-cols-2">
          <SingleChargeCard />
          <BulkChargeCard />
        </div>
      </Can>
    </div>
  );
}

function SingleChargeCard() {
  const postCharge = usePostCharge();
  const form = useForm<PostChargeFormValues>({
    resolver: zodResolver(postChargeFormSchema),
    defaultValues: {
      studentId: "",
      category: "TUITION",
      amountRupees: "",
      description: "",
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    let amountPaise: string;
    try {
      amountPaise = rupeesToPaiseString(values.amountRupees);
      PaiseAmount.parse(amountPaise);
    } catch {
      form.setError("amountRupees", { message: "Enter a valid amount." });
      return;
    }
    postCharge.mutate(
      {
        studentId: values.studentId,
        category: values.category,
        amountPaise,
        description: values.description,
        feeStructureId: values.feeStructureId || undefined,
        feeComponentId: values.feeComponentId || undefined,
        dueDate: values.dueDate || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Charge posted.");
          form.reset();
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 404) {
            form.setError("studentId", {
              message: "No student found for that id.",
            });
          }
        },
      },
    );
  });

  return (
    <div className="card space-y-4">
      <h2 className="text-lg font-medium text-gray-900">Post single charge</h2>
      <Form {...form}>
        <form onSubmit={onSubmit} className="space-y-4">
          <FormField
            control={form.control}
            name="studentId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Student ID</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="category"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Category</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {CATEGORY_OPTIONS.map((o) => (
                      <SelectItem key={o} value={o}>
                        {o}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="amountRupees"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Amount (₹)</FormLabel>
                <FormControl>
                  <Input inputMode="decimal" placeholder="e.g. 5000.00" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Description</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" disabled={postCharge.isPending}>
            {postCharge.isPending ? "Posting…" : "Post charge"}
          </Button>
        </form>
      </Form>
    </div>
  );
}

function BulkChargeCard() {
  const bulkCharge = useBulkCharge();
  const form = useForm<BulkChargeInput>({
    resolver: zodResolver(bulkChargeSchema),
    defaultValues: { feeStructureId: "" },
  });

  const onSubmit = form.handleSubmit((values) => {
    const body: {
      feeStructureId: string;
      programId?: string;
      academicSessionId?: string;
    } = { feeStructureId: values.feeStructureId };
    if (values.programId) body.programId = values.programId;
    if (values.academicSessionId) body.academicSessionId = values.academicSessionId;
    bulkCharge.mutate(body, {
      onSuccess: (result) => {
        toast.success(
          `Posted ${result.charges} charges to ${result.students} students.`,
        );
        form.reset();
      },
    });
  });

  return (
    <div className="card space-y-4">
      <h2 className="text-lg font-medium text-gray-900">Bulk charge</h2>
      <Form {...form}>
        <form onSubmit={onSubmit} className="space-y-4">
          <FormField
            control={form.control}
            name="feeStructureId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Fee structure ID</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="programId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Program ID (optional)</FormLabel>
                <FormControl>
                  <Input {...field} value={field.value ?? ""} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="academicSessionId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Academic session ID (optional)</FormLabel>
                <FormControl>
                  <Input {...field} value={field.value ?? ""} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" disabled={bulkCharge.isPending}>
            {bulkCharge.isPending ? "Posting…" : "Post bulk charges"}
          </Button>
        </form>
      </Form>
    </div>
  );
}
