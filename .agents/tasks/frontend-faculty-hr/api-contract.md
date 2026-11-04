# API contract: Faculty Management + HR UI (ground truth)

Source read: `apps/api/src/routes/faculty.ts`, `hr.ts`, `classes.ts` (faculty create/assign), `admin.ts`, `packages/shared/src/{permissions,validation,modules}.ts`, `packages/db/src/seed.ts`. Backend fixes G1-G7 below were added in this step (feat(api) commit).

## Prefixes and gating
- Faculty: `/api/faculty`, module key `faculty_management`. HR: `/api/hr`, module key `hr_management`. Both foundational-not-gated in the dependency graph (no deps) but require their own InstitutionModule row ACTIVE.
- Every route: `authenticate` + `requirePermission(key)` + `requireModuleActive(module)`. Inactive module = 403 `Module not active...` (the `useModuleActive` probe keys on this).
- Errors: `{ error: string | zodFlatten }`. 400 zod, 403 permission/module, 404 not found (also for foreign-tenant ids via RLS), 409 conflict, 422 business rule (extra fields spread beside `error`), 500 backstops.
- Money: HR contract `salaryAmount` is a BIGINT minor-unit **string** (paise) or null, `currency` is always `INR`. Request `salaryAmount` is a JSON **number** (integer >= 0, <= MAX_SAFE_INTEGER). Use `lib/money.ts` paise helpers for display; send as number.
- Dates: HR leave/contract/joining dates are ISO strings; `attendanceDate` is `YYYY-MM-DD`. Leave start/end must share one calendar year; `days` is derived server-side (inclusive).

## Permission keys
Faculty: `faculty.qualifications.manage`, `faculty.workload.manage`, `faculty.teaching_history.manage`, `faculty.directory.view`, `faculty.view_own`.
HR: `hr.employees.manage`, `hr.contracts.manage`, `hr.leave.manage`, `hr.attendance.manage`, `hr.reports.view`, `hr.directory.view`, `hr.view_own`.

## Roles (ROLE_PERMISSIONS)
- ADMIN: all four faculty staff keys + all six HR staff keys. No `*.view_own`. Also holds `classes.faculty.assign`.
- HOD: four faculty staff keys (no HR keys, no `academics.*`, no `admin.departments.manage`). Also `classes.faculty.assign`.
- FACULTY: `faculty.view_own` only (plus `classes.view_own`, attendance/exams marking, documents). No staff faculty keys, no `hr.*`.
- HR_MANAGER: the six HR staff keys + `documents.download`. NO `hr.view_own`, NO `faculty.*`, NO `admin.users.view`, NO `admin.departments.manage`, NO `academics.*`.
- EMPLOYEE: `hr.view_own` + `documents.download` only. Template role bound automatically in the same tx when `POST /employees` creates the row (membership upserted if missing).
- STUDENT, ACCOUNTANT, others: none of these keys.
- Seeds: `admin@demo.edu/admin123`, `hod.bca@demo.edu/hod123` (HOD), `faculty.cs@demo.edu/faculty123` (FACULTY with FacultyProfile and assignments). **The demo seed has NO HR_MANAGER user and NO EMPLOYEE user, and the seed does not activate `faculty_management` / `hr_management` InstitutionModule rows** (seed.ts upserts only campus_movement, attendance, library, admissions, fees...). See Known Limitations.

## FACULTY endpoints (`/api/faculty`)
Identity: `FacultyProfile {id, userId, name, departmentId, status ACTIVE|INACTIVE}`. Profiles are created via `POST /api/classes/faculty` (`classes.faculty.assign`, body `{userId, name, departmentId?}`, 404 user/department not found, 409 `faculty profile already exists for user`); assignments via `POST /api/classes/faculty/assign`. Faculty Management itself does not create profiles.

Staff reads (`faculty.directory.view`)
- `GET /` (**new G1**) query `q` (name contains), `departmentId`, `status`, `page`, `pageSize` (<=100, default 20). -> `{ faculty:[{id,userId,name,departmentId,department:{id,name}|null,status,createdAt,updatedAt}], total, page, pageSize }`, ordered by name. 400 on bad query.
- `GET /lookups` (**new G2**) -> `{ terms:[{id,name,status,startDate,endDate,session:{id,name}|null}] (newest first), departments:[{id,name,code}] }`.
- `GET /:facultyId/profile` -> `{ identity{...,department}, qualifications[], workloads[], teachingHistory[] }`. 404 `faculty not found`.
- `GET /:facultyId/qualifications` -> `{ qualifications }`.
- `GET /:facultyId/workload` -> `{ workloads }` each with `policyMaxWeeklyHours` (null = uncapped) and (**new**) `academicTerm:{id,name}|null`.
- `GET /:facultyId/teaching-history` -> `{ teachingHistory }` each with (**new**) `subject:{id,name,code}|null`, `classSection:{id,label}|null`, `academicTerm:{id,name}|null`. Ledger is append-only.
- Existing fields on all rows are unchanged; the name fields are additive.

