export type StudentStatus =
  | "ACTIVE"
  | "SUSPENDED"
  | "WITHDRAWN"
  | "GRADUATED"
  | "ON_LEAVE";

export type DeactivationStatus = Exclude<StudentStatus, "ACTIVE">;

export interface Department {
  id: string;
  name: string;
  code: string;
}

export interface StudentProfile {
  id: string;
  userId: string;
  institutionId: string;
  enrollmentNo: string;
  rollNumber: string | null;
  name: string;
  email: string;
  status: StudentStatus;
  semester: number;
  departmentId: string;
  // Free-text program label captured at enrolment. Always present (required
  // column) and returned by the LIST endpoint; the structured Program relation
  // (structuredProgram) is only hydrated on the detail endpoint.
  program: string;
  programId: string | null;
  academicSessionId: string | null;
  currentTermId: string | null;
  admissionDate: string | null;
  section: string | null;
  dob: string | null;
  phone: string | null;
  address: string | null;
  createdAt: string;
  updatedAt: string;
  // Relations (present on detail endpoint only)
  department?: Department;
  structuredProgram?: { id: string; name: string; code: string } | null;
  academicSession?: { id: string; name: string } | null;
  currentTerm?: { id: string; name: string } | null;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface StudentListParams {
  q?: string;
  status?: StudentStatus;
  programId?: string;
  departmentId?: string; // supported by API; HOD auto-scoped server-side; UI filter optional
  page?: number;
  pageSize?: number;
}
