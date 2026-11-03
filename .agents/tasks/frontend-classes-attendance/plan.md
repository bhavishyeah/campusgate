# Implementation Plan — Classes & Attendance Frontend Modules

**Source design:** `c:/campusgate/.agents/tasks/frontend-classes-attendance/design.md` (Revision 2, all findings addressed)
**API contract:** `c:/campusgate/.agents/tasks/frontend-classes-attendance/api-contract.md`
**Reference pattern:** `features/academics/` + `app/(app)/academics/sessions/page.tsx`

---

## Ordered Build Sequence

- [ ] 1. Add `<Textarea>` shadcn component (prerequisite for Screen 7)
      The `components/ui/textarea.tsx` component does not exist (confirmed via directory listing). Screen 7's `ReviewCorrectionDialog` uses `<Textarea>` for `reviewNote`. Create it following the exact same shadcn-style pattern as the other components in `components/ui/`.
      Files:
      - `apps/web/src/components/ui/textarea.tsx` — create
      Verify: `cd apps/web && npm run lint` — no TypeScript errors.

- [ ] 2. Create `features/classes/` module foundation (types, keys, formSchemas)
      Create the four foundation files for the classes domain in exact parallel to `features/academics/types.ts`, `keys.ts`, and `formSchemas.ts`. Copy the exact TypeScript types, key factory, and zod schemas verbatim from design §2, §4, and §6.
      Files:
      - `apps/web/src/features/classes/types.ts` — create (design §2)
      - `apps/web/src/features/classes/keys.ts` — create (design §4)
      - `apps/web/src/features/classes/formSchemas.ts` — create (design §6)
      Key details:
      - `classesKeys.sections()` has NO filter param (status filtering is client-side only; a single cache entry covers all tab states — different from academicsKeys.sessions which includes server-side filter)
      - `classesKeys.section(id)`, `classesKeys.timetables()`, `classesKeys.timetable(id)`, `classesKeys.courses()`, `classesKeys.course(id)` as defined in design §4
      - `createSectionSchema`, `editSectionSchema`, `assignFacultySchema`, `createTimetableSchema` and their inferred types
      Verify: `cd apps/web && npm run lint` — no TypeScript errors on the new files.

- [ ] 3. Create `features/attendance/` module foundation (types, keys, formSchemas)
      Create the foundation files for the attendance domain in parallel to step 2. Copy verbatim from design §3, §5, and §7.
      Files:
      - `apps/web/src/features/attendance/types.ts` — create (design §3)
      - `apps/web/src/features/attendance/keys.ts` — create (design §5)
      - `apps/web/src/features/attendance/formSchemas.ts` — create (design §7)
      Key details:
      - `attendanceKeys.sessions()`, `attendanceKeys.session(id)`, `attendanceKeys.corrections(status?)`, `attendanceKeys.report(sectionId, termId)`
      - `createSessionSchema`, `submitCorrectionSchema`, `reviewCorrectionSchema` and their inferred types
      Verify: `cd apps/web && npm run lint` — no TypeScript errors on the new files.

- [ ] 4. Create `features/classes/hooks.ts`
      Create the typed React Query hooks for the classes domain. Follow the exact pattern of `features/academics/hooks.ts`: local `apiPatch<T>` helper (same token/ApiError/401-logout semantics), `currentPermissions()` helper, `toastError()` helper.
      Files:
      - `apps/web/src/features/classes/hooks.ts` — create (design §8)
      Hook inventory (all from design §8):
      - `useSections()` — `useQuery`, `enabled`: `can("classes.view",…) || can("classes.sections.manage",…)`
      - `useSection(id)` — `useQuery`, same `enabled` gate
      - `useCreateSection()` — `useMutation`, invalidates `classesKeys.sections()`
      - `useUpdateSection(id)` — `useMutation` via `apiPatch`, invalidates sections list + detail
      - `useAssignFaculty()` — `useMutation`, always invalidates `classesKeys.timetables()`; conditionally invalidates `classesKeys.section(vars.classSectionId)` when set (design §8 onSuccess note)
      - `useTimetables()` — `useQuery`, `enabled`: `can("classes.view",…) || can("classes.timetable.manage",…)`
      - `useTimetable(id)` — `useQuery`, same enabled gate
      - `useCreateTimetable()` — `useMutation`, invalidates `classesKeys.timetables()`
      - `usePublishTimetable(id)` — `useMutation`, invalidates timetable detail + list; NOTE: no `onError` in hook — Screen 4 handles 409 inline
      - Export all body interfaces: `CreateSectionBody`, `PatchSectionBody`, `AssignFacultyBody`, `CreateTimetableBody`, `PublishTimetableBody`, `PublishResult`
      Verify: `cd apps/web && npm run lint` — no TypeScript errors.

