import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { can } from "@/lib/authz";
import { feesKeys } from "./keys";

// ─── API response shapes (mirror setup-notes "FEES API") ─────────────────────

export interface FeeStructure {
  id: string;
  name: string;
  status: string;
  programId: string | null;
  academicSessionId: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeeComponent {
  id: string;
  feeStructureId: string;
  category: string;
  amountPaise: string;
  currency: string;
  dueDate: string | null;
  installmentLabel: string | null;
  installmentNumber: number | null;
}

export interface Charge {
  id: string;
  studentId: string;
  category: string;
  amountPaise: string;
  currency: string;
  dueDate: string | null;
  description: string;
  status: string;
  postedAt: string;
}

export interface LedgerAllocation {
  id: string;
  amountPaise: string;
  paymentTransactionId: string;
}

export interface LedgerCharge {
  id: string;
  studentId: string;
  category: string;
  amountPaise: string;
  allocatedPaise: string;
  concessionPaise: string;
  adjustmentPaise: string;
  refundedPaise: string;
  outstandingPaise: string;
  currency: string;
  dueDate: string | null;
  description: string;
  status: string;
  postedAt: string;
  allocations: LedgerAllocation[];
}

export interface Ledger {
  studentId: string;
  charges: LedgerCharge[];
  outstandingPaise: string;
  currency: string;
}

export interface PaymentTransaction {
  id: string;
  studentId: string;
  amountPaise: string;
  currency: string;
  status: string;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  createdAt: string;
  capturedAt: string | null;
}

export interface Receipt {
  id: string;
  paymentTransactionId: string;
  receiptNumber: string;
  sequence: number;
  amountPaise: string;
  currency: string;
  issuedAt: string;
}

export interface StuckPayment {
  id: string;
  studentId: string;
  amountPaise: string;
  status: string;
  razorpayOrderId: string;
  createdAt: string;
}

export interface ReconciliationResult {
  thresholdMinutes: number;
  page: number;
  pageSize: number;
  total: number;
  stuck: StuckPayment[];
}

export interface ReconciliationQuery {
  thresholdMinutes: number;
  page: number;
  pageSize: number;
}

/** Minimal student display row returned by the fees-scoped student lookup. */
export interface StudentSummary {
  id: string;
  name: string;
  enrollmentNo: string | null;
  program: string | null;
}

export interface RunReconciliationSummary {
  thresholdMinutes: number;
  scanned: number;
  captured: number;
  failed: number;
  stillOpen: number;
  alreadyCaptured: number;
  errored: number;
}

// Request bodies the staff screens send. amountPaise is an integer paise STRING
// asserted via PaiseAmount.parse at the call site before mutating.
export interface AddComponentBody {
  category: string;
  amountPaise: string;
  dueDate?: string;
  installmentLabel?: string;
  installmentNumber?: number;
}

export interface PostChargeBody {
  studentId: string;
  category: string;
  amountPaise: string;
  description: string;
  feeStructureId?: string;
  feeComponentId?: string;
  dueDate?: string;
}

export interface BulkChargeBody {
  feeStructureId: string;
  programId?: string;
  academicSessionId?: string;
  studentIds?: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

/**
 * PATCH helper. lib/api.ts exposes only get/post/put/delete (it is the frozen
 * transport primitive), so the PATCH used by the structure-edit route is issued
 * here using the same token/ApiError/auto-logout semantics.
 */
async function apiPatch<T>(endpoint: string, body?: unknown): Promise<T> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: "PATCH",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) useAuthStore.getState().logout();
    throw new ApiError(response.status, data);
  }
  return data as T;
}

function currentPermissions(): string[] {
  return useAuthStore.getState().permissions;
}

/** Standard mutation-error surface: a non-blocking toast of the server message. */
function toastError(error: unknown): void {
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Something went wrong.";
  toast.error(message);
}

// ─── Query hooks ─────────────────────────────────────────────────────────────

