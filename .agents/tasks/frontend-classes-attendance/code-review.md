# Classes + Attendance frontend modules (Screens 1–8)

Three commits add 21 new files and modify 2 existing ones to deliver the CLASSES module (class sections, section detail with faculty assignment, faculty-assignments stub, timetable weekly grid) and ATTENDANCE module (sessions list with CreateSession dialog, mark attendance with per-row correction requests, corrections review, section attendance report). The implementation mirrors the established fees/academics F0 pattern precisely: query-key factories, typed React Query hooks, zod form schemas, per-page `<RouteGuard>`, and `<Can>`-gated actions. All 10 checklist items (MF1–MF8, NIT-9, NIT-10) are resolved in the diff.

**Watch for:** (confirmed) Faculty users (`attendance.mark` only) reach the Sessions screen but get a 403 API error displayed as `<InlineError>` rather than a meaningful empty state — the backend GET /sessions route requires `attendance.view`, which FACULTY does not hold. (confirmed) Finalize is gated on `attendance.mark`, which the API allows but means faculty can one-way lock their own sessions with no supervisory sign-off.

**Verdict**: APPROVED

---

## High-level view

All 10 checklist items are confirmed resolved: MF1 (single `mutationFn` in `useMarkAttendance`), MF2 (`textarea.tsx` present), MF3 (`apiPatch`/`API_BASE` before any hook function in both hooks files), MF4 ("UTC date" comment on `todayISO`), MF5 (`classes.faculty.assign` only on the assign button), MF6 (`useAttendanceSessions`/`useAttendanceSession` enabled on `attendance.view || attendance.mark` with the role-mapping comment), MF7 (`useCreateTimetable` exported with forward-declaration comment and no callsite), MF8 (scheduledClassId dropdown, date-not-in-past refine, 409/403/404 paths correct), NIT-9 (no `"use client"` in hooks files), NIT-10 (`updatedAt?` optional on `FacultyAssignment`).

FACULTY holds `attendance.mark` but not `attendance.view`. `useAttendanceSessions` fires the query for `attendance.mark` holders, but `GET /api/attendance/sessions` requires `attendance.view` — so FACULTY gets a 403 rendered as `<InlineError>`. Since the mark page is only reachable by navigating from the sessions list, a faculty user who can't load the list also can't reach mark. The hooks file documents this API gap, but the UI doesn't degrade gracefully for this role.

`CreateSessionDialog` uses a `scheduledClassId` dropdown backed by `useAllScheduledClasses`, which issues N+1 parallel requests (timetable list + one detail per timetable). Subsequent opens are cache-free. Faculty users without `classes.view` get an empty dropdown with an explanatory amber note — no crash, but the dialog is unusable for that role until the backend adds a faculty-scoped scheduled-class endpoint.

The AppShell Classes nav entry correctly omits `module` (permission-only gate); Attendance entry carries `module: "attendance"` with a matching probe in `useModuleActive` that covers all three attendance permission variants.

<details>
<summary>Issues (2)</summary>

1. **Faculty 403 on Sessions list** — FACULTY (`attendance.mark` only) fires `useAttendanceSessions` but `GET /api/attendance/sessions` requires `attendance.view`; the 403 renders as `<InlineError>`. Add a 403-specific branch showing a role-appropriate empty state: "You can mark attendance by navigating directly to a session URL, or ask your administrator for a session link." Severity: medium.

2. **Finalize gated on `attendance.mark`** — Faculty can finalize their own sessions (backend confirms `attendance.mark` is the required permission for `POST /sessions/:id/finalize`). Finalization is a one-way lock with no supervisory sign-off step. Confirm this is the intended workflow, or introduce an `attendance.finalize` permission key for HOD/ADMIN. Severity: low / design question.

</details>

<details>
<summary>Details</summary>

### Faculty 403 on Sessions list — confirmed API mismatch

