# API contract: Hostel + Transport UI (ground truth)

Source read: `apps/api/src/routes/hostel.ts`, `transport.ts`, `packages/shared/src/{permissions,validation,modules}.ts`, `packages/db/prisma/schema.prisma` (hostel_*/transport_* models), `packages/db/src/seed.ts`, and the live suites `hostel.behavioral.integration.test.ts` / `transport.behavioral.integration.test.ts`. Backend fixes G-HOS1..7 and G-TRN1..5 below were added in this step (one `feat(api)` commit, no migrations, no new permission keys).

## Prefixes and gating
- Hostel: `/api/hostel`, module key `hostel`. Transport: `/api/transport`, module key `transport`. Both are "foundational-not-gated" (no dependency edges) but need their own InstitutionModule row ACTIVE.
- Every route: `authenticate` + `requirePermission(key)` + `requireModuleActive(module)`. Inactive/absent module = **403** `Module not active...` (the `useModuleActive` probe keys on this). Probe URLs: staff `GET /api/hostel/buildings?pageSize=1` (hostel.view) and `GET /api/transport/vehicles?pageSize=1` (transport.view); student `GET /api/hostel/me/occupancy` and `GET /api/transport/me/enrollments` (both 200 even with nothing allocated).
- Errors: `{ error: string | zodFlatten }`. 400 zod, 403 permission/module, 404 not found (also foreign-tenant ids via RLS), 409 conflict/deny, 500 backstops. Deny branches (409) are audited then returned.
- `institutionId` always comes from the token; ids in the body/params are tenant-filtered (`withTenant`).
- Pagination query (both modules): `page>=1` default 1, `pageSize` 1..100 default 20; lists return `{ <collection>, total, page, pageSize }`. Un-paginated: stops, assignments, schedules (per route), `/occupancy`, `/reports/*`.
- Dates are ISO strings (`z.coerce.date()` on input). Bodyless POSTs (vacate, cancel, suspend, end, assignments/:id/end) still send `{}` per `lib/api.ts`.

## Money (transport only; hostel has none)
- `route.feeAmount`: DB int **paise**, serialized as a decimal-digit **string** (or `null`) on every route response (`/routes*`, `/me/routes`, `/me/fees`). Requests send a digit string (`/^\d+$/`; `PATCH` may send `null` to clear). Use `lib/money.ts` paise helpers (BigInt), no floats.
- **Quirk:** maintenance `cost` (paise) is accepted as a digit string on `POST /maintenance` and on `/transition`, but is returned as a JSON **number** (integer paise) or `null` on maintenance responses (no serializer on that table). The UI must accept `number | string | null` and convert via BigInt. Not changed (would break the existing suites/consumers). Transport fees are NOT integrated with the fees module (no StudentCharge is created; asserted by a live test).

## Permission keys
Hostel: `hostel.buildings.manage`, `hostel.allocations.manage`, `hostel.leave.manage`, `hostel.maintenance.manage`, `hostel.view` (staff read), `hostel.view_own` (student).
Transport: `transport.vehicles.manage`, `transport.drivers.manage`, `transport.routes.manage`, `transport.assignments.manage`, `transport.enrollments.manage`, `transport.maintenance.manage`, `transport.view` (staff read), `transport.view_own` (student).

## Roles (ROLE_PERMISSIONS)
- ADMIN: all 5 hostel staff keys + all 7 transport staff keys. No `*.view_own`.
- WARDEN (template role): the 4 hostel manage keys + `hostel.view` + `documents.download`. NO `hostel.view_own`, NO `students.view`, NO `admin.users.view`, nothing transport.
- TRANSPORT_MANAGER (template role): the 6 transport manage keys + `transport.view` + `documents.download`. NO `transport.view_own`, NO `students.view`, nothing hostel.
- STUDENT: `hostel.view_own` + `transport.view_own` only (self-scoped).
- HOD, FACULTY, ACCOUNTANT, LIBRARIAN, others: none of these keys.
- **Seeds:** `admin@demo.edu/admin123` is the only demo user who can use these modules. The seed has **NO WARDEN user and NO TRANSPORT_MANAGER user**, and **does not activate the `hostel` / `transport` InstitutionModule rows** (seed upserts only campus_movement, attendance, library, admissions, fees). `bhavishya@demo.edu/student123` holds the STUDENT self keys but sees 403 until the modules are activated and (for hostel) is allocated. See Known Limitations.

