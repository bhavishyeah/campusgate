export type TitleStatus = "ACTIVE" | "WITHDRAWN";
export type CopyCondition = "NEW" | "GOOD" | "FAIR" | "POOR" | "DAMAGED";
export type CopyStatus = "AVAILABLE" | "ISSUED" | "RESERVED" | "LOST" | "DAMAGED" | "WITHDRAWN";
export type LoanStatus = "ACTIVE" | "OVERDUE" | "RETURNED" | "LOST";
export type ReservationStatus = "PENDING" | "FULFILLED" | "CANCELLED" | "EXPIRED";
export type FineStatus = "PENDING" | "PAID" | "WAIVED";
export type FineReason = "OVERDUE" | "LOST" | "DAMAGED";

export interface BookTitle {
  id: string;
  title: string;
  author: string;
  publisher: string | null;
  isbn: string | null;
  category: string | null;
  edition: string | null;
  publicationYear: number | null;
  status: TitleStatus;
}

export type TitleListItem = BookTitle & { availableCopies: number };

export interface BookCopy {
  id: string;
  accessionNumber: string;
  shelfLocation: string | null;
  condition: CopyCondition;
  status: CopyStatus;
  acquiredAt: string | null;
  bookTitleId: string;
}

export type TitleDetail = TitleListItem & { copies: BookCopy[] };

export interface CatalogueItem {
  id: string;
  title: string;
  author: string;
  publisher: string | null;
  isbn: string | null;
  category: string | null;
  edition: string | null;
  publicationYear: number | null;
  availableCopies: number;
}

export interface Paged {
  total: number;
  page: number;
  pageSize: number;
}

export interface StudentSummary {
  id: string;
  name: string;
  enrollmentNo: string | null;
  program: string | null;
}

export interface Loan {
  id: string;
  bookCopyId: string;
  studentId: string;
  issuedByUserId?: string;
  issueDate: string;
  dueDate: string;
  returnDate?: string | null;
  renewalCount: number;
  status: LoanStatus;
}

export interface LoanListItem extends Loan {
  student: StudentSummary;
  bookCopy: {
    id: string;
    accessionNumber: string;
    bookTitle: { id: string; title: string; author: string };
  };
  isOverdue: boolean;
}

export interface MyLoan extends Loan {
  bookCopy: {
    bookTitle: { title: string; author: string };
    accessionNumber?: string;
  };
}

export interface Reservation {
  id: string;
  bookTitleId: string;
  studentId: string;
  reservedAt: string;
  queuePosition: number;
  status: ReservationStatus;
  fulfilledByCopyId?: string | null;
}

export interface ReservationListItem extends Reservation {
  student: StudentSummary;
  bookTitle: { id: string; title: string; author: string };
  fulfilledByCopy: { id: string; accessionNumber: string } | null;
}

export interface MyReservation extends Reservation {
  bookTitle: { title: string; author: string };
}

/** Fine amount is a RUPEE Decimal string (e.g. "12.50"), NOT paise. */
export interface LibraryFine {
  id: string;
  studentId: string;
  libraryLoanId: string | null;
  reason: FineReason;
  amount: string;
  status: FineStatus;
  note: string | null;
  createdAt: string;
}

export interface LibrarySummary {
  totalTitles: number;
  totalCopies: number;
  copiesByStatus: Record<string, number>;
  activeLoans: number;
  overdueLoans: number;
  pendingReservations: number;
  outstandingFinesTotal: string;
}

export interface ReturnResult {
  loanId: string;
  overdueDays: number;
  fineId: string | null;
}