- [ ] 5. Create `features/attendance/hooks.ts`
      Create the typed React Query hooks for the attendance domain. Same structural pattern as step 4. The `apiPatch<T>` helper is local (duplicate from academics pattern; `lib/api.ts` has no PATCH).
      Files:
      - `apps/web/src/features/attendance/hooks.ts` — create (design §9)
      Hook inventory (all from design §9):
      - `useAttendanceSessions()` — `useQuery`, `enabled`: `can("attendance.view",…) || can("attendance.mark",…)`
      - `useAttendanceSession(id)` — `useQuery`, same enabled gate
      - `useCreateAttendanceSession()` — `useMutation`, invalidates `attendanceKeys.sessions()`
      - `useMarkAttendance(sessionId)` — `useMutation` via `apiPatch` to `PATCH /api/attendance/sessions/${sessionId}/records`
      - `useSubmitSession(sessionId)` — `useMutation`, `api.post(url)` with no body arg (API takes no body); invalidates session detail + sessions list
      - `useFinalizeSession(sessionId)` — `useMutation`, same as submit; no body arg
      - `useCorrections(status?)` — `useQuery`, `enabled`: `can("attendance.correct",…)` ONLY (faculty with mark-only get 403)
      - `useSubmitCorrection()` — `useMutation`, invalidates `["attendance","corrections"]` prefix
      - `useApproveCorrection(correctionId)` — `useMutation`, invalidates corrections
      - `useRejectCorrection(correctionId)` — `useMutation`, invalidates corrections
      - `useSectionReport(sectionId, academicTermId)` — `useQuery`, `enabled`: `Boolean(sectionId) && Boolean(academicTermId) && can("attendance.view",…)`
      - Export body interfaces: `CreateAttendanceSessionBody`, `MarkRecordsBody`, `SubmitCorrectionBody`, `ReviewCorrectionBody`
      - **Important:** define `apiPatch` BEFORE `useMarkAttendance` (TypeScript hoisting constraint); remove the duplicate `mutationFn` line from design §9's `useMarkAttendance` (the design shows two `mutationFn` lines — keep only the `apiPatch` one)
      Verify: `cd apps/web && npm run lint` — no TypeScript errors.

- [ ] 6. Add attendance probe to `useModuleActive.ts` + Classes & Attendance entries to `AppShell.tsx`
      Two file changes that must land together: the nav entries need their module probe to exist or the module-active hook will always return "unknown" for attendance.
      Files:
      - `apps/web/src/features/modules/useModuleActive.ts` — edit
      - `apps/web/src/components/shell/AppShell.tsx` — edit
      
      **`useModuleActive.ts` change:** Add an `if (moduleKey === "attendance")` branch after the existing fees block (design §11):
      ```typescript
      if (moduleKey === "attendance") {
        if (can("attendance.view", permissions))         probePath = "/api/attendance/sessions";
        else if (can("attendance.mark", permissions))    probePath = "/api/attendance/sessions";
        else if (can("attendance.correct", permissions)) probePath = "/api/attendance/corrections";
      }
      ```
      Do NOT alter the `item.module ?? "fees"` fallback in `useNavItemVisible` — it is pre-existing behavior that is harmless for module-less items.

      **`AppShell.tsx` changes:**
      1. Add `BookOpen` and `ClipboardList` to the lucide-react import line.
      2. Add two entries to the `NAV` array after the Students entry (design §11):
      ```typescript
      {
        href: "/classes/sections",
        label: "Classes",
        icon: BookOpen,
        anyOf: ["classes.sections.manage", "classes.faculty.assign", "classes.timetable.manage", "classes.view"],
        // No module field — classes API is permission-gated only, never module-gated.
        // Omitting module means the item.module guard in useNavItemVisible never fires.
      },
      {
        href: "/attendance/sessions",
        label: "Attendance",
        icon: ClipboardList,
        anyOf: ["attendance.view", "attendance.mark", "attendance.correct"],
        module: "attendance",
      },
      ```
      Verify: `cd apps/web && npm run lint` — no TypeScript errors; existing fees/academics/students nav entries still compile.