Staff writes
- `POST /:facultyId/qualifications` (`qualifications.manage`) body `{title, kind? DEGREE|CERTIFICATION|DIPLOMA|OTHER, issuingBody?, field?, year? 1900..nextYear, documentRef?<=2048}` -> 201. 404 `faculty not found`. `documentRef` is a reference string, not an upload.
- `PATCH /:facultyId/qualifications/:id` same fields, at least one, -> 200; 404 `qualification not found`.
- `DELETE /:facultyId/qualifications/:id` -> 204; 404.
- `GET/PUT /workload-policy` (`workload.manage`) -> `{policy:{id,maxWeeklyHours,...}|null}` / body `{maxWeeklyHours:int 1..168}` -> policy.
- `POST /:facultyId/workload/:academicTermId/recompute` (`workload.manage`) no body. Derives teachingHours from ACTIVE PRIMARY assignments x `Subject.contactHoursPerWeek`. -> workload + `unestimatedSubjectIds[]`, `excludedAssignmentIds[]` (now also `academicTerm` is NOT on this response; fetch via list). 404 `faculty not found` | `academic term not found`.
- `PATCH /:facultyId/workload/:academicTermId` (`workload.manage`) body `{nonTeachingHours? int 0..168, override? boolean, overrideReason? 1..500 (required when override true)}`. Over policy cap and no override -> **422** `{error:"workload exceeds policy max", maxWeeklyHours, totalHours}`. Same response extras as recompute.
- `POST /:facultyId/teaching-history/reconcile` (`teaching_history.manage`) no body -> `{appended:number}`.

Self (`faculty.view_own`)
- `GET /me/profile` -> same shape as `/:facultyId/profile`. 403 `not a faculty member` when the caller has no ACTIVE FacultyProfile. Never takes an id.

## HR endpoints (`/api/hr`)
Employee: `{id,userId,employeeNo,designation|null,employmentType PERMANENT|CONTRACT|PART_TIME,departmentId|null,joiningDate,status ACTIVE|INACTIVE|TERMINATED,createdByUserId,updatedByUserId,createdAt,updatedAt}`. The row has no name; `User` has no name column (email only). A display `name` exists only when the user also has a Student/Faculty profile, so `name` is nullable and the UI must fall back to email.

Employees
- `POST /employees` (`employees.manage`) body `{userId, employeeNo<=64, designation?, employmentType, departmentId?, joiningDate, status?}` -> 201. 409 `employee already exists` (userId or employeeNo clash message: `employee already exists` for either unique), 500 `role_missing`.
- `PATCH /employees/:id` (`employees.manage`) at least one of employeeNo, designation, employmentType, departmentId (nullable), joiningDate, status. userId immutable. 404, 409 `employeeNo already exists`.
- `GET /employees` (`directory.view`) (**changed G-H1**) query `q` (employeeNo | designation | user email | profile name), `status`, `departmentId`, `employmentType`, `page`, `pageSize`(<=100, default 20) -> `{ employees:[{id,employeeNo,designation,status,email,name|null}], total, page, pageSize }`. NOTE the list row is now the BRIEF projection (no employmentType/departmentId/joiningDate); fetch detail for those.
- `GET /employees/:id` (`directory.view`) -> full employee + (**new**) `user:{id,email,name|null}` and `department:{id,name}|null`.
- `GET /users/lookup?q=&limit=` (**new G-H2**, `employees.manage`) q 2..100 chars, limit 1..25 default 10. -> `{ users:[{id,email,role,name|null}] }`, users of the caller's institution with NO existing hr_employees row; matches email or student/faculty profile name. Never returns credentials. `role` is the legacy User.role enum.
- `GET /lookups` (**new G-H3**, `employees.manage`) -> `{ departments:[{id,name,code}] }`.

Contracts (`GET` = `directory.view`, writes = `contracts.manage`)
- `POST /employees/:id/contracts` body `{contractType PERMANENT|FIXED_TERM|PROBATION|CONSULTANT, startDate, endDate?>=start, termsMetadata? object<=16KB, salaryAmount? int>=0, currency "INR"}` -> 201 ACTIVE.
- `POST /employees/:id/contracts/:contractId/supersede` same body; old -> SUPERSEDED, new ACTIVE. 404 `contract not found`, 409 `contract is not active`.
- `POST /employees/:id/contracts/:contractId/end` (no body) contract -> ENDED. 409 `contract is not active`.
- `GET /employees/:id/contracts` -> `{contracts}` oldest first. Statuses: ACTIVE, SUPERSEDED, ENDED.

