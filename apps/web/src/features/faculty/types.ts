export type FacultyStatus = "ACTIVE" | "INACTIVE";
export type QualificationKind = "DEGREE" | "CERTIFICATION" | "DIPLOMA" | "OTHER";
export type AssignmentRole = "PRIMARY" | "SUBSTITUTE" | "ASSISTANT";
export type HistoryChangeType = "ASSIGNED" | "ENDED";

export interface FacultyIdentity {
  id: string;
  userId: string;
  name: string;
  departmentId: string | null;
  department: { id: string; name: string } | null;
  status: FacultyStatus;
}

export interface FacultyListItem {
  id: string;
  userId: string;
  name: string;
  departmentId: string | null;
  department: { id: string; name: string } | null;
  status: FacultyStatus;
  createdAt: string;
  updatedAt: string;
}

export interface FacultyListResponse {
  faculty: FacultyListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FacultyLookups {
  terms: {
    id: string;
    name: string;
    status: string;
    startDate: string;
    endDate: string;
    session: { id: string; name: string } | null;
  }[];
  departments: { id: string; name: string; code: string }[];
}

export interface Qualification {
  id: string;
  facultyId: string;
  kind: QualificationKind;
  title: string;
  issuingBody: string | null;
  field: string | null;
  year: number | null;
  documentRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkloadRow {
  id: string;
  facultyId: string;
  academicTermId: string;
  academicTerm: { id: string; name: string } | null;
  teachingHours: number;
  nonTeachingHours: number;
  totalHours: number;
  overAllocated: boolean;
  overrideReason: string | null;
  policyMaxWeeklyHours: number | null;
  lastReconciledAt: string | null;
  updatedAt: string;
}

export interface WorkloadResult extends WorkloadRow {
  unestimatedSubjectIds?: string[];
  excludedAssignmentIds?: string[];
}

export interface TeachingHistoryRow {
  id: string;
  facultyId: string;
  subjectId: string;
  classSectionId: string | null;
  academicTermId: string;
  sourceAssignmentId: string | null;
  role: AssignmentRole;
  changeType: HistoryChangeType;
  effectiveAt: string;
  recordedByUserId: string;
  createdAt: string;
  subject: { id: string; name: string; code: string } | null;
  classSection: { id: string; label: string | null } | null;
  academicTerm: { id: string; name: string } | null;
}

export interface FacultyProfile {
  identity: FacultyIdentity;
  qualifications: Qualification[];
  workloads: WorkloadRow[];
  teachingHistory: TeachingHistoryRow[];
}

export interface WorkloadPolicy {
  id: string;
  maxWeeklyHours: number;
}