- [ ] 7. Add utility helpers `features/classes/utils.ts` and `features/attendance/utils.ts`
      Two pure helper functions used by Screen 4 (timetable grid) and Screen 5 (session list). Extracted into their own files so they can be unit-tested independently.
      Files:
      - `apps/web/src/features/classes/utils.ts` — create
      - `apps/web/src/features/attendance/utils.ts` — create
      ```typescript
      // features/classes/utils.ts
      /** Converts a minute-of-day integer (0..1440) to HH:MM display label. */
      export function minuteToLabel(m: number): string {
        const h = Math.floor(m / 60).toString().padStart(2, "0");
        const min = (m % 60).toString().padStart(2, "0");
        return `${h}:${min}`;
      }
      ```
      ```typescript
      // features/attendance/utils.ts
      /** Returns today's date as a YYYY-MM-DD ISO string (local time). */
      export function todayISO(): string {
        return new Date().toISOString().slice(0, 10);
      }
      ```
      Verify: `cd apps/web && npm run lint` — no errors.

- [ ] 8. Screen 1 — Class Sections List (`app/(app)/classes/sections/page.tsx`)
      Depends on: steps 2, 4.
      Create the sections list page following the exact pattern of `app/(app)/academics/sessions/page.tsx`.
      Files:
      - `apps/web/src/app/(app)/classes/sections/page.tsx` — create (design §10 Screen 1)
      Structure:
      - `"use client";` first line
      - Default export `ClassSectionsPage` wraps `<ClassSectionsInner>` in `<RouteGuard>` (no `requirePermission`)
      - Client-side `statusTab` state: `"ALL" | "PLANNED" | "ACTIVE" | "CLOSED" | "CANCELLED"`. Filter `data.sections` client-side — no query param because `GET /api/classes/sections` accepts no status filter
      - Loading/error/empty rhythm: `isLoading → <Skeleton rows=3>` | `isError → <InlineError message>` | `empty → <EmptyState icon={LayoutGrid} label="No sections yet">`
      - Table columns: Program ID | Session ID | Term ID | Label | Capacity | Status (Badge) | Actions
      - Row "View" link → `/classes/sections/${section.id}` (always visible for authenticated users)
      - Row "Edit" button (opens `EditSectionDialog`): `<Can permission="classes.sections.manage">`
      - Create button: `<Can anyOf={["classes.sections.manage"]}>` → opens `CreateSectionDialog`
      - `CreateSectionDialog` fields: `programId` (Input), `academicSessionId` (Input), `academicTermId` (Input), `label?` (Input), `capacity?` (Input type="number"), `status?` (Select: PLANNED/ACTIVE/CLOSED/CANCELLED). Form schema: `createSectionSchema`. Mutation: `useCreateSection()`.
      - 409 error → `form.setError("root", { message: "A section for this program, session, and term already exists." })`, displayed below form fields with `<p className="text-sm text-destructive">`
      - 404 "program not found" → `form.setError("programId", { message: err.data?.error })`
      - 404 "invalid session or term" → `form.setError("academicTermId", { message: err.data?.error })`
      - `EditSectionDialog` fields: `label?`, `capacity?`, `status?`. Form schema: `editSectionSchema`. Mutation: `useUpdateSection(section.id)`.
      - onSuccess for both dialogs: `toast.success(...)`, `form.reset()`, `onOpenChange(false)`
      Imports: `LayoutGrid` from lucide-react, all shadcn Table/Dialog/Form/Input/Select/Badge/Skeleton, `EmptyState`, `InlineError`, `RouteGuard`, `Can`, `useSections`, `useCreateSection`, `useUpdateSection`, `createSectionSchema`, `editSectionSchema`, `ApiError`
      Verify: `cd apps/web && npm run lint` — no TypeScript errors.

