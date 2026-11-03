# API Contract — Frontend Classes & Attendance Modules

Ground-truth source files read for this contract (actual paths):

- `c:/campusgate/apps/api/src/routes/classes.ts` — Class & Course Management routes (registered at prefix `/api/classes`).
- `c:/campusgate/apps/api/src/routes/attendance.ts` — Attendance routes (registered at prefix `/api/attendance`).
- `c:/campusgate/apps/api/src/routes/hod.ts` — read; this is the **campus_movement** HOD file (gate passes / emergency / requests), NOT a classes/timetable route. Classes & Course endpoints live in `classes.ts`, not here.
- `c:/campusgate/packages/shared/src/permissions.ts` — permission catalogue (single source of truth).
- `c:/campusgate/packages/shared/src/modules.ts` — module registry.
- `c:/campusgate/packages/shared/src/validation.ts` — zod request-body/query schemas (exact field definitions).
- `c:/campusgate/apps/api/src/server.ts` — confirms route prefixes: `classesRoutes` → `/api/classes`, `attendanceRoutes` → `/api/attendance`.

Frontend pattern source files read (actual paths):

- `c:/campusgate/apps/web/src/features/fees/keys.ts`, `hooks.ts`
- `c:/campusgate/apps/web/src/features/academics/keys.ts`, `hooks.ts`, `formSchemas.ts`
- `c:/campusgate/apps/web/src/lib/api.ts`, `lib/authz.ts`
- `c:/campusgate/apps/web/src/stores/auth.ts`
- `c:/campusgate/apps/web/src/components/auth/Can.tsx`, `RouteGuard.tsx`
- `c:/campusgate/apps/web/src/components/shell/AppShell.tsx`
- `c:/campusgate/apps/web/src/features/modules/useModuleActive.ts`
- `c:/campusgate/apps/web/src/app/(app)/academics/sessions/page.tsx` (representative screen)

---

## 1. CLASSES endpoints (prefix `/api/classes`)

Foundational institution-layer data. **Permission-gated ONLY — never module-gated.** There is NO `requireModuleActive(...)` on any classes route (the `class_course` module key exists in the registry but is not enforced here — see §3). This mirrors the students.ts/academics precedent. Every handler runs inside `withTenant(institutionId, tx => ...)`; HOD callers are narrowed to their `departmentScope` via relation filters, and an out-of-scope row is returned as 404.

### Courses

| Method | Path | Permission | Request body | Response |
|---|---|---|---|---|
| POST | `/api/classes/courses` | `classes.courses.manage` | `{ programId, name, code, description?, academicTermId? }` | `201` Course object (unwrapped). `400` validation. `404 {error:"program not found"}` / `"term not found"`. `409 {error:"course code already exists"}`. |
| PATCH | `/api/classes/courses/:id` | `classes.courses.manage` | `{ name?, description?, academicTermId?, status? }` (`status` ∈ `ACTIVE`/`INACTIVE`) | Course object (unwrapped). `400`. `404 {error:"course not found"}` / `"term not found"}`. |
| GET | `/api/classes/courses` | `classes.view` | — | `{ courses: Course[] }` (ordered by `createdAt asc, id asc`). |
| GET | `/api/classes/courses/:id` | `classes.view` | — | Course object **with** `{ subjects: Subject[] }` included (unwrapped). `404 {error:"course not found"}`. |

### Subjects

| Method | Path | Permission | Request body | Response |
|---|---|---|---|---|
| POST | `/api/classes/subjects` | `classes.courses.manage` | `{ courseId, name, code, credits?, contactHoursPerWeek? }` | `201` Subject object (unwrapped). `404 {error:"course not found"}`. `409 {error:"subject code already exists"}`. |
| PATCH | `/api/classes/subjects/:id` | `classes.courses.manage` | `{ name?, credits?, contactHoursPerWeek?, status? }` | Subject object (unwrapped). `404 {error:"subject not found"}`. |

### Class Sections