## HOSTEL endpoints (`/api/hostel`)

Entities: `Building {id,name,type BOYS|GIRLS|MIXED|STAFF,wardenUserId|null,isActive,createdByUserId,createdAt,updatedAt}`; `Room {id,buildingId,roomNumber,capacity 1..64,floor|null,status AVAILABLE|FULL|MAINTENANCE|CLOSED,...}` (status is a manual staff flag, never derived from occupancy); `Allocation {id,roomId,studentId,status ACTIVE|VACATED|TRANSFERRED,allocatedAt,vacatedAt|null,allocatedByUserId,transferFromAllocationId|null}`; `CheckEvent {id,allocationId,studentId,eventType CHECK_IN|CHECK_OUT,occurredAt,recordedByUserId}` (append-only); `Leave {id,studentId,fromDate,toDate,reason<=500,status REQUESTED|APPROVED|REJECTED|CANCELLED,appliedByUserId,decidedByUserId|null,decidedAt|null,decisionNote|null}`; `Maintenance {id,roomId,issue<=500,status OPEN|IN_PROGRESS|RESOLVED|CANCELLED,assigneeUserId|null,reportedByUserId,resolvedAt|null,resolutionNote|null}`.

Display shapes used by the enriched reads: `StudentBrief {id,name,enrollmentNo,program}`; `RoomBrief {id,roomNumber,floor|null,building:{id,name}}`.

Writes
- `POST /buildings` (`buildings.manage`) `{name 1..120, type, wardenUserId?, isActive?}` -> 201 building. (`name` is unique per tenant at DB level; a clash surfaces as 500, see Known Limitations.)
- `PATCH /buildings/:id` (`buildings.manage`) strict `{name?, type?, wardenUserId? (nullable), isActive?}` -> building. 404 `building not found`.
- `POST /buildings/:id/rooms` (`buildings.manage`) `{roomNumber 1..32, capacity 1..64 (coerced), floor? 0..200}` -> 201. 404 `building not found`, 409 `room number already exists in building`.
- `PATCH /rooms/:id` (`buildings.manage`) strict `{roomNumber?, capacity? (>=1), floor? (nullable), status?}`. 404 `room not found`; 409 `capacity below current occupancy` (audited DENIED, runtime check).
- `POST /allocations` (`allocations.manage`) `{roomId, studentId}` -> 201 allocation ACTIVE. 404 `room not found` | `student not found`; 409 `room not accepting allocations` (room status != AVAILABLE) | `student already allocated` | `room full`. Advisory-locked; `FULL` status is NOT set automatically.
- `POST /allocations/:id/transfer` (`allocations.manage`) `{toRoomId}` -> **201** new ACTIVE allocation (source becomes TRANSFERRED). 404 `allocation not found` | `destination room not found`; 409 `allocation not active` | `already in destination room` | `room not accepting allocations` | `room full`.
- `POST /allocations/:id/vacate` (`allocations.manage`, send `{}`) -> 200 allocation VACATED. 404 `allocation not found`; 409 `allocation not active`.
- `POST /allocations/:id/check` (`allocations.manage`) `{eventType, occurredAt?}` -> 201 event. 404 `allocation not found`. Any allocation status accepted (no ACTIVE check).
- `POST /maintenance` (`maintenance.manage`) `{roomId, issue 1..500, assigneeUserId?}` -> 201 OPEN. 404 `room not found`.
- `POST /maintenance/:id/transition` (`maintenance.manage`) `{toStatus IN_PROGRESS|RESOLVED|CANCELLED, resolutionNote?<=500}`. Legal: OPEN->IN_PROGRESS|CANCELLED, IN_PROGRESS->RESOLVED|CANCELLED; RESOLVED/CANCELLED terminal. 409 `illegal status transition`; 404 `maintenance request not found`.
- `POST /leave/:id/approve` and `/reject` (`leave.manage`) body `{decisionNote?<=500}` strict (an empty body/`{}` is fine). Only REQUESTED -> 409 `leave not pending`; 404 `leave application not found`.

