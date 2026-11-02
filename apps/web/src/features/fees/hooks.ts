import {
  useMutation,
  useQuery,
  useQueryClient,
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