- [ ] 9. Screen 2 — Section Detail (`app/(app)/classes/sections/[id]/page.tsx`)
      Depends on: steps 2, 4, 7.
      Files:
      - `apps/web/src/app/(app)/classes/sections/[id]/page.tsx` — create (design §10 Screen 2)
      Structure:
      - `"use client";` first line
      - Default export wraps inner component in `<RouteGuard>` (no `requirePermission`)
      - Reads `params.id` via `useParams()` from `next/navigation`
      - Hooks: `useSection(id)`, `useTimetables()`, `useAssignFaculty()`
      - Page header: section label + status Badge
      - Three `<Tabs>`: "Enrollments" | "Faculty" | "Timetable"
      - **Enrollments tab:** count + table of `section.enrollments` (studentId, status, enrolledAt). `<EmptyState>` when empty.
      - **Faculty tab (API gap handled):** Calls `useTimetables()`, filters `timetable.scheduledClasses` where `sc.classSectionId === section.id` across all timetables. Shows subject/faculty/room/period per scheduled class. Static note: `"Faculty shown from timetable scheduled classes."` Assign button: `<Can permission="classes.faculty.assign">` → opens `AssignFacultyDialog`.
      - `AssignFacultyDialog` fields: `facultyId` (Input), `subjectId` (Input), `academicTermId` (Input, default to `section.academicTermId`), `classSectionId` (hidden, always `section.id`), `role` (Select: PRIMARY/SUBSTITUTE/ASSISTANT, default PRIMARY), `replacesAssignmentId?` (Input, optional). Form schema: `assignFacultySchema`. Mutation: `useAssignFaculty()`.
      - 404 error mapping via `KIND_TO_FIELD` regex (design §10 Screen 2 exact snippet)
      - 409 → `toast.error(err.message)` 
      - **Timetable tab:** list timetables filtered by `section.academicTermId`. Each row links to `/classes/timetables/${t.id}`. Wrapped in `<Can anyOf={["classes.view", "classes.timetable.manage"]}>`.
      Verify: `cd apps/web && npm run lint` — no TypeScript errors.

- [ ] 10. Screen 3 — Faculty Assignments stub (`app/(app)/classes/assignments/page.tsx`)
       Depends on: step 2 (RouteGuard, EmptyState imports).
       This is a deliberate stub pending the `GET /api/classes/faculty/assignments` backend endpoint (API gap §4.1).
       Files:
       - `apps/web/src/app/(app)/classes/assignments/page.tsx` — create (design §10 Screen 3)
       ```typescript
       "use client";
       import { RouteGuard } from "@/components/auth/RouteGuard";
       import { EmptyState } from "@/components/ui-ext/EmptyState";
       import { Users } from "lucide-react";
       
       export default function FacultyAssignmentsPage() {
         return (
           <RouteGuard>
             <div className="space-y-6">
               <h1 className="text-2xl font-semibold text-gray-900">Faculty Assignments</h1>
               <EmptyState
                 icon={Users}
                 label="Coming soon"
                 description="The faculty assignments list requires a backend endpoint (GET /api/classes/faculty/assignments) that is not yet available."
               />
             </div>
           </RouteGuard>
         );
       }
       ```
       Verify: `cd apps/web && npm run lint` — no TypeScript errors.

- [ ] 11. Screen 4 — Timetable View (`app/(app)/classes/timetables/[id]/page.tsx`)
       Depends on: steps 2, 4, 7.
       Files:
       - `apps/web/src/app/(app)/classes/timetables/[id]/page.tsx` — create (design §10 Screen 4)
       Structure:
       - `"use client";` first line
       - Default export wraps inner in `<RouteGuard>` (no `requirePermission`)
       - Reads `params.id` via `useParams()`
       - Hooks: `useTimetable(id)`, `usePublishTimetable(id)`
       - Import `minuteToLabel` from `@/features/classes/utils`
       - Conflict state: `const [conflictData, setConflictData] = useState<ConflictReport | null>(null)`
       - `handlePublish(acceptWarnings = false)` function discriminates 409 responses (design §10 Screen 4 exact snippet): `err.data?.error === "Timetable conflict"` → open confirm dialog with `setConflictData(err.data?.conflicts ?? {})`; other 409 → `toast.error(err.message)`
       - Weekly grid: days MON–SAT as columns (SUN visible but lighter). Each `ScheduledClass` is a card in its day column: subject, faculty, room, period, `minuteToLabel(startTime)–minuteToLabel(endTime)`. Cancelled slots have dimmed styling.
       - Publish button: `<Can permission="classes.timetable.manage">` — no publish button for read-only `classes.view` users
       - Conflict confirm dialog: open when `conflictData !== null`. Shows conflict data as `<pre>{JSON.stringify(conflictData, null, 2)}</pre>`. "Publish anyway" button calls `handlePublish(true)`, sets `setConflictData(null)` on success.
       - Loading/error/empty rhythm with `Grid` icon for empty state
       Verify: `cd apps/web && npm run lint` — no TypeScript errors.

