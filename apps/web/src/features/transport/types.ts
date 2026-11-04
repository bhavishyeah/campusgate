// Hand-written from the API contract. Dates are ISO strings; times are minutes of day.

export type VehicleType = "BUS" | "VAN" | "CAR" | "OTHER";
export type VehicleStatus = "ACTIVE" | "INACTIVE" | "MAINTENANCE";
export type DriverStatus = "ACTIVE" | "INACTIVE";
export type RouteStatus = "ACTIVE" | "INACTIVE";
export type EnrollmentStatus = "ACTIVE" | "SUSPENDED" | "ENDED";
export type AssignmentStatus = "ACTIVE" | "ENDED";
export type MaintenanceStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CANCELLED";
export type DayOfWeek = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN";

export interface Paged {
  total: number;
  page: number;
  pageSize: number;
}

export interface StudentBrief {
  id: string;
  name: string;
  enrollmentNo: string | null;
  program: string | null;
}

export interface Vehicle {
  id: string;
  registrationNo: string;
  type: VehicleType;
  seatCapacity: number;
  status: VehicleStatus;
}

export interface Driver {
  id: string;
  name: string;
  licenseNo: string;
  phone: string | null;
  userId: string | null;
  status: DriverStatus;
}

export interface Route {
  id: string;
  name: string;
  code: string;
  feeAmount: string | null;
  status: RouteStatus;
}

export interface Stop {
  id: string;
  routeId: string;
  name: string;
  sequence: number;
  landmark: string | null;
  latitude: number | null;
  longitude: number | null;
  pickupOffsetMinutes: number | null;
}

export interface Schedule {
  id: string;
  routeId: string;
  stopId: string | null;
  dayOfWeek: DayOfWeek | null;
  date: string | null;
  departureTime: number;
  arrivalTime: number | null;
}

export interface AssignmentRow {
  id: string;
  routeId: string;
  vehicleId: string;
  driverId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: AssignmentStatus;
  vehicle: { id: string; registrationNo: string; type: VehicleType; seatCapacity: number; status: VehicleStatus };
  driver: { id: string; name: string; licenseNo: string; phone: string | null; status: DriverStatus };
}

export interface EnrollmentRow {
  id: string;
  studentId: string;
  routeId: string;
  stopId: string;
  status: EnrollmentStatus;
  enrolledAt: string;
  endedAt: string | null;
  student: StudentBrief;
  route: { id: string; code: string; name: string };
  stop: { id: string; name: string; sequence: number };
}

export interface MaintenanceRow {
  id: string;
  vehicleId: string;
  issue: string;
  status: MaintenanceStatus;
  assigneeUserId: string | null;
  /** Integer paise as a JSON number from the API; accepted as a digit string too. */
  cost: number | string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
  vehicle: { id: string; registrationNo: string; type: VehicleType };
}

export interface UtilizationRow {
  routeId: string;
  name: string;
  code: string;
  capacity: number | null;
  enrolled: number;
  utilization: number | null;
}

export interface MyEnrollment {
  id: string;
  routeId: string;
  stopId: string;
  status: EnrollmentStatus;
  enrolledAt: string;
  route: { id: string; code: string; name: string };
  stop: { id: string; name: string; sequence: number; landmark: string | null; pickupOffsetMinutes: number | null };
}

export interface MyFee {
  routeId: string;
  name: string;
  code: string;
  feeAmount: string | null;
}

export interface StudentLookupItem extends StudentBrief {}