| Method | Path | Permission | Request body | Response |
|---|---|---|---|---|
| POST | `/api/classes/sections` | `classes.sections.manage` | `{ programId, academicSessionId, academicTermId, label?, capacity?, status? }` (`status` ∈ `PLANNED`/`ACTIVE`/`CLOSED`/`CANCELLED`) | `201` ClassSection object (unwrapped). `404 {error:"program not found"}` / `"invalid session or term"`. `409 {error:"section already exists"}`. |
| PATCH | `/api/classes/sections/:id` | `classes.sections.manage` | `{ label?, capacity?, status? }` (strict — no unknown fields) | ClassSection object (unwrapped). `404 {error:"section not found"}`. |
| GET | `/api/classes/sections` | `classes.view` | — | `{ sections: ClassSection[] }` (ordered by `createdAt asc, id asc`). |
| GET | `/api/classes/sections/:id` | `classes.view` | — | ClassSection object **with** `{ enrollments: ClassEnrollment[] }` included (unwrapped, ordered by `enrolledAt asc`). `404 {error:"section not found"}`. **NOTE: this does NOT include faculty assignments** — see §4 gap. |

ClassSection fields (inferred from create/select + handler): `id`, `institutionId`, `programId`, `academicSessionId`, `academicTermId`, `label` (nullable), `capacity` (nullable), `status`, `createdAt`, `updatedAt`.

### Enrollment

| Method | Path | Permission | Request body | Response |
|---|---|---|---|---|
| POST | `/api/classes/enroll` | `classes.enroll` | `{ classSectionId, studentId }` | `201` ClassEnrollment object (unwrapped). `404 {error:"section not found"}` / `"student not found"`. `409 {error:"student already enrolled"}` / `"section is at capacity"}`. |
| POST | `/api/classes/unenroll` | `classes.enroll` | `{ classSectionId, studentId }` | ClassEnrollment object (unwrapped, status set to `DROPPED`). `404 {error:"enrollment not found"}`. |

### Faculty (profiles + assignments)

| Method | Path | Permission | Request body | Response |
|---|---|---|---|---|
| POST | `/api/classes/faculty` | `classes.faculty.assign` | `{ userId, name, departmentId? }` | `201` FacultyProfile object (unwrapped). `404 {error:"user not found"}` / `"department not found"}`. `409 {error:"faculty profile already exists for user"}`. |
| POST | `/api/classes/faculty/assign` | `classes.faculty.assign` | `{ facultyId, subjectId, academicTermId, classSectionId?, role?, replacesAssignmentId? }` (`role` ∈ `PRIMARY`/`SUBSTITUTE`/`ASSISTANT`, defaults to `PRIMARY`) | Fresh assign: `201` FacultyAssignment object. Reassign (when `replacesAssignmentId` set): `201` new FacultyAssignment object. `404 {error:"<kind> not found"}` where kind ∈ `faculty`/`subject`/`term`/`section`/`assignment`. |

FacultyAssignment fields: `id`, `institutionId`, `facultyId`, `subjectId`, `classSectionId` (nullable), `academicTermId`, `role`, `status` (`ACTIVE`/`ENDED`), plus ended/created timestamps. **There is NO GET to list assignments and NO explicit "end assignment" endpoint** — see §4 gaps.

### Timetable + Scheduled Classes

| Method | Path | Permission | Request body | Response |
|---|---|---|---|---|
| POST | `/api/classes/timetables` | `classes.timetable.manage` | `{ academicTermId, name }` | `201` Timetable object (unwrapped). `404 {error:"term not found"}`. |
| GET | `/api/classes/timetables` | `classes.view` | — | `{ timetables: Timetable[] }` (ordered by `createdAt asc, id asc`). |
| GET | `/api/classes/timetables/:id` | `classes.view` | — | Timetable object **with** `{ scheduledClasses: ScheduledClass[] }` included (ordered by `dayOfWeek asc, startTime asc`). `404 {error:"timetable not found"}`. |
| POST | `/api/classes/scheduled-classes` | `classes.timetable.manage` | `{ timetableId, classSectionId, subjectId, facultyId, academicTermId, room?, dayOfWeek?, date?, startTime, endTime, period? }` (exactly one of `dayOfWeek`/`date`; `startTime`<`endTime`; both are minute ints 0..1440) | `201 { scheduledClass, warnings }`. `404 {error:"<kind> not found"}`. `409 {error:"Timetable conflict", conflicts: ConflictReport}`. |
| PATCH | `/api/classes/scheduled-classes/:id` | `classes.timetable.manage` | partial of the create body (all fields optional) | `{ scheduledClass, warnings }`. `404 {error:"scheduled class not found"}`. `409` conflict. |
| POST | `/api/classes/scheduled-classes/:id/cancel` | `classes.timetable.manage` | — | ScheduledClass object (status `CANCELLED`). `404`. |
| POST | `/api/classes/timetables/:id/check` | `classes.timetable.manage` | — | `{ conflicts: ConflictReport }` (dry-run, no write). `404`. |
| POST | `/api/classes/timetables/:id/publish` | `classes.timetable.manage` | `{ acceptWarnings? }` (strict) | `{ timetable, warnings }`. `409 {error:"cannot publish a <status> timetable"}` (only `DRAFT` may publish) or `{error:"Timetable conflict", conflicts}`. `404`. |