- [ ] 12. Screen 5 — Attendance Sessions List (`app/(app)/attendance/sessions/page.tsx`)
       Depends on: steps 3, 5, 7.
       Files:
       - `apps/web/src/app/(app)/attendance/sessions/page.tsx` — create (design §10 Screen 5)
       Structure:
       - `"use client";` first line
       - Default export wraps inner in `<RouteGuard>` (no `requirePermission`)
       - Import `todayISO` from `@/features/attendance/utils`
       - Permission check for display scope: `const canViewAll = can("attendance.view", permissions)` where permissions comes from `useAuthStore((s) => s.permissions)`. `attendance.view` always takes precedence; only `attendance.mark`-without-`attendance.view` users see today-filtered results.
       - `displayed` computed with `useMemo`: if `canViewAll`, all sessions; else filter by `s.date === todayISO()`
       - Status filter tabs: `ALL | OPEN | SUBMITTED | FINALIZED` (exact API enum — not CLOSED/CANCELLED)
       - Table columns: Session ID | Date | Status | Actions
       - Row actions (all permission-gated):
         - "Mark attendance" link → `/attendance/sessions/${session.id}/mark`: `<Can anyOf={["attendance.mark", "attendance.view"]}>` — for OPEN sessions
         - "Submit" button → `useSubmitSession(session.id).mutate()`: `<Can permission="attendance.mark">` — when `session.status === "OPEN"`
         - "Finalize" button → `useFinalizeSession(session.id).mutate()`: `<Can permission="attendance.mark">` — when `session.status === "SUBMITTED"`
       - Create session button: `<Can permission="attendance.mark">` → opens `CreateSessionDialog`
       - `CreateSessionDialog` form schema: `createSessionSchema`. Fields: `scheduledClassId` (Input), `date` (Input type="date"), `submissionDeadline?` (Input type="datetime-local"). Mutation: `useCreateAttendanceSession()`.
       - Empty state icon: `ClipboardList`
       Verify: `cd apps/web && npm run lint` — no TypeScript errors.

- [ ] 13. Screen 6 — Mark Attendance (`app/(app)/attendance/sessions/[id]/mark/page.tsx`)
       Depends on: steps 3, 5.
       Files:
       - `apps/web/src/app/(app)/attendance/sessions/[id]/mark/page.tsx` — create (design §10 Screen 6)
       Structure:
       - `"use client";` first line
       - Default export wraps inner in `<RouteGuard>` (no `requirePermission`)
       - Reads `params.id` via `useParams()`
       - Hooks: `useAttendanceSession(id)`, `useMarkAttendance(id)`, `useSubmitSession(id)`
       - Local mark state: `const [marks, setMarks] = useState<Record<string, string>>({})` + `const [isDirty, setIsDirty] = useState(false)`
       - `useEffect` initialises `marks` from `session.records` on first load (dep: `[session?.id]` only, to avoid re-running on every poll)
       - Student roster table: studentId column + four toggle buttons per row (PRESENT/ABSENT/LATE/EXCUSED, use `<Button variant="outline" size="sm">` with highlight on active). `handleToggle(studentId, status)` sets mark + `setIsDirty(true)`.
       - Save Marks button: `<Can permission="attendance.mark">`. Disabled when `!isDirty || markMutation.isPending`. On success: `toast.success("Marks saved.")`, `setIsDirty(false)`. On 403 "not assigned": `toast.error(...)`. On 409 finalized/submitted: `toast.error("Session is no longer open.")` + `qc.invalidateQueries`.
       - Submit button: `<Can permission="attendance.mark">`. Visible when `session.status === "OPEN"`. `isDirty` warning text shown above button (not a blocker). On success: `toast.success("Session submitted.")`, `router.push("/attendance/sessions")`.
       - Read-only roster view (no action buttons) available for `attendance.view` users — use `<Can permission="attendance.mark" fallback={<ReadOnlyRoster />}>` wrapper on the action column.
       Verify: `cd apps/web && npm run lint` — no TypeScript errors.

