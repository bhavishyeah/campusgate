// ─── Enums ───────────────────────────────────────────────────────────────────
export type ExaminationType = "MIDTERM" | "FINAL" | "INTERNAL" | "SUPPLEMENTARY";

export type ExaminationStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "MARKS_OPEN"
  | "MARKS_LOCKED"
  | "MODERATION"
  | "APPROVED"
  | "PUBLISHED";

/** Targets accepted by POST /api/exams/:id/status (PUBLISHED is not one). */
export type ExamStatusTarget =
  | "SCHEDULED"
  | "MARKS_OPEN"
  | "MARKS_LOCKED"
  | "MODERATION"
  | "APPROVED";

export type MarkChangeType = "MARKED" | "CORRECTED";
export type PublicationStatus = "PUBLISHED" | "SUPERSEDED";

// ─── Entities ────────────────────────────────────────────────────────────────
export interface Exam {
  id: string;
  academicSessionId: string;
  academicTermId: string;
  programId: string;
  name: string;
  type: ExaminationType;
  status: ExaminationStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExamSchedule {
  id: string;
  institutionId: string;
  examId: string;
  subjectId: string;
  room: string;
  roomCapacity: number;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Raw Prisma Candidate row (GET :id/candidates applies no projection). */
export interface Candidate {
  id: string;
  institutionId: string;
  examId: string;
  studentId: string;
  examScheduleId: string | null;
  seatNo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Assessment {
  id: string;
  institutionId: string;
  examId: string;
  subjectId: string;
  name: string;
  maxMarks: number;
  weight: number;
  createdAt: string;
  updatedAt: string;
}

export interface MarksRecord {
  id: string;
  examId: string;
  assessmentId: string;
  candidateId: string;
  marks: number;
  changeType: MarkChangeType;
  createdAt: string;
  updatedAt: string;
}

export interface WrittenMarkRecord {
  marksRecordId: string;
  changeType: MarkChangeType;
}

export interface ResultPublication {
  id: string;
  examId: string;
  version: number;
  status: PublicationStatus;
  publishedAt: string;
  reason: string | null;
}

export interface ResultSnapshot {
  studentId: string;
  candidateId: string;
  subjectId: string;
  percentBps: number;
  gradeLabel: string;
  gradePoints: number;
  passed: boolean;
}

export interface Result {
  publications: ResultPublication[];
  latestVersion: number | null;
  snapshots: ResultSnapshot[];
}

/** GET /api/exams/me/results list row. */
export interface MyResultExam {
  examId: string;
  version: number;
  snapshots: ResultSnapshot[];
}

/** GET /api/exams/me/results/:examId body (no examId in the body). */
export interface MyResultDetail {
  published: true;
  version: number;
  snapshots: ResultSnapshot[];
}

export interface MyResultHistorySubject {
  subjectId: string;
  percentBps: number;
  gradeLabel: string;
  gradePoints: number;
  passed: boolean;
}

export interface MyResultHistoryEntry {
  examId: string;
  examName: string | null;
  examType: string | null;
  academicSessionId: string | null;
  academicTermId: string | null;
  parentExaminationId: string | null;
  version: number;
  publishedAt: string;
  subjects: MyResultHistorySubject[];
}

export interface GradingBand {
  minPercentBps: number;
  maxPercentBps: number;
  gradeLabel: string;
  gradePoints: number;
  isPassing: boolean;
  ordinal?: number;
}

export interface GradingScheme {
  id: string;
  institutionId: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  bands: GradingBand[];
}

export interface ExamDistribution {
  latestVersion: number | null;
  gradeDistribution: Record<string, number>;
  passed: number;
  failed: number;
}

export interface SubjectRollup {
  subjectId: string;
  count: number;
  passed: number;
  failed: number;
  avgPercentBps: number;
}

export interface ExamRollups {
  latestVersion: number | null;
  perSubject: SubjectRollup[];
}

export interface PublishResult {
  publicationId: string;
  version: number;
  snapshotCount: number;
}