Timetable status values referenced in handler: `DRAFT` and `PUBLISHED` (no shared enum; from the DB schema). ScheduledClass status: `SCHEDULED` / `CANCELLED`. `dayOfWeek` ∈ `SUN`/`MON`/`TUE`/`WED`/`THU`/`FRI`/`SAT`. `startTime`/`endTime` are minute-of-day integers (0..1440).

---

## 2. ATTENDANCE endpoints (prefix `/api/attendance`)

**Gated module.** Every operational route carries BOTH `requirePermission("attendance.<x>")` AND `requireModuleActive("attendance")` (the `campus_movement` precedent). `MODULE_KEY = "attendance"`. Faculty scope is enforced server-side via `resolveMarkingFaculty` + `assertFacultyAssigned` (record-level); HOD callers are narrowed to their `departmentScope` via the `attendanceDepartmentScopeFilter` relation helper; out-of-scope rows are 404.

### Sessions

| Method | Path | Permission | Request body / query | Response |
|---|---|---|---|---|
| POST | `/api/attendance/sessions` | `attendance.mark` (+module) | `{ scheduledClassId, date, submissionDeadline? }` (`date` coerced to Date, truncated to UTC midnight) | `201 { session, recordCount }` (creates OPEN session + one ABSENT AttendanceRecord per ENROLLED student). `403 {error:"not a faculty member"}` / `"not assigned to this class"}`. `404 {error:"scheduled class not found"}`. `409 {error:"scheduled class cancelled"}` / `"date does not match scheduled class"}` / `"session already exists"}`. |
| GET | `/api/attendance/sessions` | `attendance.view` (+module) | — | `{ sessions: AttendanceSession[] }` (ordered by `date desc, id asc`). **No date or faculty filter** — returns all in-scope sessions. See §4 gap. |
| GET | `/api/attendance/sessions/:id` | `attendance.view` (+module) | — | AttendanceSession object **with** `{ records: AttendanceRecord[] }` included (ordered by `id asc`). `404 {error:"session not found"}`. |
| PATCH | `/api/attendance/sessions/:id/records` | `attendance.mark` (+module) | `{ records: [{ studentId, status }, ...] }` (`status` ∈ `PRESENT`/`ABSENT`/`LATE`/`EXCUSED`; 1..1000 records) | `{ changed: number }`. `403 {error:"not a faculty member"}` / `"not assigned to this session"}`. `404 {error:"session not found"}`. `409 {error:"session finalized"}` / `"session submitted"}` / `"student not in this session"}`. |
| POST | `/api/attendance/sessions/:id/submit` | `attendance.mark` (+module) | — | AttendanceSession object (status `SUBMITTED`, `submittedAt` set). `403` / `404` / `409 {error:"session not open"}`. |
| POST | `/api/attendance/sessions/:id/finalize` | `attendance.mark` (+module) | — | AttendanceSession object (status `FINALIZED`, `finalizedAt` set). Best-effort low-attendance alerts fire post-commit. `403` / `404` / `409 {error:"session not submitted"}`. |

AttendanceSession status enum: `OPEN` / `SUBMITTED` / `FINALIZED` (from `attendanceSessionStatusEnum`). **There is NO `CLOSED` or `CANCELLED` session status, and no close/cancel endpoint** — see §4 discrepancy.

### Corrections

| Method | Path | Permission | Request body / query | Response |
|---|---|---|---|---|
| POST | `/api/attendance/corrections` | `attendance.mark` (+module) | `{ attendanceRecordId, requestedStatus, reason }` (`requestedStatus` ∈ `PRESENT`/`ABSENT`/`LATE`/`EXCUSED`; `reason` 1..2000 chars) | `201` AttendanceCorrection object (reviewStatus `PENDING`). `403` / `404 {error:"record not found"}` / `400 {error:"no change requested"}` / `409 {error:"session not finalized"}` / `"a correction is already pending for this record"}`. |
| GET | `/api/attendance/corrections` | `attendance.correct` (+module) | query `status?` ∈ `PENDING`/`APPROVED`/`REJECTED` (else no filter) | `{ corrections: AttendanceCorrection[] }` (ordered by `createdAt desc, id asc`). |
| POST | `/api/attendance/corrections/:id/approve` | `attendance.correct` (+module) | `{ reviewNote? }` (max 2000) | AttendanceCorrection object (reviewStatus `APPROVED`, `reviewedByUserId`/`reviewedAt`/`reviewNote` set; the underlying record status is updated to `requestedStatus`). `404 {error:"correction not found"}` / `"record not found"}`. `409 {error:"correction not pending"}` / `"session not finalized"}` / `"record changed since request"}`. |
| POST | `/api/attendance/corrections/:id/reject` | `attendance.correct` (+module) | `{ reviewNote? }` (max 2000) | AttendanceCorrection object (reviewStatus `REJECTED`). `404`. `409 {error:"correction not pending"}`. |

