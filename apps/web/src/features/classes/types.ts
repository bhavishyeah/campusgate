// features/classes/types.ts

export type SectionStatus = "PLANNED" | "ACTIVE" | "CLOSED" | "CANCELLED";
export type AssignmentRole = "PRIMARY" | "SUBSTITUTE" | "ASSISTANT";
export type AssignmentStatus = "ACTIVE" | "ENDED";
export type DayOfWeek = "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT";
export type ScheduledClassStatus = "SCHEDULED" | "CANCELLED";
export type TimetableStatus = "DRAFT" | "PUBLISHED";

export interface ClassSection {
  id: string;
  institutionId: string;
  programId: string;
  academicSessionId: string;
  academicTermId: string;
  label: string | null;
  capacity: number | null;
  status: SectionStatus;
  createdAt: string;
  updatedAt: string;
  // Only present on GET /sections/:id
  enrollments?: ClassEnrollment[];
}

export interface ClassEnrollment {
  id: string;
  classSectionId: string;
  studentId: string;
  status: string;
  enrolledAt: string;
}

export interface FacultyProfile {
  id: string;
  institutionId: string;
  userId: string;
  name: string;
  departmentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FacultyAssignment {
  id: string;
  institutionId: string;
  facultyId: string;
  subjectId: string;
  classSectionId: string | null;
  academicTermId: string;
  role: AssignmentRole;
  status: AssignmentStatus;
  endedAt: string | null; // set when status transitions to ENDED
  createdAt: string;
  updatedAt?: string; // NIT-10: optional — may not be present in all API responses
}

export interface Course {
  id: string;
  institutionId: string;
  programId: string;
  name: string;
  code: string;
  description: string | null;
  academicTermId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  subjects?: Subject[];
}

export interface Subject {
  id: string;
  courseId: string;
  name: string;
  code: string;
  credits: number | null;
  contactHoursPerWeek: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface Timetable {
  id: string;
  institutionId: string;
  academicTermId: string;
  name: string;
  status: TimetableStatus;
  createdAt: string;
  updatedAt: string;
  scheduledClasses?: ScheduledClass[];
}

export interface ScheduledClass {
  id: string;
  timetableId: string;
  classSectionId: string;
  subjectId: string;
  facultyId: string;
  academicTermId: string;
  room: string | null;
  dayOfWeek: DayOfWeek | null;
  date: string | null;
  startTime: number; // minute-of-day, 0..1440
  endTime: number;
  period: string | null;
  status: ScheduledClassStatus;
}

/** Placeholder — actual shape is not documented in the API contract. */
export interface ConflictReport {
  [key: string]: unknown;
}
