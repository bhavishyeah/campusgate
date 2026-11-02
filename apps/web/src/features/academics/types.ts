export type SessionStructureType = "SEMESTER" | "TRIMESTER" | "ANNUAL";
export type SessionStatus = "UPCOMING" | "ACTIVE" | "CLOSED";
export type TermStatus = "UPCOMING" | "ACTIVE" | "CLOSED";
export type ProgramStatus = "ACTIVE" | "INACTIVE";
export type DurationUnit = "YEARS" | "SEMESTERS" | "MONTHS";

export interface Warning {
  code: string;
  message: string;
}

export interface AcademicTerm {
  id: string;
  sessionId: string;
  name: string;
  ordinal: number;
  status: TermStatus;
  startDate: string; // ISO date string
  endDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface AcademicSession {
  id: string;
  institutionId: string;
  name: string;
  structureType: SessionStructureType;
  status: SessionStatus;
  startDate: string;
  endDate: string;
  createdAt: string;
  updatedAt: string;
  terms?: AcademicTerm[]; // present on detail endpoint only
}

export interface Program {
  id: string;
  institutionId: string;
  departmentId: string;
  name: string;
  code: string;
  duration: number;
  durationUnit: DurationUnit;
  status: ProgramStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AcademicCalendarDay {
  id: string;
  institutionId: string;
  date: string; // YYYY-MM-DD
  dayType: string; // WORKING | HOLIDAY | EXAM | EVENT
  note: string | null;
  academicSessionId: string | null;
  academicTermId: string | null;
  departmentId: string | null;
  createdAt: string;
  updatedAt: string;
}
