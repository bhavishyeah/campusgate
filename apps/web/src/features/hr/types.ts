export type EmploymentType = "PERMANENT" | "CONTRACT" | "PART_TIME";
export type EmployeeStatus = "ACTIVE" | "INACTIVE" | "TERMINATED";
export type ContractType = "PERMANENT" | "FIXED_TERM" | "PROBATION" | "CONSULTANT";
export type ContractStatus = "ACTIVE" | "SUPERSEDED" | "ENDED";
export type LeaveType = "CASUAL" | "SICK" | "EARNED" | "UNPAID" | "OTHER";
export type LeaveStatus = "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED";
export type AccrualRule = "ANNUAL_LUMP_SUM" | "MONTHLY_ACCRUAL";
export type AttendanceStatus = "PRESENT" | "ABSENT" | "ON_LEAVE" | "HALF_DAY";
export type AttendanceSource = "MANUAL" | "DERIVED";

export interface Paged {
  total: number;
  page: number;
  pageSize: number;
}

export interface Employee {
  id: string;
  userId: string;
  employeeNo: string;
  designation: string | null;
  employmentType: EmploymentType;
  departmentId: string | null;
  joiningDate: string;
  status: EmployeeStatus;
  createdByUserId: string;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeBrief {
  id: string;
  employeeNo: string;
  designation: string | null;
  status: EmployeeStatus;
  email: string;
  name: string | null;
}

export type EmployeeDetail = Employee & {
  user: { id: string; email: string; name: string | null };
  department: { id: string; name: string } | null;
};

export interface UserLookupItem {
  id: string;
  email: string;
  role: string;
  name: string | null;
}

export interface HrLookups {
  departments: { id: string; name: string; code: string }[];
}

export interface Contract {
  id: string;
  employeeId: string;
  contractType: ContractType;
  startDate: string;
  endDate: string | null;
  termsMetadata: Record<string, unknown> | null;
  salaryAmount: string | null;
  currency: "INR";
  status: ContractStatus;
  supersedesContractId: string | null;
  createdAt: string;
}

export interface LeaveApplication {
  id: string;
  employeeId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  days: number;
  periodYear: number;
  reason: string;
  status: LeaveStatus;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
}

export type LeaveQueueRow = LeaveApplication & { employee: EmployeeBrief };

export interface LeaveBalance {
  leaveType: LeaveType;
  periodYear: number;
  entitlement: number;
  taken: number;
  remaining: number;
}

export interface LeavePolicy {
  leaveType: LeaveType;
  annualQuotaDays: number;
  accrualRule: AccrualRule;
  active: boolean;
}

export interface Shift {
  id: string;
  name: string;
  startMinute: number;
  endMinute: number;
  active: boolean;
}

export interface AttendanceRow {
  id: string;
  employeeId: string;
  attendanceDate: string;
  status: AttendanceStatus;
  source: AttendanceSource;
  shiftId: string | null;
}

export interface RosterRow {
  employee: EmployeeBrief;
  attendance: AttendanceRow | null;
}

export interface LeaveSummaryRow {
  employeeId: string;
  employeeNo: string;
  leaveType: LeaveType;
  periodYear: number;
  entitlement: number;
  taken: number;
  remaining: number;
}

export interface AttendanceSummaryRow {
  employeeId: string;
  employeeNo: string;
  present: number;
  absent: number;
  onLeave: number;
  halfDay: number;
  total: number;
}
