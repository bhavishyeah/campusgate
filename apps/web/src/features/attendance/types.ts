// features/attendance/types.ts

export type SessionStatus = "OPEN" | "SUBMITTED" | "FINALIZED";
export type AttendanceStatus = "PRESENT" | "ABSENT" | "LATE" | "EXCUSED";
export type CorrectionReviewStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface AttendanceSession {
  id: string;
  institutionId: string;
  scheduledClassId: string;
  date: string;               // ISO date string YYYY-MM-DD
  submissionDeadline: string | null;
  status: SessionStatus;
  submittedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  records?: AttendanceRecord[];
}

export interface AttendanceRecord {
  id: string;
  sessionId: string;
  studentId: string;
  status: AttendanceStatus;
  markedByUserId: string | null;
  markedAt: string | null;
}

export interface AttendanceCorrection {
  id: string;
  institutionId: string;
  attendanceRecordId: string;
  requestedStatus: AttendanceStatus;
  reason: string;
  reviewStatus: CorrectionReviewStatus;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SectionReportEntry {
  studentId: string;
  rate: number; // attendance rate, 0..100
}

export interface SectionReport {
  perStudent: SectionReportEntry[];
  lowAttendance: SectionReportEntry[];
  thresholdPercent: number;
}