- [ ] 14. Screen 7 — Attendance Corrections (`app/(app)/attendance/corrections/page.tsx`)
       Depends on: steps 1, 3, 5.
       Files:
       - `apps/web/src/app/(app)/attendance/corrections/page.tsx` — create (design §10 Screen 7)
       Structure:
       - `"use client";` first line
       - Default export wraps inner in `<RouteGuard>` (no `requirePermission`)
       - **Permission divergence handled at top of inner component** (design §10 Screen 7 exact snippet):
         ```typescript
         const canReview = useCan("attendance.correct");
         const canMark   = useCan("attendance.mark");
         if (!canReview && canMark) {
           return <EmptyState icon={Info} label="View not available" description="Corrections are submitted from the Mark Attendance screen. Your submitted corrections are reviewed by your HOD or administrator." />;
         }
         ```
       - For `attendance.correct` holders: status filter tabs `ALL | PENDING | APPROVED | REJECTED`
       - Table columns: Record ID | Requested Status | Reason | Review Status | Submitted At | Actions
       - Per-row Approve/Reject buttons: `<Can permission="attendance.correct">`
       - `ReviewCorrectionDialog`: form schema `reviewCorrectionSchema`. Field: `reviewNote` rendered with `<Textarea>` (step 1 prerequisite). Approve: `useApproveCorrection(id).mutate({ reviewNote })`. Reject: `useRejectCorrection(id).mutate({ reviewNote })`.
       - 409 "correction not pending" → `toast.error("Correction has already been reviewed.")`
       - 409 "record changed since request" → `toast.error("The record was changed after this correction was submitted.")`
       - Import `useCan` from `@/lib/authz` (verify it is exported; if not, use `useAuthStore` + `can()` inline)
       Verify: `cd apps/web && npm run lint` — no TypeScript errors.

- [ ] 15. Screen 8 — Student Attendance Report (`app/(app)/attendance/report/page.tsx`)
       Depends on: steps 3, 5.
       Files:
       - `apps/web/src/app/(app)/attendance/report/page.tsx` — create (design §10 Screen 8)
       Structure:
       - `"use client";` first line
       - Default export wraps inner in `<RouteGuard>` (no `requirePermission`)
       - Outer layout: h1 + `<Can permission="attendance.view" fallback={<EmptyState icon={BarChart2} label="Permission required" description="You need the attendance.view permission to access section reports." />}>` wrapping the `<ReportFilterAndTable>` sub-component (design §10 Screen 8 exact structure)
       - `ReportFilterAndTable` (inline sub-component): two `<Input>` fields (Section ID, Academic Term ID) + "View Report" `<Button>` that sets `sectionId`/`termId` state to trigger `useSectionReport(sectionId, termId)`
       - Loading/error/empty rhythm → table
       - Table columns: Student ID | Attendance Rate (%) | Low Attendance (flag from `lowAttendance` array) 
       - Note in UI: report shows rates only (not total/present/absent counts) — matches API gap §4.6
       - `useSectionReport` hook's `enabled` already requires `attendance.view` so the query never fires for view_own users even if `<Can>` is somehow bypassed
       - Empty state icon: `BarChart2`
       Verify: `cd apps/web && npm run lint` — no TypeScript errors.

- [ ] 16. Full build and lint verification
       Run full TypeScript check and Next.js build to confirm all 8 screens, both feature modules, AppShell edits, and useModuleActive edit compile cleanly with no existing screens broken.
       Files: none (verification only)
       Verify:
       ```
       cd apps/web && npm run lint
       cd apps/web && npm run build
       ```
       Expected: zero TypeScript errors, zero ESLint errors, build succeeds. All pre-existing screens (fees, academics, sis) must still compile.

---

## Digest

### Files the plan touches

