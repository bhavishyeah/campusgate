// Hand-written from api-contract.md. Dates are ISO strings. Money is string|null.

export type AssetKind = "FIXED_ASSET" | "CONSUMABLE";
export type AssetStatus = "IN_STORE" | "ASSIGNED" | "IN_MAINTENANCE" | "RETIRED" | "DISPOSED";
export type MaintenanceStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CANCELLED";
export type StockMovementKind = "RECEIPT" | "ISSUE" | "ADJUSTMENT";
export type DisposalMethod = "SOLD" | "SCRAPPED" | "DONATED" | "LOST" | "WRITTEN_OFF" | "OTHER";
export type TerminalStatus = "RETIRED" | "DISPOSED";

export interface Paged {
  total: number;
  page: number;
  pageSize: number;
}

export interface Category {
  id: string;
  name: string;
  code: string;
  kind: AssetKind;
  depreciationMethod: string | null;
  usefulLifeMonths: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Asset {
  id: string;
  assetTag: string;
  name: string;
  categoryId: string;
  status: AssetStatus;
  acquisitionDate: string | null;
  acquisitionCost: string | null;
  currency: string | null;
  location: string | null;
  custodyUserId: string | null;
  custodyDepartmentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustodyLedgerRow {
  id: string;
  assetId: string;
  toUserId: string | null;
  toDepartmentId: string | null;
  reason: string | null;
  transferredAt: string;
}

export interface MaintenanceRow {
  id: string;
  assetId: string;
  issue: string;
  status: MaintenanceStatus;
  assigneeUserId: string | null;
  cost: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface StockItem {
  id: string;
  assetId: string;
  onHandQuantity: number;
  reorderLevel: number | null;
  assetTag?: string | null;
  updatedAt?: string;
}

export interface StockMovement {
  id: string;
  stockItemId: string;
  kind: StockMovementKind;
  quantity: number;
  balanceAfter: number;
  reason: string | null;
  createdAt: string;
}

export interface AuditSession {
  id: string;
  name: string;
  status: "OPEN" | "CLOSED";
  createdAt: string;
  closedAt: string | null;
}

export interface AuditLine {
  id: string;
  auditSessionId: string;
  assetId: string | null;
  stockItemId: string | null;
  expectedQuantity: number | null;
  foundQuantity: number | null;
  note: string | null;
  createdAt: string;
}

export interface Disposal {
  id: string;
  assetId: string;
  terminalStatus: TerminalStatus;
  method: DisposalMethod;
  proceeds: string | null;
  currency: string | null;
  reason: string | null;
  disposedAt: string;
}

export interface UserLookupItem {
  id: string;
  email: string;
  name: string | null;
}
