// Hand-written from api-contract.md. Dates are ISO strings. No money fields.

export type FieldType = "TEXT" | "NUMBER" | "DATE" | "SELECT";
export type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type RequestStatus =
  | "OPEN"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "PENDING_APPROVAL"
  | "RESOLVED"
  | "CLOSED"
  | "REJECTED"
  | "CANCELLED";

export interface Paged {
  total: number;
  page: number;
  pageSize: number;
}

export interface RequestType {
  id: string;
  name: string;
  code: string;
  category: string;
  description: string | null;
  defaultAssigneeRole: string | null;
  defaultAssigneeDepartmentId: string | null;
  slaTargetHours: number;
  requiresApproval: boolean;
  isActive: boolean;
}

/** The G-SR2 /types/active requester-safe subset. */
export interface ActiveType {
  id: string;
  name: string;
  category: string;
  description: string | null;
  requiresApproval: boolean;
  slaTargetHours: number;
  hasFields: boolean;
}

export interface FieldDef {
  id: string;
  fieldKey: string;
  label: string;
  dataType: FieldType;
  required: boolean;
  options: string[] | null;
  sortOrder: number;
}

export interface RequestRow {
  id: string;
  requestTypeId: string;
  title: string;
  priority: Priority;
  status: RequestStatus;
  requesterUserId: string;
  assigneeUserId: string | null;
  raisedAt: string;
  dueAt: string;
  isOverdue: boolean;
}

export interface Activity {
  id: string;
  kind: string;
  body: string | null;
  createdAt: string;
  actorUserId: string | null;
}

export interface Feedback {
  rating: number;
  comment: string | null;
  createdAt: string;
}

export interface RequestDetail extends RequestRow {
  description: string | null;
  fieldValues: Record<string, unknown>;
  activities: Activity[];
  feedback: Feedback | null;
}

export interface UserLookupItem {
  id: string;
  email: string;
  name: string | null;
}

export interface VolumeRow {
  requestTypeId: string;
  count: number;
}

export interface SlaReport {
  totalResolved: number;
  withinSla: number;
  compliancePct: number | null;
}

export interface FeedbackReport {
  count: number;
  averageRating: number | null;
}

export interface OverdueReport {
  atRiskHours: number;
  overdue: RequestRow[];
  atRisk: RequestRow[];
}

export interface ListResponse<T> extends Paged {
  data: T[];
}