| File | Block/signature | Test | Verified today |
|---|---|---|---|
| `components/ui/textarea.tsx` | New file — `<Textarea>` shadcn component | None (primitive UI) | Directory listing confirmed file absent |
| `features/classes/types.ts` | New file — 9 exported interfaces/types (design §2) | None | Directory listing confirmed file absent |
| `features/classes/keys.ts` | New file — `classesKeys` const (design §4) | None | File absent |
| `features/classes/formSchemas.ts` | New file — `createSectionSchema`, `editSectionSchema`, `assignFacultySchema`, `createTimetableSchema` (design §6) | None | File absent |
| `features/classes/hooks.ts` | New file — 10 exported hooks + body interfaces + `apiPatch` helper (design §8) | None | File absent |
| `features/classes/utils.ts` | New file — `minuteToLabel(m)` (design §12) | Unit-testable with `vitest run` | File absent |
| `features/attendance/types.ts` | New file — 6 exported interfaces/types (design §3) | None | File absent |
| `features/attendance/keys.ts` | New file — `attendanceKeys` const (design §5) | None | File absent |
| `features/attendance/formSchemas.ts` | New file — `createSessionSchema`, `submitCorrectionSchema`, `reviewCorrectionSchema` (design §7) | None | File absent |
| `features/attendance/hooks.ts` | New file — 11 exported hooks + body interfaces + `apiPatch` helper (design §9) | None | File absent |
| `features/attendance/utils.ts` | New file — `todayISO()` (design §12) | Unit-testable with `vitest run` | File absent |
| `features/modules/useModuleActive.ts` | `useModuleActive()` — add `if (moduleKey === "attendance")` branch after fees block (design §11) | None | Read at line 18–24; fees block confirmed |
| `components/shell/AppShell.tsx` | `NAV` array — 2 new entries after Students; lucide import additions (design §11) | None | Read confirmed: Students is last entry; `BookOpen`/`ClipboardList` not yet imported |
| `app/(app)/classes/sections/page.tsx` | New file — Screen 1 (design §10) | None | Route dir absent |
| `app/(app)/classes/sections/[id]/page.tsx` | New file — Screen 2 (design §10) | None | Route dir absent |
| `app/(app)/classes/assignments/page.tsx` | New file — Screen 3 stub (design §10) | None | Route dir absent |
| `app/(app)/classes/timetables/[id]/page.tsx` | New file — Screen 4 (design §10) | None | Route dir absent |
| `app/(app)/attendance/sessions/page.tsx` | New file — Screen 5 (design §10) | None | Route dir absent |
| `app/(app)/attendance/sessions/[id]/mark/page.tsx` | New file — Screen 6 (design §10) | None | Route dir absent |
| `app/(app)/attendance/corrections/page.tsx` | New file — Screen 7 (design §10) | None | Route dir absent |
| `app/(app)/attendance/report/page.tsx` | New file — Screen 8 (design §10) | None | Route dir absent |

### Build and test commands (confirmed from `apps/web/package.json`)

- Lint (TypeScript check): `cd apps/web && npm run lint` → runs `tsc --noEmit -p tsconfig.lint.json`
- Build: `cd apps/web && npm run build` → runs `next build`
- Tests: `cd apps/web && npm run test` → runs `vitest run`

### Conventions confirmed from codebase reads

- Every page: `"use client";` first line → `export default function XPage() { return <RouteGuard><XInner /></RouteGuard>; }` → inner component holds all hooks/state
- `<RouteGuard>` with no `requirePermission` on every page; action-level gating via `<Can>`
- `apiPatch<T>` helper is local to each `hooks.ts` (not in `lib/api.ts`); same token/ApiError/401-logout implementation copied from academics
- `currentPermissions()` reads `useAuthStore.getState().permissions` (not a hook; safe to call outside render)
- `toastError(error)` shared pattern: `error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Something went wrong."`
- Mutations: `onSuccess` invalidates with prefix match (`queryKey: ["domain", "sub-key"]`), `onError: toastError` (except `usePublishTimetable` where screen handles inline)
- `textarea` component does not exist yet — must be created in step 1 before Screen 7
- `useCan` hook: verify export in `lib/authz.ts` before Screen 7; fall back to `useAuthStore((s) => s.permissions)` + `can()` if not exported
