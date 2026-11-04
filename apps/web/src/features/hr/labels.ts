export const employmentTypeLabel: Record<string, string> = {
  PERMANENT: "Permanent",
  CONTRACT: "Contract",
  PART_TIME: "Part time",
};
export const employeeStatusLabel: Record<string, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  TERMINATED: "Terminated",
};
export const contractTypeLabel: Record<string, string> = {
  PERMANENT: "Permanent",
  FIXED_TERM: "Fixed term",
  PROBATION: "Probation",
  CONSULTANT: "Consultant",
};
export const contractStatusLabel: Record<string, string> = {
  ACTIVE: "Active",
  SUPERSEDED: "Superseded",
  ENDED: "Ended",
};
export const leaveTypeLabel: Record<string, string> = {
  CASUAL: "Casual",
  SICK: "Sick",
  EARNED: "Earned",
  UNPAID: "Unpaid",
  OTHER: "Other",
};
export const leaveStatusLabel: Record<string, string> = {
  REQUESTED: "Requested",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};
export const accrualRuleLabel: Record<string, string> = {
  ANNUAL_LUMP_SUM: "Annual lump sum",
  MONTHLY_ACCRUAL: "Monthly accrual",
};
export const attendanceStatusLabel: Record<string, string> = {
  PRESENT: "Present",
  ABSENT: "Absent",
  ON_LEAVE: "On leave",
  HALF_DAY: "Half day",
};
export const attendanceSourceLabel: Record<string, string> = {
  MANUAL: "Manual",
  DERIVED: "Derived",
};

export function toOptions(labels: Record<string, string>): { value: string; label: string }[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}

/** Leave types in the fixed enum order. */
export const LEAVE_TYPES = ["CASUAL", "SICK", "EARNED", "UNPAID", "OTHER"] as const;

/** Employees have no name of their own: show the profile name when present, else the email. */
export function displayName(e: { name: string | null; email: string }): string {
  return e.name && e.name.trim() !== "" ? e.name : e.email;
}
