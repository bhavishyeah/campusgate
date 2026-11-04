import type {
  CopyCondition,
  CopyStatus,
  FineReason,
  FineStatus,
  LoanStatus,
  ReservationStatus,
  TitleStatus,
} from "./types";

export const copyStatusLabel: Record<CopyStatus, string> = {
  AVAILABLE: "Available",
  ISSUED: "Issued",
  RESERVED: "Reserved (parked)",
  LOST: "Lost",
  DAMAGED: "Damaged",
  WITHDRAWN: "Withdrawn",
};

export const copyConditionLabel: Record<CopyCondition, string> = {
  NEW: "New",
  GOOD: "Good",
  FAIR: "Fair",
  POOR: "Poor",
  DAMAGED: "Damaged",
};

export const titleStatusLabel: Record<TitleStatus, string> = {
  ACTIVE: "Active",
  WITHDRAWN: "Withdrawn",
};

export const loanStatusLabel: Record<LoanStatus, string> = {
  ACTIVE: "Active",
  OVERDUE: "Overdue",
  RETURNED: "Returned",
  LOST: "Lost",
};

export const reservationStatusLabel: Record<ReservationStatus, string> = {
  PENDING: "In queue",
  FULFILLED: "Ready for pickup",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

export const fineReasonLabel: Record<FineReason, string> = {
  OVERDUE: "Overdue",
  LOST: "Lost",
  DAMAGED: "Damaged",
};

export const fineStatusLabel: Record<FineStatus, string> = {
  PENDING: "Pending",
  PAID: "Paid",
  WAIVED: "Waived",
};

/** The ONLY server strings the library UI rewrites. Everything else is verbatim. */
export const libraryErrorOverrides: Record<string, string> = {
  "copy not available":
    "This copy was just issued or is no longer available. The list has been refreshed.",
  "borrowing limit reached": "This student has reached the borrowing limit.",
  "student not found": "Student not found.",
};