Leave
- `PUT /leave-policies/:leaveType` (`leave.manage`) leaveType CASUAL|SICK|EARNED|UNPAID|OTHER (400 `invalid leaveType`), body `{annualQuotaDays int>=0, accrualRule ANNUAL_LUMP_SUM|MONTHLY_ACCRUAL, active?}`.
- `GET /leave-policies` (`directory.view`) -> `{leavePolicies}`.
- `GET /leave` (**new G-H4**, `leave.manage`) query `status REQUESTED|APPROVED|REJECTED|CANCELLED`, `leaveType`, `employeeId`, `page`, `pageSize`. -> `{ leaveApplications:[{...application, employee:{id,employeeNo,designation,status,email,name|null}}], total, page, pageSize }` newest first. This is the approval queue.
- `POST /employees/:id/leave` (`leave.manage`, on behalf) body `{leaveType,startDate,endDate,reason<=2000}` -> 201 REQUESTED.
- `POST /leave/:appId/approve` and `/reject` (`leave.manage`) body `{reviewNote?}`. 404 `leave application not found`, 409 `leave application is not pending`, approve 422 `{error:"insufficient leave balance", remaining, requested}`.
- `GET /employees/:id/leave` -> `{leaveApplications}`; `GET /employees/:id/leave-balance?year=` -> `{balances:[{leaveType,periodYear,entitlement,taken,remaining}]}` (one per ACTIVE policy). Both `directory.view`.
- Application statuses: REQUESTED -> APPROVED | REJECTED | CANCELLED (cancel is self only).

Shifts and attendance
- `POST /shifts` (`attendance.manage`) `{name, startMinute 0..1439, endMinute 0..1439, active?}` 409 `shift name already exists`; `PATCH /shifts/:id`; `GET /shifts` (`directory.view`).
- `POST /employees/:id/attendance` (`attendance.manage`) `{attendanceDate, status PRESENT|ABSENT|ON_LEAVE|HALF_DAY, source? MANUAL|DERIVED, shiftId?}` 201; 409 `attendance already recorded for this date`.
- `PATCH /employees/:id/attendance/:date` (`attendance.manage`, date YYYY-MM-DD) `{status, source?, shiftId? nullable, reason?, metadata?}`; 404 `attendance not found`. Writes an immutable history row.
- `GET /employees/:id/attendance` (`directory.view`) -> `{attendance}` newest first (unpaginated).
- `GET /attendance/roster?date=YYYY-MM-DD&page&pageSize` (**new G-H5**, `attendance.manage`) pageSize <=100 default 50. -> `{ date, roster:[{employee:{id,employeeNo,designation,status,email,name|null}, attendance: <row>|null}], total, page, pageSize }`; non-TERMINATED employees, ordered by employeeNo.

Reports (`hr.reports.view`)
- `GET /reports/leave-summary` -> `{year, rows:[{employeeId,employeeNo,leaveType,periodYear,entitlement,taken,remaining}]}`.
- `GET /reports/attendance-summary?from&to` (range <=366 days) -> `{from,to,rows:[{employeeId,employeeNo,present,absent,onLeave,halfDay,total}]}`.
- `.xlsx` variants of both (binary download, audited). The fetch must use auth header (blob), not a plain link.

Self (`hr.view_own`, EMPLOYEE only). All resolve the caller by token userId; no hr_employees row -> 404 `employee record not found`.
- `GET /me/employee` (now with `user`, `department`), `GET /me/contracts`, `GET /me/leave`, `GET /me/leave-balance?year=`, `GET /me/attendance`, `POST /me/leave` (201), `POST /me/leave/:appId/cancel` (409 `leave application is not pending`; not-own = 404).

## NEW / CHANGED ENDPOINTS summary (backend fixes, this step)
| ID | Endpoint | Key | Why |
|---|---|---|---|
| G1 | GET /api/faculty | faculty.directory.view | no way to list faculty; every other route needs a :facultyId |
| G2 | GET /api/faculty/lookups | faculty.directory.view | HOD has no academics.* / departments key for term + dept pickers |
| G3 | name projections on faculty profile/workload/history | existing | rows carried only ids (term, subject, section, department) |
| G-H1 | GET /employees (filters, paging, brief) + GET /employees/:id & /me/employee (user, department) | hr.directory.view | list unusable without search/paging; rows showed only ids |
| G-H2 | GET /api/hr/users/lookup | hr.employees.manage | HR_MANAGER cannot pick a user (admin.users.view is ADMIN only) |
| G-H3 | GET /api/hr/lookups | hr.employees.manage | department picker (admin.departments.manage is ADMIN only) |
| G-H4 | GET /api/hr/leave | hr.leave.manage | no queue to find pending application ids for approve/reject |
| G-H5 | GET /api/hr/attendance/roster | hr.attendance.manage | per-employee only; no day view to record attendance |

