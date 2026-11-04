// features/library/hooks.ts
// No "use client": hooks files are plain TS modules (mirrors features/classes/hooks.ts).

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";
import { can } from "@/lib/authz";
import { useAuthStore } from "@/stores/auth";
import { libraryKeys } from "./keys";
import { libraryErrorOverrides } from "./labels";
import type {
  BookCopy,
  BookTitle,
  CatalogueItem,
  LibraryFine,
  LibrarySummary,
  Loan,
  LoanListItem,
  MyLoan,
  MyReservation,
  Paged,
  Reservation,
  ReservationListItem,
  ReturnResult,
  StudentSummary,
  TitleDetail,
  TitleListItem,
} from "./types";

export const PAGE_SIZE = 20;

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function usePerms(): string[] {
  return useAuthStore((s) => s.permissions);
}

type WithAllowed<T> = UseQueryResult<T, ApiError> & { allowed: boolean };
function withAllowed<T>(query: UseQueryResult<T, ApiError>, allowed: boolean): WithAllowed<T> {
  return Object.assign(query, { allowed });
}

function toastError(error: unknown): void {
  toast.error(describeApiError(error, libraryErrorOverrides));
}

// ─── Queries ────────────────────────────────────────────────────────────────

export interface TitleFilters { q?: string; category?: string; page: number }