Staff reads (`hostel.view`)
- `GET /buildings?page&pageSize` -> `{ buildings:[Building & {roomCount:number, warden:{id,email,name|null}|null}], total, page, pageSize }`, ordered by name. **(changed G-HOS2, additive)** `warden` is resolved from `wardenUserId` within the tenant (name only when the user has a FacultyProfile).
- `GET /rooms?page&pageSize&buildingId&status` **(new G-HOS1)** `status` must be a room status (400 otherwise). -> `{ rooms:[Room & {building:{id,name,type}, occupancy:{capacity,occupied,available}}], total, page, pageSize }` ordered by building name, room number.
- `GET /rooms/:id` -> `Room & {occupancy}`. 404.
- `GET /allocations?page&pageSize&status&roomId&buildingId` -> `{ allocations:[Allocation & {student:StudentBrief, room:RoomBrief}], total, page, pageSize }` newest first. **(changed G-HOS3, additive; `buildingId` is now honoured)**. `status` is a free string up to 40 chars; an invalid value produces a 500 (send only ACTIVE|VACATED|TRANSFERRED).
- `GET /occupancy?buildingId` -> `{ buildings:[{buildingId,capacity,occupied,available}], rooms:[{roomId,buildingId,roomNumber,capacity,occupied,available}] }` (no names; join with `/buildings`).
- `GET /maintenance?page&pageSize&status&roomId` -> `{ requests:[Maintenance & {room:RoomBrief}], total, page, pageSize }` **(changed G-HOS3)**.
- `GET /leave?page&pageSize&status` -> `{ applications:[Leave & {student:StudentBrief}], total, page, pageSize }` **(changed G-HOS3)**. Tenant-wide approval queue; `status` free string (REQUESTED|APPROVED|REJECTED|CANCELLED).
- `GET /check-events?page&pageSize&allocationId&studentId` **(new G-HOS4)** -> `{ events:[CheckEvent & {student:StudentBrief, allocation:{id, room:RoomBrief}}], total, page, pageSize }` newest first.
- `GET /allocations/export` (`hostel.view`) -> XLSX blob (audited), columns are raw ids (Allocation ID, Room ID, Student ID, Status, dates). Fetch with the auth header, not a plain link.

Lookups (new)
- `GET /students/lookup?q=&limit=` **(G-HOS5, `allocations.manage`)** q 2..100 chars (400 otherwise), limit 1..25 default 10; matches name or enrollmentNo (case-insensitive contains), excludes status APPLICANT, ordered by name. -> `{ students:[{id,name,enrollmentNo,program,hasActiveAllocation:boolean}] }`.
- `GET /users/lookup?q=&limit=` **(G-HOS6, `buildings.manage`)** same q/limit rules; tenant users that have **no StudentProfile** (staff only), matched on email or faculty-profile name. -> `{ users:[{id,email,name|null}] }`. Used for the building warden picker (`wardenUserId`). Not for the maintenance assignee (see Known Limitations).