export function useStructures() {
  return useQuery<{ structures: FeeStructure[] }>({
    queryKey: feesKeys.structures(),
    queryFn: () => api.get("/api/fees/structures"),
    enabled: can("fees.view", currentPermissions()),
  });
}

export function useStructure(id: string) {
  return useQuery<FeeStructure & { components: FeeComponent[] }>({
    queryKey: feesKeys.structure(id),
    queryFn: () => api.get(`/api/fees/structures/${id}`),
    enabled: Boolean(id) && can("fees.view", currentPermissions()),
  });
}

export function useStructureComponents(id: string) {
  return useQuery<{ components: FeeComponent[] }>({
    queryKey: feesKeys.components(id),
    queryFn: () => api.get(`/api/fees/structures/${id}/components`),
    enabled: Boolean(id) && can("fees.view", currentPermissions()),
  });
}

export function useStudentLedger(studentId: string) {
  return useQuery<Ledger>({
    queryKey: feesKeys.ledger(studentId),
    queryFn: () => api.get(`/api/fees/students/${studentId}/ledger`),
    enabled: Boolean(studentId) && can("fees.view", currentPermissions()),
  });
}

export function usePayments() {
  return useQuery<{ payments: PaymentTransaction[] }>({
    queryKey: feesKeys.payments(),
    queryFn: () => api.get("/api/fees/payments"),
    enabled: can("fees.view", currentPermissions()),
  });
}

export function useReceipts() {
  return useQuery<{ receipts: Receipt[] }>({
    queryKey: feesKeys.receipts(),
    queryFn: () => api.get("/api/fees/receipts"),
    enabled: can("fees.view", currentPermissions()),
  });
}

export function useReconciliation(query: ReconciliationQuery) {
  const qs = new URLSearchParams({
    thresholdMinutes: String(query.thresholdMinutes),
    page: String(query.page),
    pageSize: String(query.pageSize),
  }).toString();
  return useQuery<ReconciliationResult>({
    queryKey: feesKeys.reconciliation(query),
    queryFn: () => api.get(`/api/fees/reconciliation?${qs}`),
    enabled: can("fees.view", currentPermissions()),
  });
}

/**
 * Debounced student picker for the charge form. Gated by fees.charges.manage
 * (the key the charge screen already requires) — NOT students.view, which the
 * ACCOUNTANT role does not hold. Enabled only when the caller can manage charges
 * AND q is 2–100 chars, matching the server's min-2 validation.
 */
export function useFeesStudentLookup(
  q: string,
): UseQueryResult<{ students: StudentSummary[] }, ApiError> & { allowed: boolean } {
  const allowed = can("fees.charges.manage", currentPermissions());
  const trimmed = q.trim();
  const query = useQuery<{ students: StudentSummary[] }, ApiError>({
    queryKey: feesKeys.studentLookup(trimmed),
    queryFn: () =>
      api.get(`/api/fees/students/lookup?q=${encodeURIComponent(trimmed)}&limit=10`),
    enabled: allowed && trimmed.length >= 2 && trimmed.length <= 100,
  });
  return Object.assign(query, { allowed });
}

// ─── Student self-service (fees.view_own) ────────────────────────────────────

export interface Outstanding {
  outstandingPaise: string;
  currency: string;
}

/** Create-order response (Stage 1). amountPaise is a decimal paise STRING. */
export interface CreatePaymentResult {
  razorpayOrderId: string;
  amountPaise: string;
  currency: string;
  keyId: string;
  paymentTransactionId: string;
}

export interface VerifyPaymentResult {
  ok: boolean;
  pending: boolean;
}