### Student self-service + reports + export

| Method | Path | Permission | Request body / query | Response |
|---|---|---|---|---|
| GET | `/api/attendance/me` | `attendance.view_own` (+module) | query `academicTermId` (required) | `{ records: AttendanceRecord[], attendanceRate }` (records are this student's FINALIZED records for the term; `attendanceRate` is the policy-weighted rate). `400` validation. `404 {error:"student not found"}`. |
| GET | `/api/attendance/reports/section/:sectionId` | `attendance.view` (+module) | query `academicTermId` (required) | `{ perStudent: [{ studentId, rate }], lowAttendance: [{ studentId, rate }], thresholdPercent }` (FINALIZED records only). `400`. `404 {error:"section not found"}`. **NOTE: scoped by section + term, NOT section + subject; returns rates only, NOT totals/present/absent counts** — see §4 gap. |
| GET | `/api/attendance/export` | `attendance.export` (+module) | query `sectionId`, `academicTermId`, `format` ∈ `csv`/`json` (defaults `csv`) | `format=csv` → `text/csv` body. `format=json` → `{ rows: [...] }`. `400`. `404 {error:"section not found"}`. (Writes an `attendance.exported` audit event.) |

---

## 3. Exact permission keys & module keys (verbatim)

### `classes.*` permission keys (from `packages/shared/src/permissions.ts`, module field = `"classes"`)

```
classes.courses.manage       — "Create/update courses and subjects"
classes.sections.manage      — "Create/update class sections"
classes.enroll               — "Enroll / drop students in a section"
classes.faculty.assign       — "Create faculty profiles and assign/substitute faculty"
classes.timetable.manage     — "Create/edit/publish timetables and scheduled classes"
classes.view                 — "View courses/subjects/sections/timetables (staff read)"
classes.view_own             — "Faculty/Student view own schedule only"
```

### `attendance.*` permission keys (from `packages/shared/src/permissions.ts`, module field = `"attendance"`)

```
attendance.view       — "Staff read of sessions/records/reports (HOD dept-scoped, ADMIN whole-tenant)"
attendance.mark       — "Faculty opens a session, marks records, submits, finalizes — assigned classes only (record-level scope)"
attendance.correct    — "Review (approve/reject) a correction request"
attendance.export     — "Export attendance (authorized and audited)"
attendance.view_own   — "Student reads only their own attendance"
```

### Module keys (from `packages/shared/src/modules.ts`, verbatim)

```
class_course   name: "Class & Course"   description: "Classes/courses (future)"
attendance     name: "Attendance"      description: "Attendance (future)"
```

Dependency graph (verbatim from `MODULE_DEPENDENCIES`): both `class_course: []` and `attendance: []` have **no gated-module activation edges** — attendance is "foundational-not-gated" in the dependency sense (only its own InstitutionModule row must be ENTITLED→ACTIVE; real prerequisites validated at operation time).

**Important enforcement asymmetry:**
- `classes.ts` routes are **foundational — permission-gated ONLY**, never `requireModuleActive`. So the `class_course` module key is declared but NOT enforced by the classes API.
- `attendance.ts` routes ARE **module-gated**: every operational route calls `requireModuleActive("attendance")` in addition to `requirePermission(...)`.

---

## 4. Gaps & discrepancies vs. the planned feature (flagged for the build step)

The feature brief describes behaviour the current API does not yet provide. Record these so the implementation step decides whether to (a) add backend endpoints, (b) filter client-side, or (c) adjust the UI to match what exists.

1. **Faculty Assignments list — NO GET endpoint exists.** There is no `/api/classes/faculty/assignments` (or similar) read. The only faculty endpoints are `POST /faculty` (create profile) and `POST /faculty/assign` (assign/reassign). A searchable active-assignments table needs a new backend list endpoint.
2. **End assignment — NO explicit endpoint.** Only reassign/substitute via `replacesAssignmentId` (which soft-ends the prior ACTIVE row → `ENDED` + inserts a new ACTIVE). A standalone "end assignment" action is not implemented.
3. **Section detail faculty assignments — NOT included.** `GET /sections/:id` returns `enrollments` only, not faculty assignments. The feature wants a faculty-assignments list per section; needs a backend addition or a dedicated assignments-by-section query.
4. **Today's sessions for logged-in faculty — no server filter.** `GET /sessions` returns all in-scope sessions (HOD dept-scoped / ADMIN whole-tenant) with no `date` or `markedByFacultyId` filter. "Today's sessions for the logged-in faculty" requires either client-side filtering on `date` (today) + `markedByFacultyId`, or a new endpoint.
5. **Session statuses differ from the brief.** Actual enum is `OPEN`/`SUBMITTED`/`FINALIZED`. The brief's "OPEN/CLOSED/CANCELLED" does not match. There is no `CLOSED` or `CANCELLED` session status and no close/cancel-session endpoint — only `submit` (OPEN→SUBMITTED) and `finalize` (SUBMITTED→FINALIZED).
6. **Student attendance report differs from the brief.** `GET /reports/section/:sectionId` is scoped by **section + academicTermId** (not section + subject) and returns `perStudent` rates + `lowAttendance` + `thresholdPercent` — NOT total sessions / present / absent counts. The brief's "section + subject" with "per-student attendance percentages, total sessions, present/absent counts" is not matched by the current endpoint.

---

## 5. Frontend pattern to follow (from existing F0 features)

Mirror the `fees` and `academics` features exactly. All paths under `c:/campusgate/apps/web/src/`.

### Transport — `lib/api.ts`
- `api` exports `get/post/put/delete` only (frozen primitive); **no PATCH**. It attaches the bearer token from `useAuthStore.getState().token`, parses JSON, throws `ApiError(status, data)`, and **auto-logs-out on 401**.
- For PATCH (classes sections/faculty updates use PATCH), copy the local `apiPatch<T>(endpoint, body)` helper used in `features/fees/hooks.ts` and `features/academics/hooks.ts` (same token + `ApiError` + 401 logout semantics, `API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"`).

### Query key factories — one `keys.ts` per feature (`features/fees/keys.ts`, `features/academics/keys.ts`)
- `const <domain>Keys = { ... } as const` returning `["<domain>", "...", ...] as const` tuples.
- **Include filter params in the key** so different filters get distinct cache entries (academics includes `{ status }` / `{ departmentId, status }` discriminators; fees includes the whole reconciliation query object).
- Detail keys take an `id`; sub-list keys nest under the detail (`feesKeys.components(id)`).

### Typed React Query hooks — one `hooks.ts` per feature
- `useQuery` / `useMutation` / `useQueryClient` from `@tanstack/react-query`; `toast` from `sonner`.
- Define response/interface types at the top of the file (mirror server shapes).
- **`enabled` gates on permissions** via the `can(permission, currentPermissions())` helper where `currentPermissions()` reads `useAuthStore.getState().permissions` (fees pattern). academics uses the same with `||` for multiple keys.
- Mutations invalidate the relevant key prefix on success (`qc.invalidateQueries({ queryKey: ["<domain>", "..."] })`) and `toast.error` on error via a shared `toastError(error)` helper.
- Body types exported for the screens (e.g. `CreateSessionBody`).

### Form schemas — one `formSchemas.ts` per feature (zod + react-hook-form)
- `import { z } from "zod"`. Use `z.enum([...])` for status/role enums, `.refine(...)` for cross-field rules (e.g. endDate > startDate), `.partial()` for edit schemas.
- Export `type XInput = z.infer<typeof xSchema>`.
- Screens use `useForm<XInput>({ resolver: zodResolver(xSchema), defaultValues: {...} })` with `<Form>`/`<FormField>`/`<FormItem>`/`<FormControl>`/`<FormLabel>`/`<FormMessage>` from `components/ui/form`, plus `<Input>`, `<Select>`/`<SelectTrigger>`/`<SelectContent>`/`<SelectItem>`/`<SelectValue>`.
- Mutate with `mutate(body, { onSuccess: () => { toast.success(...); form.reset(); onOpenChange(false); }, onError: (err) => { if (err instanceof ApiError && err.status === 409) form.setError(...) } })`.

### Authz — `lib/authz.ts` + `stores/auth.ts`
- `can(permission, perms)`, `canAny(permissions, perms)`, `hasRole(role, roles)` are pure helpers taking a perms/roles array.
- `useCan(permission)`, `useCanAny(permissions)`, `useHasRole(role)` are store-subscribing hooks.
- `useAuthStore` (zustand + persist) holds `token`, `user`, `roles: string[]`, `permissions: string[]`, `hydrated`. Permissions/roles are decoded from the JWT at login. Authorization NEVER uses `user.role`; it uses `permissions`.

### Route guard — `components/auth/RouteGuard.tsx` on every page
- `<RouteGuard>` (optionally `requirePermission={...}`) wraps page content: waits for `hydrated` (flash-avoidance via `<FullPageSkeleton/>`), redirects to `/login` when unauthenticated, renders `<ForbiddenScreen/>` when `requirePermission` is set and missing.
- The academics sessions page uses `<RouteGuard>` with NO `requirePermission` (auth-only) and gates action buttons individually with `<Can>`.

### Action gating — `components/auth/Can.tsx` on every action
- `<Can permission="...">` or `<Can anyOf={[...]}>` with `fallback` (default `null`). UX gate ONLY; the backend 403 is authoritative.
- Example: `<Can permission="academics.sessions.manage"><Button>Create</Button></Can>`.

### UI primitives — shadcn Table/Dialog/Form/Skeleton + ui-ext
- `components/ui/table` (`Table`/`TableHeader`/`TableRow`/`TableHead`/`TableBody`/`TableCell`), `components/ui/dialog` (`Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogFooter`), `components/ui/form`, `components/ui/button`, `components/ui/input`, `components/ui/select`, `components/ui/badge`, `components/ui/skeleton`, `components/ui/tabs`.
- `components/ui-ext/EmptyState` (`icon`, `label`, `description`) and `components/ui-ext/InlineError` (`message`) for the empty + error states.
- Standard screen rhythm (see `academics/sessions/page.tsx`): header row (title + `<Can>`-gated create button) → optional filter tabs → `isLoading ? Skeleton… : isError ? <InlineError/> : !data || empty ? <EmptyState/> : <Table>`. Per-row action buttons gated by `<Can>`.

### AppShell NAV additions — `components/shell/AppShell.tsx`
- `NAV: NavItem[]` where each item is `{ href, label, icon: LucideIcon, anyOf: PermissionKey[], module?: ModuleKey }`.
- `useNavItemVisible(item, perms)` hides the item when `!canAny(item.anyOf, perms)` OR when `item.module` is set and `useModuleActive(item.module)` returns `"inactive"`.
- **Foundational / permission-only features (classes, like academics & students) MUST omit `module`** — because the API does not module-gate them and `useModuleActive` only probes `fees` today (returns `"unknown"` otherwise, which never hides). Omitting `module` means the `if (item.module && ...)` branch is skipped, so the item shows purely on `anyOf`.
  - Classes NAV item: `anyOf: ["classes.sections.manage", "classes.faculty.assign", "classes.timetable.manage", "classes.view"]` (the staff-read + manage keys), **no `module`**. (Follow the academics precedent which intentionally excludes the broad `*.view`-only path where it would 403 HODs — verify each sub-route's permission before including a key here.)
- **Module-gated features (attendance) MUST set `module: "attendance"`** — but `features/modules/useModuleActive.ts` currently only has a probe for `fees`. An attendance probe must be added (e.g. `if (moduleKey === "attendance") { if (can("attendance.view", permissions)) probePath = "/api/attendance/sessions"; else if (can("attendance.view_own", permissions)) probePath = "/api/attendance/me?academicTermId=<current-or-placeholder>"; }`) before the attendance NAV item will correctly hide on an inactive module. Only the explicit `"inactive"` ("Module not active") 403 suppresses nav; a permission `forbidden` never hides a capable user.
- Attendance NAV items: one staff entry `anyOf: ["attendance.view", "attendance.mark", "attendance.correct"]` with `module: "attendance"`, and (if student self-view is in scope) a `view_own` entry `anyOf: ["attendance.view_own"]` with `module: "attendance"`.

### Shared types import
- Import `PermissionKey` and `ModuleKey` types from `@campusgate/shared` (already done in AppShell, Can, RouteGuard, authz). The `class_course` and `attendance` `ModuleKey` literals are available from the shared `MODULES` registry.