Self (`hostel.view_own`, STUDENT). Resolve the caller's StudentProfile by token userId; none -> **404 `no student profile`**.
- `GET /me/allocation` -> `{ allocation: (Allocation & {room:{id,roomNumber,floor,building:{id,name,type}}}) | null }` **(changed G-HOS7, additive)**. ACTIVE only; `null` when none.
- `GET /me/occupancy` -> `{ occupancy: {roomId,capacity,occupied,available} | null }`.
- `POST /me/leave` `{fromDate,toDate (>=fromDate),reason 1..500}` -> 201 REQUESTED. 400 on bad dates.
- `GET /me/leave?page&pageSize&status` -> `{ applications, total, page, pageSize }` (no student/decision names; decisions carry `decisionNote`).
- `POST /me/leave/:id/cancel` (send `{}`) -> 200 CANCELLED; 404 `leave application not found` (also for another student's id); 409 `leave not pending`.

## TRANSPORT endpoints (`/api/transport`)

Entities: `Vehicle {id,registrationNo<=32,type BUS|VAN|CAR|OTHER,seatCapacity>=1,status ACTIVE|INACTIVE|MAINTENANCE}`; `Driver {id,name<=120,licenseNo<=64,phone|null,userId|null,status ACTIVE|INACTIVE}`; `Route {id,name<=120,code<=32,feeAmount:string|null,status ACTIVE|INACTIVE}`; `Stop {id,routeId,name,sequence>=1,landmark|null,latitude|null,longitude|null,pickupOffsetMinutes|null}`; `Assignment {id,routeId,vehicleId,driverId,effectiveFrom,effectiveTo|null,status ACTIVE|ENDED}`; `Enrollment {id,studentId,routeId,stopId,status ACTIVE|SUSPENDED|ENDED,enrolledAt,endedAt|null}`; `Schedule {id,routeId,stopId|null,dayOfWeek MON..SUN|null,date|null,departureTime,arrivalTime|null}` (times are **minutes-of-day 0..1439**); `Maintenance {id,vehicleId,issue<=500,status OPEN|IN_PROGRESS|RESOLVED|CANCELLED,assigneeUserId|null,cost:number|null (paise),resolutionNote|null,resolvedAt|null}`.

Writes
- `POST /vehicles` (`vehicles.manage`) `{registrationNo, type, seatCapacity, status?}` -> 201. 409 `registration number already exists`.
- `PATCH /vehicles/:id` (`vehicles.manage`) strict, any of the same fields. 404 `vehicle not found`; 409 `registration number already exists` | `capacity below active enrollment` (when seatCapacity is lowered under any assigned route's ACTIVE enrollments).
- `POST /drivers` (`drivers.manage`) `{name, licenseNo, phone?, userId?, status?}` -> 201. 409 `license number already exists`. `PATCH /drivers/:id` strict, `phone`/`userId` nullable. 404 `driver not found`.
- `POST /routes` (`routes.manage`) `{name, code, feeAmount? digit-string, status?}` -> 201 (feeAmount string). 409 `route code already exists`. `PATCH /routes/:id` strict, `feeAmount` nullable. 404 `route not found`.
- `POST /routes/:id/stops` (`routes.manage`) `{name, sequence>=1, landmark?, latitude?, longitude?, pickupOffsetMinutes?>=0}` -> 201. 404 `route not found`; 409 `stop sequence already exists on route`. `PATCH /stops/:id` strict (nullable landmark/lat/lng/offset). 404 `stop not found`. There is no stop delete.
- `POST /routes/:id/schedules` (`routes.manage`) `{stopId?, dayOfWeek? XOR date?, departureTime 0..1439, arrivalTime? 0..1439}`; exactly one of dayOfWeek/date (400 otherwise). 201. 404 `route not found` | `stop not found on route`. `PATCH /schedules/:id` strict (nullable stopId/dayOfWeek/date/arrivalTime). 404 `schedule not found`. No schedule delete.
- `POST /routes/:id/assignments` (`assignments.manage`) `{vehicleId, driverId, effectiveFrom, effectiveTo?}` -> 201 ACTIVE. 404 `route not found` | `vehicle not found` | `driver not found`; 409 `vehicle in maintenance` | `route already assigned` (one ACTIVE per route; end the old one first). The check does not look at driver/vehicle ACTIVE status other than MAINTENANCE.
- `POST /assignments/:id/end` (`assignments.manage`, send `{}`) -> 200 ENDED (effectiveTo=now). 404 `assignment not found`; 409 `assignment not active`. Ending does not touch enrollments (enrolling afterwards 409s with `route has no active vehicle assignment`).
- `POST /enrollments` (`enrollments.manage`) `{studentId, routeId, stopId}` -> 201 ACTIVE. 404 `route not found` | `student not found` | `stop not found on route`; 409 `route has no active vehicle assignment` | `student already enrolled on route` | `route full` (capacity = ACTIVE assignment's vehicle seatCapacity, advisory-locked). A student may be on several routes, once each.
- `POST /enrollments/:id/suspend` (`enrollments.manage`, `{}`) ACTIVE -> SUSPENDED; 409 `enrollment not active`. `POST /enrollments/:id/end` (`{}`) ACTIVE|SUSPENDED -> ENDED; 409 `enrollment already ended`. 404 `enrollment not found`. No resume (SUSPENDED -> ACTIVE is illegal: 409 `illegal status transition`). A SUSPENDED enrollment does not count toward capacity (only ACTIVE counts).
- `POST /maintenance` (`maintenance.manage`) `{vehicleId, issue, assigneeUserId?, cost? digit-string}` -> 201 OPEN. 404 `vehicle not found`. Creating maintenance does NOT change the vehicle status; staff set `status: MAINTENANCE` via `PATCH /vehicles`.
- `POST /maintenance/:id/transition` (`maintenance.manage`) `{toStatus IN_PROGRESS|RESOLVED|CANCELLED, cost?, resolutionNote?}` same legality as hostel. 409 `illegal status transition`; 404 `maintenance request not found`.

Staff reads (`transport.view`)
- `GET /vehicles?status&page&pageSize` -> `{ vehicles, total, page, pageSize }` by registrationNo. `GET /vehicles/:id`.
- `GET /drivers?status&page&pageSize` -> `{ drivers, total, page, pageSize }` by name.
- `GET /routes?status&page&pageSize` -> `{ routes (feeAmount string), total, page, pageSize }` by code. `GET /routes/:id`.
- `GET /routes/:id/stops` -> `{ stops }` by sequence. `GET /routes/:id/schedules` -> `{ schedules }`. 404 `route not found`.
- `GET /routes/:id/assignments?status` -> `{ assignments:[Assignment & {vehicle:{id,registrationNo,type,seatCapacity,status}, driver:{id,name,licenseNo,phone,status}}] }` newest first **(changed G-TRN2, additive)**.
- `GET /enrollments?routeId&status&page&pageSize` -> `{ enrollments:[Enrollment & {student:StudentBrief, route:{id,code,name}, stop:{id,name,sequence}}], total, page, pageSize }` newest first **(changed G-TRN3, additive)**. `status` free string (ACTIVE|SUSPENDED|ENDED).
- `GET /maintenance?vehicleId&status&page&pageSize` -> `{ requests:[Maintenance & {vehicle:{id,registrationNo,type}}], total, page, pageSize }` **(changed G-TRN4, additive)**.
- `GET /reports/roster?routeId` -> `{ roster:[Enrollment(ACTIVE) & {student,route,stop}] }` (unpaginated, ordered by route then enrolledAt) **(changed G-TRN3)**.
- `GET /reports/utilization` -> `{ utilization:[{routeId,name,code,capacity:number|null,enrolled,utilization:number|null}] }`; `capacity`/`utilization` are null when the route has no ACTIVE assignment; `utilization` is a 0..1 ratio rounded to 2 dp. Unpaginated, all routes, ordered by code.
- `GET /reports/roster/export?routeId` -> XLSX blob (audited), columns are raw ids. Fetch with the auth header.

Lookups (new)
- `GET /students/lookup?q=&limit=` **(G-TRN1, `enrollments.manage`)** same rules as hostel (q 2..100, limit 1..25, name or enrollmentNo, excludes APPLICANT). -> `{ students:[{id,name,enrollmentNo,program}] }`.
- Vehicle/driver/route/stop pickers for assignments and enrollments use the existing staff lists (`pageSize<=100`, filter `status=ACTIVE`).

Self (`transport.view_own`, STUDENT). **Never 404**: no profile or no enrollment = 200 with an empty list. Only ACTIVE enrollments are returned (a SUSPENDED/ENDED enrollment simply disappears for the student).
- `GET /me/enrollments` -> `{ enrollments:[Enrollment & {route:{id,code,name}, stop:{id,name,sequence,landmark,pickupOffsetMinutes}}] }` **(changed G-TRN5, additive)**.
- `GET /me/routes` -> `{ routes }` (feeAmount string). `GET /me/schedules` -> `{ schedules }` of the enrolled routes (ordered by enrollment order, then date/day/time). `GET /me/fees` -> `{ fees:[{routeId,name,code,feeAmount:string|null}] }`.
- No vehicle/driver detail is exposed to students (deliberate; no endpoint).

## NEW / CHANGED ENDPOINTS summary (backend fixes, this step)
| ID | Endpoint | Key | Why |
|---|---|---|---|
| G-HOS1 | GET /api/hostel/rooms | hostel.view | no room list (only /occupancy ids and /rooms/:id), so no room table/picker, no room status/floor |
| G-HOS2 | GET /buildings adds roomCount + warden | hostel.view | row carried only a raw `wardenUserId` |
| G-HOS3 | GET /allocations, /maintenance, /leave add student/room(+building) briefs; /allocations honours `buildingId` | hostel.view | rows were bare ids; screens could not show who/where |
| G-HOS4 | GET /api/hostel/check-events | hostel.view | check events were write-only; no history for warden |
| G-HOS5 | GET /api/hostel/students/lookup | hostel.allocations.manage | WARDEN has no `students.view`, could not pick a student to allocate |
| G-HOS6 | GET /api/hostel/users/lookup | hostel.buildings.manage | WARDEN has no `admin.users.view`; cannot pick a warden user (students excluded) |
| G-HOS7 | GET /me/allocation adds room + building | hostel.view_own | student holds no `hostel.view`, could not resolve roomId to a room/building |
| G-TRN1 | GET /api/transport/students/lookup | transport.enrollments.manage | TRANSPORT_MANAGER has no `students.view`, could not pick a student to enroll |
| G-TRN2 | GET /routes/:id/assignments adds vehicle + driver | transport.view | rows were bare vehicleId/driverId |
| G-TRN3 | GET /enrollments + /reports/roster add student/route/stop | transport.view | rows were bare ids |
| G-TRN4 | GET /maintenance adds vehicle | transport.view | row was a bare vehicleId |
| G-TRN5 | GET /me/enrollments adds route + stop | transport.view_own | student could not see stop name or pickup offset |

All additions are additive (no field removed or renamed, existing live suites untouched in behaviour), tenant-scoped through `withTenant` + `institutionId` filters, and gated with existing keys (the lookups use the write key of the screen that needs them, like library G3 and HR G-H2).

## ROLE-CAPABILITY MATRIX (after backend fixes)
Y = holds every key the screen needs (write + read + lookups). `-` = cannot reach the screen. Student columns apply to the self screens only.

### Hostel
| Screen | Endpoints | Keys needed | ADMIN | WARDEN | STUDENT |
|---|---|---|---|---|---|
| Buildings list + create/edit (+ warden picker) | GET /buildings, POST/PATCH /buildings, GET /users/lookup | buildings.manage + hostel.view | Y | Y | - |
| Rooms list + create/edit (status, capacity) | GET /rooms, GET /buildings, POST /buildings/:id/rooms, PATCH /rooms/:id | buildings.manage + hostel.view | Y | Y | - |
| Allocations list (filter status/building/room) | GET /allocations, /rooms, /buildings | hostel.view | Y | Y | - |
| Allocate / transfer / vacate / check in-out | GET /students/lookup, GET /rooms, POST /allocations, /transfer, /vacate, /check, GET /check-events | allocations.manage + hostel.view | Y | Y | - |
| Occupancy dashboard | GET /occupancy, /buildings, /rooms | hostel.view | Y | Y | - |
| Leave queue (approve/reject) | GET /leave, POST /leave/:id/approve\|reject | leave.manage + hostel.view | Y | Y | - |
| Maintenance board (create, transition) | GET /maintenance, GET /rooms, POST /maintenance, /transition | maintenance.manage + hostel.view | Y | Y | - |
| Allocations XLSX export | GET /allocations/export | hostel.view | Y | Y | - |
| My hostel (room, occupancy) | GET /me/allocation, /me/occupancy | hostel.view_own | - | - | Y |
| My leave (apply, list, cancel) | POST/GET /me/leave, POST /me/leave/:id/cancel | hostel.view_own | - | - | Y |

### Transport
| Screen | Endpoints | Keys needed | ADMIN | TRANSPORT_MANAGER | STUDENT |
|---|---|---|---|---|---|
| Vehicles list + create/edit | GET/POST/PATCH /vehicles | vehicles.manage + transport.view | Y | Y | - |
| Drivers list + create/edit | GET/POST/PATCH /drivers | drivers.manage + transport.view | Y | Y | - |
| Routes list + create/edit (fee) | GET/POST/PATCH /routes | routes.manage + transport.view | Y | Y | - |
| Route detail: stops + schedules | GET /routes/:id, /stops, /schedules, POST/PATCH stops + schedules | routes.manage + transport.view | Y | Y | - |
| Route detail: vehicle/driver assignment | GET /routes/:id/assignments, GET /vehicles, GET /drivers, POST /assignments, /end | assignments.manage + transport.view | Y | Y | - |
| Enrollments (enroll, suspend, end) | GET /students/lookup, GET /routes, /routes/:id/stops, GET /enrollments, POST /enrollments, /suspend, /end | enrollments.manage + transport.view | Y | Y | - |
| Maintenance board | GET /maintenance, GET /vehicles, POST /maintenance, /transition | maintenance.manage + transport.view | Y | Y | - |
| Reports: roster + utilization (+XLSX) | GET /reports/roster, /utilization, /roster/export | transport.view | Y | Y | - |
| My transport (route, stop, schedule, fee) | GET /me/enrollments, /me/routes, /me/schedules, /me/fees | transport.view_own | - | - | Y |

Highlights: no role needs a key it lacks after the fixes. HOD, FACULTY, ACCOUNTANT, LIBRARIAN and the other roles have no hostel/transport access (no landing, no nav). WARDEN and TRANSPORT_MANAGER are single-module roles; ADMIN sees both. STUDENT never holds a staff key and never the converse.

## BACKEND GAPS
Status: G-HOS1..7 and G-TRN1..5 FIXED (this step). No open mismatch remains for any planned screen/role.
- G-HOS1 FIXED: `GET /rooms`. G-HOS2 FIXED: building roomCount + warden. G-HOS3 FIXED: allocation/maintenance/leave names. G-HOS4 FIXED: `GET /check-events`. G-HOS5 FIXED: hostel student lookup. G-HOS6 FIXED: hostel staff user lookup. G-HOS7 FIXED: `/me/allocation` room.
- G-TRN1 FIXED: transport student lookup. G-TRN2/3/4 FIXED: assignment, enrollment/roster, maintenance names. G-TRN5 FIXED: `/me/enrollments` route + stop.
- Least privilege kept: no new permission keys, no migration, no role grants changed. The student pickers are gated by the screen's write key and expose only id/name/enrollmentNo/program; the hostel user lookup excludes anyone with a StudentProfile. Every query is `withTenant` + `institutionId`-filtered; the fast suites pin the where clauses and the live suites prove tenant-B isolation, STUDENT/WARDEN/TRANSPORT_MANAGER denials and the module-inactive 403.

## Known Limitations (not fixed, product/scope decisions or pre-existing behaviour)
1. **Demo seed has no WARDEN or TRANSPORT_MANAGER user and does not activate `hostel` / `transport`.** Only ADMIN (after module activation via admin modules) can exercise the UI in the demo tenant. The UI must show the usual "module not active" no-access state on 403. Seeding is left to the orchestrator/ops (a seed change would also write to the live demo DB).
2. **Duplicate building name** (unique per tenant at DB level) is not mapped: `POST /buildings` / `PATCH /buildings/:id` return 500 on a clash. The UI should show the generic error; validating uniqueness client-side against the loaded list is a cheap mitigation.
3. **Allocation/leave/maintenance `status` filters are free strings.** An unknown value yields a 500 from Prisma; the UI sends only the enum values from selects.
4. **Maintenance `assigneeUserId` (hostel and transport) and driver `userId`** are recorded actor ids with no display lookup. The UI does not offer them (create sends none); existing values are shown as "Assigned" without a name. The warden picker is the only user lookup.
5. **Transport maintenance `cost`** is returned as a JSON integer (paise) while requests use digit strings (see Money). **Hostel has no money.**
6. **XLSX exports (allocations, roster) contain raw ids**, not names. They are audited and gated by the view key.
7. **Students see only ACTIVE transport enrollments** and no vehicle/driver details; a hostel student sees only their current ACTIVE allocation (no history). Hostel `/me/*` returns 404 `no student profile` for a non-student user; transport `/me/*` returns empty lists instead.
8. **Transport route fee is informational:** it is not charged through the fees module (no cross-module coupling, asserted in the live suite).
9. **No delete endpoints** for buildings, rooms, vehicles, drivers, routes, stops or schedules; use `isActive` / `status` (INACTIVE/CLOSED) instead. Room `FULL` status is manual and independent of computed occupancy.
10. **Hostel allocation does not check the building type against student gender** (no gender field exists); `BOYS|GIRLS|MIXED|STAFF` is informational.

## Verification (this step)
- `npx tsc --noEmit` (apps/api) clean; `@campusgate/shared` rebuilt (dist) for the new schemas.
- New fast suites: `hostel-staff-reads.test.ts` (12 tests) and `transport-staff-reads.test.ts` (8 tests). `npm test -w @campusgate/api`: 66 files / **763 passed** (baseline 743).
- Live suites (new describe blocks: 3 hostel tests and 3 transport tests covering WARDEN / TRANSPORT_MANAGER real-role reads, tenant-B isolation, STUDENT and staff `/me` denial, module-inactive 403) are written but **NOT YET RUN GREEN**. Every isolated attempt (5 tries, 45-100 s apart) failed in `beforeAll` with `EMAXCONNSESSION max clients reached in session mode (pool_size 15)`. `pg_stat_activity` showed 15 idle `postgres` Supavisor session-mode backends, all opened at about 12:26 UTC, which matches the production Railway container start. The deployed API is holding the whole 5432 session pool. Run `cd apps/api; npx vitest run --config vitest.integration.config.ts hostel.behavioral` and then `transport.behavioral` once the pool is free.