export interface VerifyPaymentBody {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

/**
 * Poll the outstanding total while a payment is "processing". When
 * `refetchMs` is a number the query refetches on that interval; `false`
 * disables polling. The webhook remains the authoritative settlement path.
 */
export function useMeOutstanding(refetchMs: number | false = false) {
  return useQuery<Outstanding>({
    queryKey: feesKeys.meOutstanding(),
    queryFn: () => api.get("/api/fees/me/outstanding"),
    enabled: can("fees.view_own", currentPermissions()),
    refetchInterval: refetchMs,
  });
}

export function useMeCharges() {
  return useQuery<{ charges: LedgerCharge[] }>({
    queryKey: feesKeys.meCharges(),
    queryFn: () => api.get("/api/fees/me/charges"),
    enabled: can("fees.view_own", currentPermissions()),
  });
}

export function useMeReceipts() {
  return useQuery<{ receipts: Receipt[] }>({
    queryKey: feesKeys.meReceipts(),
    queryFn: () => api.get("/api/fees/me/receipts"),
    enabled: can("fees.view_own", currentPermissions()),
  });
}

/**
 * Stage 1 — create a Razorpay order from the selected chargeIds. NO client
 * amount is sent; the server recomputes the payable sum. Errors are surfaced by
 * the caller (not auto-toasted) because the PAY flow has per-status handling.
 */
export function useCreatePayment() {
  return useMutation<CreatePaymentResult, ApiError, { chargeIds: string[] }>({
    mutationFn: (body) => api.post("/api/fees/me/payments", body),
  });
}

/**
 * Stage 2 — optimistic verify (UX only; the webhook is authoritative). On
 * success invalidates the student ledger / receipts / outstanding so the
 * screen refetches. Caller handles the 400 "invalid payment signature" case.
 */
export function useVerifyPayment() {
  const qc = useQueryClient();
  return useMutation<VerifyPaymentResult, ApiError, VerifyPaymentBody>({
    mutationFn: (body) => api.post("/api/fees/payments/verify", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: feesKeys.meCharges() });
      qc.invalidateQueries({ queryKey: feesKeys.meReceipts() });
      qc.invalidateQueries({ queryKey: feesKeys.meOutstanding() });
    },
  });
}

// ─── Mutation hooks ──────────────────────────────────────────────────────────

export function useCreateStructure() {
  const qc = useQueryClient();
  return useMutation<FeeStructure, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/fees/structures", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: feesKeys.structures() });
    },
    onError: toastError,
  });
}

export function useUpdateStructure(id: string) {
  const qc = useQueryClient();
  return useMutation<FeeStructure, ApiError, Record<string, unknown>>({
    mutationFn: (body) => apiPatch(`/api/fees/structures/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: feesKeys.structures() });
      qc.invalidateQueries({ queryKey: feesKeys.structure(id) });
    },
    onError: toastError,
  });
}

export function useAddComponent(structureId: string) {
  const qc = useQueryClient();
  return useMutation<FeeComponent, ApiError, AddComponentBody>({
    mutationFn: (body) =>
      api.post(`/api/fees/structures/${structureId}/components`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: feesKeys.components(structureId) });
      qc.invalidateQueries({ queryKey: feesKeys.structure(structureId) });
    },
    onError: toastError,
  });
}

export function usePostCharge() {
  const qc = useQueryClient();
  return useMutation<Charge, ApiError, PostChargeBody>({
    mutationFn: (body) => api.post("/api/fees/charges", body),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: feesKeys.ledger(variables.studentId) });
    },
    onError: toastError,
  });
}

export function useBulkCharge() {
  const qc = useQueryClient();
  return useMutation<
    { charges: number; students: number },
    ApiError,
    BulkChargeBody
  >({
    mutationFn: (body) => api.post("/api/fees/charges/bulk", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: feesKeys.payments() });
    },
    onError: toastError,
  });
}

export function useRunReconciliation() {
  const qc = useQueryClient();
  return useMutation<
    RunReconciliationSummary,
    ApiError,
    { thresholdMinutes?: number; limit?: number }
  >({
    mutationFn: (body) => api.post("/api/fees/reconciliation/run", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fees", "reconciliation"] });
      qc.invalidateQueries({ queryKey: feesKeys.payments() });
    },
    onError: toastError,
  });
}