export function useTitles(filters: TitleFilters) {
  const allowed = can("library.books.view", usePerms());
  const q = useQuery<Paged & { titles: TitleListItem[] }, ApiError>({
    queryKey: libraryKeys.titles(filters),
    queryFn: () =>
      api.get(`/api/library/titles${qs({ q: filters.q, category: filters.category, page: filters.page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useTitle(id: string | undefined) {
  const allowed = can("library.books.view", usePerms());
  const q = useQuery<TitleDetail, ApiError>({
    queryKey: libraryKeys.title(id ?? ""),
    queryFn: () => api.get(`/api/library/titles/${id}`),
    enabled: allowed && Boolean(id),
  });
  return withAllowed(q, allowed);
}

export function useLibrarySummary() {
  const allowed = can("library.books.view", usePerms());
  const q = useQuery<LibrarySummary, ApiError>({
    queryKey: libraryKeys.summary(),
    queryFn: () => api.get("/api/library/reports/summary"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useCatalogue(filters: TitleFilters) {
  const allowed = can("library.view_own", usePerms());
  const q = useQuery<Paged & { titles: CatalogueItem[] }, ApiError>({
    queryKey: libraryKeys.catalogue(filters),
    queryFn: () =>
      api.get(`/api/library/catalogue${qs({ q: filters.q, category: filters.category, page: filters.page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export interface LoanFilters { status?: string; overdue?: boolean; studentId?: string; page: number }

export function useLoans(filters: LoanFilters) {
  const allowed = can("library.books.view", usePerms());
  const q = useQuery<Paged & { loans: LoanListItem[] }, ApiError>({
    queryKey: libraryKeys.loans(filters),
    queryFn: () =>
      api.get(
        `/api/library/loans${qs({
          status: filters.status,
          overdue: filters.overdue ? true : undefined,
          studentId: filters.studentId,
          page: filters.page,
          pageSize: PAGE_SIZE,
        })}`,
      ),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export interface ReservationFilters { status?: string; bookTitleId?: string; page: number }

export function useReservationQueue(filters: ReservationFilters) {
  const allowed = can("library.books.view", usePerms());
  const q = useQuery<Paged & { reservations: ReservationListItem[] }, ApiError>({
    queryKey: libraryKeys.reservations(filters),
    queryFn: () =>
      api.get(
        `/api/library/reservations${qs({
          status: filters.status,
          bookTitleId: filters.bookTitleId,
          page: filters.page,
          pageSize: PAGE_SIZE,
        })}`,
      ),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useStudentLookup(query: string) {
  const allowed = can("library.issue", usePerms());
  const trimmed = query.trim();
  const q = useQuery<{ students: StudentSummary[] }, ApiError>({
    queryKey: libraryKeys.studentLookup(trimmed),
    queryFn: () => api.get(`/api/library/students/lookup${qs({ q: trimmed, limit: 10 })}`),
    enabled: allowed && trimmed.length >= 2 && trimmed.length <= 100,
  });
  return withAllowed(q, allowed);
}

export function useFines(status?: string) {
  const allowed = can("library.fines.manage", usePerms());
  const q = useQuery<{ fines: LibraryFine[] }, ApiError>({
    queryKey: libraryKeys.fines(status),
    queryFn: () => api.get(`/api/library/fines${qs({ status })}`),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

function useMeQuery<T>(key: readonly unknown[], path: string) {
  const allowed = can("library.view_own", usePerms());
  const q = useQuery<T, ApiError>({
    queryKey: key,
    queryFn: () => api.get(path),
    enabled: allowed,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
  return withAllowed(q, allowed);
}

export const useMyLoans = () => useMeQuery<{ loans: MyLoan[] }>(libraryKeys.meLoans(), "/api/library/me/loans");
export const useMyLoanHistory = () =>
  useMeQuery<{ loans: MyLoan[] }>(libraryKeys.meLoanHistory(), "/api/library/me/loans/history");
export const useMyReservations = () =>
  useMeQuery<{ reservations: MyReservation[] }>(libraryKeys.meReservations(), "/api/library/me/reservations");
export const useMyFines = () => useMeQuery<{ fines: LibraryFine[] }>(libraryKeys.meFines(), "/api/library/me/fines");

// ─── Mutations ──────────────────────────────────────────────────────────────

function invalidate(qc: QueryClient, keys: readonly (readonly unknown[])[]) {
  for (const queryKey of keys) qc.invalidateQueries({ queryKey });
}

const CIRCULATION_KEYS = [
  libraryKeys.loansAll(),
  libraryKeys.titlesAll(),
  libraryKeys.titleAll(),
  libraryKeys.reservationsAll(),
  libraryKeys.summary(),
] as const;

export function useCreateTitle() {
  const qc = useQueryClient();
  return useMutation<{ title: BookTitle; possibleDuplicate: { id: string; title: string } | null }, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/library/titles", body),
    onSuccess: () => invalidate(qc, [libraryKeys.titlesAll(), libraryKeys.summary()]),
    onError: toastError,
  });
}

export function usePatchTitle(id: string) {
  const qc = useQueryClient();
  return useMutation<BookTitle, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.patch(`/api/library/titles/${id}`, body),
    onSuccess: () => invalidate(qc, [libraryKeys.titlesAll(), libraryKeys.title(id)]),
    onError: toastError,
  });
}

export function useAddCopy(titleId: string) {
  const qc = useQueryClient();
  // toast:false: the dialog maps the accession conflict to a field error.
  return useMutation<BookCopy, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/library/titles/${titleId}/copies`, body),
    onSuccess: () => invalidate(qc, [libraryKeys.title(titleId), libraryKeys.titlesAll(), libraryKeys.summary()]),
  });
}

export function usePatchCopy(titleId: string) {
  const qc = useQueryClient();
  return useMutation<BookCopy, ApiError, { id: string; body: Record<string, unknown> }>({
    mutationFn: ({ id, body }) => api.patch(`/api/library/copies/${id}`, body),
    onSuccess: () => invalidate(qc, [libraryKeys.title(titleId)]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [libraryKeys.title(titleId)]);
    },
  });
}

export function useWithdrawCopy(titleId: string) {
  const qc = useQueryClient();
  return useMutation<BookCopy, ApiError, string>({
    mutationFn: (id) => api.post(`/api/library/copies/${id}/withdraw`),
    onSuccess: () => invalidate(qc, [libraryKeys.title(titleId), libraryKeys.titlesAll(), libraryKeys.summary()]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [libraryKeys.title(titleId)]);
    },
  });
}

export function useMarkCopyDamaged(titleId: string) {
  const qc = useQueryClient();
  return useMutation<BookCopy, ApiError, { id: string; note?: string }>({
    mutationFn: ({ id, note }) => api.post(`/api/library/copies/${id}/damaged`, note ? { note } : {}),
    onSuccess: () => invalidate(qc, [libraryKeys.title(titleId), libraryKeys.titlesAll(), libraryKeys.summary()]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [libraryKeys.title(titleId)]);
    },
  });
}

/** toast:false — IssueLoanDialog renders the 409 inline and stays open. */
export function useIssueLoan() {
  const qc = useQueryClient();
  return useMutation<Loan, ApiError, { bookCopyId: string; studentId: string }>({
    mutationFn: (body) => api.post("/api/library/loans", body),
    onSuccess: () => invalidate(qc, CIRCULATION_KEYS),
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) invalidate(qc, CIRCULATION_KEYS);
    },
  });
}

export function useReturnLoan() {
  const qc = useQueryClient();
  return useMutation<ReturnResult, ApiError, string>({
    mutationFn: (id) => api.post(`/api/library/loans/${id}/return`, {}),
    onSuccess: () => invalidate(qc, [...CIRCULATION_KEYS, libraryKeys.finesAll()]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [libraryKeys.loansAll()]);
    },
  });
}

export function useRenewLoan() {
  const qc = useQueryClient();
  return useMutation<Loan, ApiError, string>({
    mutationFn: (id) => api.post(`/api/library/loans/${id}/renew`, {}),
    onSuccess: () => invalidate(qc, [libraryKeys.loansAll()]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [libraryKeys.loansAll()]);
    },
  });
}

export function useMarkLoanLost() {
  const qc = useQueryClient();
  return useMutation<{ loanId: string; fineId: string | null }, ApiError, { id: string; note?: string }>({
    mutationFn: ({ id, note }) => api.post(`/api/library/loans/${id}/lost`, note ? { note } : {}),
    onSuccess: () => invalidate(qc, [...CIRCULATION_KEYS, libraryKeys.finesAll()]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [libraryKeys.loansAll()]);
    },
  });
}

export function useRunOverdueSweep() {
  const qc = useQueryClient();
  return useMutation<{ overdueCount: number; reminded: number }, ApiError, void>({
    mutationFn: () => api.post("/api/library/overdue/remind"),
    onSuccess: () => invalidate(qc, [libraryKeys.loansAll(), libraryKeys.summary()]),
    onError: toastError,
  });
}

export function useFulfilReservation() {
  const qc = useQueryClient();
  // toast:false — FulfilDialog renders the 409 inline.
  return useMutation<Reservation, ApiError, { id: string; bookCopyId: string }>({
    mutationFn: ({ id, bookCopyId }) => api.post(`/api/library/reservations/${id}/fulfil`, { bookCopyId }),
    onSuccess: () => invalidate(qc, [libraryKeys.reservationsAll(), libraryKeys.titleAll(), libraryKeys.titlesAll()]),
    onError: () => invalidate(qc, [libraryKeys.reservationsAll(), libraryKeys.titleAll()]),
  });
}

export function useCollectReservation() {
  const qc = useQueryClient();
  return useMutation<Loan, ApiError, string>({
    mutationFn: (id) => api.post(`/api/library/reservations/${id}/collect`, {}),
    onSuccess: () => invalidate(qc, [libraryKeys.reservationsAll(), libraryKeys.loansAll(), libraryKeys.titlesAll(), libraryKeys.titleAll(), libraryKeys.summary()]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [libraryKeys.reservationsAll()]);
    },
  });
}

export function useCancelHold() {
  const qc = useQueryClient();
  return useMutation<Reservation, ApiError, { id: string; reason?: string }>({
    mutationFn: ({ id, reason }) => api.post(`/api/library/reservations/${id}/cancel-hold`, reason ? { reason } : {}),
    onSuccess: () => invalidate(qc, [libraryKeys.reservationsAll(), libraryKeys.titlesAll(), libraryKeys.titleAll(), libraryKeys.summary()]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [libraryKeys.reservationsAll()]);
    },
  });
}

export function useReserveTitle() {
  const qc = useQueryClient();
  return useMutation<Reservation, ApiError, string>({
    mutationFn: (bookTitleId) => api.post("/api/library/reservations", { bookTitleId }),
    onSuccess: () => invalidate(qc, [libraryKeys.meAll(), libraryKeys.catalogueAll()]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [libraryKeys.catalogueAll()]);
    },
  });
}

export function useCancelMyReservation() {
  const qc = useQueryClient();
  return useMutation<Reservation, ApiError, string>({
    mutationFn: (id) => api.post(`/api/library/reservations/${id}/cancel`, {}),
    onSuccess: () => invalidate(qc, [libraryKeys.meAll(), libraryKeys.catalogueAll()]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [libraryKeys.meAll()]);
    },
  });
}

export interface CreateFineBody {
  studentId: string;
  reason: "OVERDUE" | "LOST" | "DAMAGED";
  /** Rupees as a JSON number (server contract); never paise. */
  amount: number;
  note?: string;
}

export function useCreateFine() {
  const qc = useQueryClient();
  return useMutation<LibraryFine, ApiError, CreateFineBody>({
    mutationFn: (body) => api.post("/api/library/fines", body),
    onSuccess: () => invalidate(qc, [libraryKeys.finesAll(), libraryKeys.summary()]),
    onError: toastError,
  });
}

export function useWaiveFine() {
  const qc = useQueryClient();
  return useMutation<LibraryFine, ApiError, { id: string; note?: string }>({
    mutationFn: ({ id, note }) => api.post(`/api/library/fines/${id}/waive`, note ? { note } : {}),
    onSuccess: () => invalidate(qc, [libraryKeys.finesAll(), libraryKeys.summary()]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [libraryKeys.finesAll()]);
    },
  });
}

export function usePayFine() {
  const qc = useQueryClient();
  return useMutation<LibraryFine, ApiError, { id: string; note?: string }>({
    mutationFn: ({ id, note }) => api.post(`/api/library/fines/${id}/pay`, note ? { note } : {}),
    onSuccess: () => invalidate(qc, [libraryKeys.finesAll(), libraryKeys.summary()]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [libraryKeys.finesAll()]);
    },
  });
}

/** True for the 404 "student not found" a /me/* call returns without a StudentProfile. */
export function isNoStudentProfile(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}