`GET /api/attendance/sessions` (`routes/attendance.ts` line 256) uses `requirePermission("attendance.view")`. A FACULTY caller — who holds `attendance.mark` but not `attendance.view` — hits the pre-handler and gets 403 before any session rows are evaluated. The hook's `enabled: can("attendance.view", perms) || can("attendance.mark", perms)` fires the query for FACULTY, which returns 403, and the sessions page renders `<InlineError message={error.message}>`. A faculty user sees an API error banner rather than a usable screen. The mark page (`/attendance/sessions/:id/mark`) is only reachable from the sessions list link, so this effectively blocks faculty from marking attendance.

The frontend-only fix: detect `error instanceof ApiError && error.status === 403` in the sessions page's `isError` branch and show a role-appropriate empty state instead of an error banner. A backend fix would add a faculty-scoped `GET /sessions` variant that filters by assigned sessions.

### Finalize permission boundary — confirmed

`useFinalizeSession` gates the button behind `<Can permission="attendance.mark">`. The backend also uses `attendance.mark` for `POST /sessions/:id/finalize`, so the frontend and API are aligned. The concern is behavioral: a faculty member can finalize their own session (a one-way state change to FINALIZED that triggers low-attendance alerts) without any HOD or admin review. Whether a supervisory gate is needed is a product decision.

### `useAllScheduledClasses` N+1 fan-out — likely performance concern

`useAllScheduledClasses` fetches `GET /api/classes/timetables` then issues one `GET /api/classes/timetables/:id` per timetable via `useQueries`. Each detail query shares the `useTimetable(id)` cache, so repeat dialog opens are free. On first open, N timetables means N+1 parallel requests. For institutions with many timetables (e.g. one per term × multiple programs across years), this is a burst of fetches blocking dialog usability until they resolve. No pagination or preload exists. Worth revisiting when institutional data grows.

</details>

---

<details>
<summary>File map</summary>

| File | Change |
|---|---|
| `components/ui/textarea.tsx` | New — shadcn `<Textarea>` component (MF2) |
| `features/classes/types.ts` | New — 9 exported interfaces/types |
| `features/classes/keys.ts` | New — `classesKeys` query-key factory |
| `features/classes/formSchemas.ts` | New — section, assignment, timetable zod schemas |
| `features/classes/hooks.ts` | New — 10 hooks + `apiPatch` helper |
| `features/classes/utils.ts` | New — `minuteToLabel(m)` helper |
| `features/attendance/types.ts` | New — 6 exported interfaces/types |
| `features/attendance/keys.ts` | New — `attendanceKeys` query-key factory |
| `features/attendance/formSchemas.ts` | New — session, correction, review zod schemas |
| `features/attendance/hooks.ts` | New — 11 hooks + `apiPatch` helper |
| `features/attendance/utils.ts` | New — `todayISO()` helper |
| `app/(app)/classes/sections/page.tsx` | New — Screen 1: sections list |
| `app/(app)/classes/sections/[id]/page.tsx` | New — Screen 2: section detail + assign faculty |
| `app/(app)/classes/assignments/page.tsx` | New — Screen 3: faculty assignments stub |
| `app/(app)/classes/timetables/[id]/page.tsx` | New — Screen 4: timetable weekly grid |
| `app/(app)/attendance/sessions/page.tsx` | New — Screen 5: sessions list + CreateSessionDialog |
| `app/(app)/attendance/sessions/[id]/mark/page.tsx` | New — Screen 6: mark attendance + SubmitCorrectionDialog |
| `app/(app)/attendance/corrections/page.tsx` | New — Screen 7: corrections review |
| `app/(app)/attendance/report/page.tsx` | New — Screen 8: section attendance report |
| `components/shell/AppShell.tsx` | Modified — added Classes + Attendance NAV entries |
| `features/modules/useModuleActive.ts` | Modified — added attendance module probe |

Full diff: `git -C c:/campusgate diff d801d1a HEAD`

</details>