Breaking-shape note: `GET /api/hr/employees` rows are now the brief projection and the response gains `total/page/pageSize`. The only in-repo consumer is the API tests; no web code existed. Existing fast test `hr-routes.integration.test.ts` fixture for `/me/employee` was updated to include `user`/`department`.

## ROLE-CAPABILITY MATRIX (after backend fixes)
| Screen | Endpoints | Keys needed | ADMIN | HOD | FACULTY | HR_MANAGER | EMPLOYEE |
|---|---|---|---|---|---|---|---|
| Faculty directory list | GET /faculty, /lookups | faculty.directory.view | Y | Y | - | - | - |
| Faculty profile (quals, workload, history) | GET /:id/profile | directory.view | Y | Y | - | - | - |
| Manage qualifications | POST/PATCH/DELETE quals (+ profile to render) | qualifications.manage + directory.view | Y | Y | - | - | - |
| Workload view/edit/recompute/policy | GET workload, PATCH, recompute, policy, /lookups | workload.manage + directory.view | Y | Y | - | - | - |
| Teaching history + reconcile | GET history, POST reconcile | teaching_history.manage + directory.view | Y | Y | - | - | - |
| My faculty profile | GET /me/profile | faculty.view_own | - | - | Y | - | - |
| Employee directory/detail | GET /employees, /:id, /lookups | hr.directory.view (+ employees.manage for lookups) | Y | - | - | Y | - |
| Create/edit employee | GET /users/lookup, /lookups, POST/PATCH /employees | employees.manage (+ directory.view to render) | Y | - | - | Y | - |
| Contracts | GET/POST contracts, supersede, end | contracts.manage + directory.view | Y | - | - | Y | - |
| Leave policies | GET/PUT | leave.manage + directory.view | Y | - | - | Y | - |
| Leave approval queue | GET /leave, approve, reject, GET balance | leave.manage + directory.view | Y | - | - | Y | - |
| Shifts | GET/POST/PATCH | attendance.manage + directory.view | Y | - | - | Y | - |
| Attendance roster/record/correct | GET /attendance/roster, POST/PATCH attendance, GET shifts | attendance.manage + directory.view | Y | - | - | Y | - |
| Reports + XLSX | reports/* | hr.reports.view | Y | - | - | Y | - |
| My employment / contracts / leave / attendance / apply / cancel | /me/* | hr.view_own | - | - | - | - | Y |

Every cell with Y holds all listed keys (verified against ROLE_PERMISSIONS: ADMIN and HR_MANAGER hold all six HR keys; ADMIN and HOD hold all four faculty staff keys). Landing suggestions: `faculty.directory.view` -> `/faculty`, `hr.directory.view` -> `/hr`, `hr.view_own` -> `/hr/me`, `faculty.view_own` -> `/faculty/me` (after existing legacy-role checks, so ADMIN/HOD/STUDENT homes are unchanged; FACULTY has no legacy landing today).

## Backend gaps considered and their resolution
- Faculty list missing (G1), term/department pickers unreachable by HOD (G2), id-only rows (G3): fixed.
- HR user picker, department picker, leave queue, attendance roster, employee list paging/search and names: fixed (G-H1..H5).
- Self-service: HR has `/me/*` for EMPLOYEE (ok). Faculty has `/me/profile` (ok). No gap.
- Workload recompute/patch responses do not carry the term name: not an issue; the UI already knows the selected term from the picker.
- Module activation for the demo tenant: data/seed concern, not code (see below).

## Known Limitations
- Demo seed lacks HR_MANAGER/EMPLOYEE users and does not activate `faculty_management` / `hr_management`; a live demo needs a module activation (admin modules screen or direct row) and HR users created by a script. Not changed here (seed is under packages/db; out of scope).
- HR employees have no name of their own; `name` is only present for users with a Student/Faculty profile. The UI must show email as the primary identifier and `name` when present.
- `GET /employees/:id/attendance`, `/leave`, `/contracts` are unpaginated (per-employee, bounded). Reports are unpaginated.
- No endpoint to delete employees, shifts, or leave policies; no endpoint to end an assignment from Faculty Management (use classes).
- Faculty `PATCH` qualification cannot clear optional fields (zod has no null); `documentRef` is a reference string only.
- HOD is not department-scoped on the faculty routes (HOD sees all faculty in the tenant); this is the existing backend behaviour.
- Contract `end` takes no body (the handler parses none); it sets the contract to ENDED, so it cannot set an end date.
