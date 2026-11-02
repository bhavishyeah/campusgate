"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Wallet, Receipt as ReceiptIcon } from "lucide-react";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { FeeStatusBadge } from "@/features/fees/FeeStatusBadge";
import { ApiError } from "@/lib/api";
import { formatPaise, sumPaise } from "@/lib/money";
import {
  useMeOutstanding,
  useMeCharges,
  useMeReceipts,
  useCreatePayment,
  useVerifyPayment,
  type LedgerCharge,
} from "@/features/fees/hooks";
import { useRazorpay } from "@/features/fees/useRazorpay";

export default function MyFeesPage() {
  return (
    <RouteGuard requirePermission="fees.view_own">
      <MyFeesInner />
    </RouteGuard>
  );
}

// Bounded settlement poll: refetch outstanding every 5s for up to ~60s after
// an optimistic verify, then stop.
const POLL_INTERVAL_MS = 5_000;
const POLL_WINDOW_MS = 60_000;

function MyFeesInner() {
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  // "processing" banner after an optimistic verify (NOT "paid").
  const [processing, setProcessing] = useState(false);
  // Inline fatal message for the no-profile case.
  const [noProfile, setNoProfile] = useState(false);

  // While processing, poll outstanding on a bounded window; otherwise no poll.
  const [polling, setPolling] = useState(false);
  const pollStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const outstanding = useMeOutstanding(polling ? POLL_INTERVAL_MS : false);
  const charges = useMeCharges();
  const receipts = useMeReceipts();
  const createPayment = useCreatePayment();
  const verifyPayment = useVerifyPayment();
  const { ready: scriptReady, error: scriptError } = useRazorpay();

  // Clear the "processing" banner once the ledger shows everything PAID or a
  // receipt exists (settlement observed via refetch/poll).
  useEffect(() => {
    if (!processing) return;
    const allPaid =
      (charges.data?.charges ?? []).every((c) => c.status === "PAID") &&
      (charges.data?.charges?.length ?? 0) > 0;
    const hasReceipt = (receipts.data?.receipts?.length ?? 0) > 0;
    if (allPaid || hasReceipt) {
      setProcessing(false);
      setPolling(false);
    }
  }, [processing, charges.data, receipts.data]);

  useEffect(
    () => () => {
      if (pollStopRef.current) clearTimeout(pollStopRef.current);
    },
    [],
  );

  const payableCharges = useMemo<LedgerCharge[]>(
    () => (charges.data?.charges ?? []).filter((c) => c.status !== "PAID"),
    [charges.data],
  );

  const selectedIds = useMemo(
    () =>
      payableCharges.filter((c) => selected[c.id]).map((c) => c.id),
    [payableCharges, selected],
  );

  const selectedTotalPaise = useMemo(
    () =>
      sumPaise(
        payableCharges
          .filter((c) => selected[c.id])
          .map((c) => c.outstandingPaise),
      ),
    [payableCharges, selected],
  );

  function toggle(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function handlePay() {
    if (selectedIds.length === 0) return;
    createPayment.mutate(
      { chargeIds: selectedIds },
      {
        onSuccess: (res) => openCheckout(res),
        onError: (err) => {
          const message = err instanceof ApiError ? err.message : "";
          if (err instanceof ApiError && err.status === 404) {
            setNoProfile(true);
            return;
          }
          if (err instanceof ApiError && err.status === 409) {
            if (message.includes("not payable")) {
              toast.error(
                "Some of the selected charges can no longer be paid. The list has been refreshed.",
              );
              charges.refetch();
              return;
            }
            if (message.includes("out of range")) {
              toast.error(
                "This amount can't be processed. Contact the fees office.",
              );
              return;
            }
          }
          if (err instanceof ApiError && err.status === 502) {
            toast.error("Payment gateway is unavailable right now.");
            return;
          }
          toast.error(message || "Could not start the payment.");
        },
      },
    );
  }

  function openCheckout(res: {
    keyId: string;
    razorpayOrderId: string;
    amountPaise: string;
  }) {
    if (typeof window === "undefined" || !window.Razorpay) {
      toast.error("Payment is temporarily unavailable. Please try again.");
      return;
    }
    const rzp = new window.Razorpay({
      key: res.keyId,
      order_id: res.razorpayOrderId,
      // SDK-boundary: safe Number() — amount bounded by PaiseAmount
      amount: Number(res.amountPaise),
      currency: "INR",
      name: "Institution",
      handler: (resp) => {
        verifyPayment.mutate(
          {
            razorpay_order_id: resp.razorpay_order_id,
            razorpay_payment_id: resp.razorpay_payment_id,
            razorpay_signature: resp.razorpay_signature,
          },
          {
            onSuccess: () => {
              setProcessing(true);
              setSelected({});
              setPolling(true);
              if (pollStopRef.current) clearTimeout(pollStopRef.current);
              pollStopRef.current = setTimeout(
                () => setPolling(false),
                POLL_WINDOW_MS,
              );
              toast.success("Payment received — processing.");
            },
            onError: (err) => {
              if (
                err instanceof ApiError &&
                err.status === 400 &&
                err.message.includes("invalid payment signature")
              ) {
                toast.error(
                  "We couldn't confirm that payment; it will be reconciled automatically.",
                );
                return;
              }
              toast.error(
                err instanceof ApiError
                  ? err.message
                  : "We couldn't confirm that payment.",
              );
            },
          },
        );
      },
      modal: {
        ondismiss: () => {
          toast("Payment cancelled.");
          charges.refetch();
        },
      },
    });
    rzp.open();
  }

  const payDisabled =
    !scriptReady ||
    selectedIds.length === 0 ||
    createPayment.isPending ||
    verifyPayment.isPending;

  if (noProfile) {
    return (
      <div className="space-y-6">
        <PageHeading />
        <InlineError message="No student profile found." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeading />

      {processing ? (
        <div
          role="status"
          className="bg-warning-50 border border-warning-500 text-warning-600 px-4 py-3 rounded-lg text-sm"
        >
          Payment received — processing. Your ledger will update once the
          payment settles.
        </div>
      ) : null}

      {/* Outstanding summary */}
      <Card>
        <CardHeader>
          <CardTitle>Outstanding balance</CardTitle>
        </CardHeader>
        <CardContent>
          {outstanding.isLoading ? (
            <Skeleton className="h-9 w-40" />
          ) : outstanding.isError ? (
            <InlineError
              message={
                outstanding.error instanceof ApiError
                  ? outstanding.error.message
                  : "Failed to load your outstanding balance."
              }
            />
          ) : (
            <p className="text-3xl font-semibold tabular-nums text-gray-900">
              {formatPaise(outstanding.data?.outstandingPaise ?? "0")}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Charges ledger */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900">Charges</h2>
        {charges.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : charges.isError ? (
          <InlineError
            message={
              charges.error instanceof ApiError
                ? charges.error.message
                : "Failed to load your charges."
            }
          />
        ) : !charges.data || charges.data.charges.length === 0 ? (
          <EmptyState
            icon={Wallet}
            label="No charges"
            description="You have no fee charges on your account."
          />
        ) : (
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <span className="sr-only">Select</span>
                  </TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {charges.data.charges.map((c) => {
                  const payable = c.status !== "PAID";
                  return (
                    <TableRow key={c.id}>
                      <TableCell>
                        <input
                          type="checkbox"
                          aria-label={`Select charge ${c.description}`}
                          className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 disabled:opacity-40"
                          checked={Boolean(selected[c.id]) && payable}
                          disabled={!payable}
                          onChange={() => toggle(c.id)}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{c.category}</TableCell>
                      <TableCell className="text-gray-600">
                        {c.description}
                      </TableCell>
                      <TableCell className="text-gray-600">
                        {c.dueDate
                          ? new Date(c.dueDate).toLocaleDateString()
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <FeeStatusBadge status={c.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatPaise(c.outstandingPaise)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pay bar */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-gray-600">
            Selected total:{" "}
            <span className="font-semibold tabular-nums text-gray-900">
              {formatPaise(selectedTotalPaise)}
            </span>
          </p>
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <Button onClick={handlePay} disabled={payDisabled}>
              {createPayment.isPending
                ? "Starting payment…"
                : `Pay selected (${selectedIds.length})`}
            </Button>
            {scriptError ? (
              <p className="text-sm text-danger-700">
                Payment is temporarily unavailable. Please try again.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Receipts */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900">Receipts</h2>
        {receipts.isLoading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : receipts.isError ? (
          <InlineError
            message={
              receipts.error instanceof ApiError
                ? receipts.error.message
                : "Failed to load your receipts."
            }
          />
        ) : !receipts.data || receipts.data.receipts.length === 0 ? (
          <EmptyState
            icon={ReceiptIcon}
            label="No receipts yet"
            description="Receipts appear here once a payment settles."
          />
        ) : (
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt #</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Issued</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {receipts.data.receipts.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">
                      {r.receiptNumber}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPaise(r.amountPaise)}
                    </TableCell>
                    <TableCell className="text-gray-600">
                      {new Date(r.issuedAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

function PageHeading() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900">My Fees</h1>
      <p className="text-sm text-gray-500">
        View your outstanding balance, pay charges, and see receipts.
      </p>
    </div>
  );
}
