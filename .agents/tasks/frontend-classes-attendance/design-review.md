# Design Review — Classes & Attendance Frontend Modules

**Document reviewed:** `c:/campusgate/.agents/tasks/frontend-classes-attendance/design.md` (Revision 2)
**API contract:** `c:/campusgate/.agents/tasks/frontend-classes-attendance/api-contract.md`
**Review type:** Fresh review of Revision 2 (design states "all prior findings addressed")
**Reviewer:** Design Review Agent

---

## Prior Findings Re-Check (R1 → R2)

The design lists 15 prior findings (F1–F15) and their claimed resolutions. Each is re-examined below:

| Prior | Severity | Status | Notes |
|---|---|---|---|
| F1 `useModuleActive` fallback | MEDIUM | **Closed** — §11 correctly documents the `item.module ?? "fees"` pass-through and confirms the `item.module && ...` guard makes it harmless. |
| F2 Screen 7 faculty corrections | HIGH | **Closed** — explicit `attendance.correct`/`attendance.mark` branch renders `EmptyState`. |
| F3 Screen 8 `view_own` exposure | HIGH | **Closed** — `<Can permission="attendance.view">` wrapper with fallback `EmptyState`. |
| F4 `useAssignFaculty` invalidation | HIGH | **Closed** — `classesKeys.timetables()` always invalidated. |
| F5 Screen 6 Submit visibility | HIGH | **Closed** — Submit shown whenever `session.status === "OPEN"`, `isDirty` warning text only. |
| F6 `classesKeys` filter params | MEDIUM | **Closed** — explicit note: no filter param because the GET accepts none. |
| F7 `attendance.view` precedence | MEDIUM | **Closed** — explicitly stated. |
| F8 `FacultyAssignment.endedAt` | MEDIUM | **Closed** — field added with comment. |
| F9 Screen 4 conflict dialog state | MEDIUM | **Closed** — `useState<ConflictReport | null>(null)` with discriminated 409 handling. |
| F10 Screen 2 404 mapping | MEDIUM | **Closed** — `KIND_TO_FIELD` map and regex provided. |
| F11 `"use client"` directive | HIGH | **Closed** — all screen designs start with `"use client";`. |
| F12 Screen 1 409 error target | MEDIUM | **Closed** — mapped to `form.setError("root", ...)`. |
| F13 `createSectionSchema` status enum | NIT | **Closed** — no action needed, confirmed correct. |
| F14 `minuteToLabel`/`todayISO` signatures | NIT | **Closed** — §12 provides exact signatures and examples. |
| F15 `useSubmitSession`/`useFinalizeSession` body | NIT | **Closed** — no-body `api.post(url)` confirmed. |

---

## New Findings

### Finding 1 — HIGH: Duplicate `mutationFn` in `useMarkAttendance` is a compile error

**Where:** `features/attendance/hooks.ts`, `useMarkAttendance` function (§9).

**Problem:** The object literal inside `useMutation` contains two `mutationFn` keys:

```typescript
return useMutation<{ changed: number }, ApiError, MarkRecordsBody>({
  mutationFn: (body) => api.post(`/api/attendance/sessions/${sessionId}/records`, body),
  // Note: ...
  mutationFn: (body) => apiPatch(`/api/attendance/sessions/${sessionId}/records`, body),
```

TypeScript strict mode emits `error TS2300: Duplicate identifier 'mutationFn'`. Even if the compiler is lenient, the first `mutationFn` (using `api.post`) calls the wrong HTTP method — the API contract specifies PATCH for record updates. The correct final value `apiPatch(...)` would silently win in JS, but the duplicate is a lint + build failure. Additionally, the `apiPatch` function is declared as a `const` BELOW `useMarkAttendance` in the hooks file (temporal dead zone); calling it from a function body that runs after module initialisation is fine at runtime, but TypeScript with `noImplicitAny`/strict will still require the forward reference to be resolved. More critically, the comment incorrectly states `api.post` is being used — anyone reading this will be confused.

**Fix:** Remove the first `mutationFn` line entirely and keep only the `apiPatch` call. Also move the `apiPatch` declaration to the top of the file (before all hook functions) matching the `features/classes/hooks.ts` pattern:

```typescript
// ─── apiPatch helper ─────────────────────────────────────────────────────────
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

async function apiPatch<T>(endpoint: string, body?: unknown): Promise<T> { ... }

// ─── Hooks follow below ───────────────────────────────────────────────────────

export function useMarkAttendance(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<{ changed: number }, ApiError, MarkRecordsBody>({
    mutationFn: (body) => apiPatch(`/api/attendance/sessions/${sessionId}/records`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: attendanceKeys.session(sessionId) });
    },
    onError: toastError,
  });
}
```

---

### Finding 2 — HIGH: `<Textarea>` component does not exist — Screen 7 will fail to compile

**Where:** Screen 7 (Attendance Corrections) review dialog, §10/Screen 7.

**Problem:** The design states "Field: `reviewNote` — rendered with `<Textarea>` from `components/ui/textarea`. Implementation must verify this component exists; if not, substitute `<textarea className="...">` directly." The reviewer has verified: there is NO `textarea.tsx` in `apps/web/src/components/ui/` (confirmed by directory listing — only `avatar`, `badge`, `button`, `card`, `dialog`, `dropdown-menu`, `form`, `input`, `label`, `select`, `separator`, `skeleton`, `table`, `tabs` exist). The design passes the responsibility to the coder as a runtime check, but the design itself should resolve this definitively rather than leaving the coder to discover a compilation error.

**Fix:** The design must make a firm choice. Either:

**Option A (preferred — add the component):** Add `apps/web/src/components/ui/textarea.tsx` (standard shadcn component, 20 lines) and import it normally. The coder then has a definitive component to import.

**Option B (inline native element):** Replace the `<Textarea>` reference with the specific raw-HTML fallback the design intends:

```tsx
<FormField
  control={form.control}
  name="reviewNote"
  render={({ field }) => (
    <FormItem>
      <FormLabel>Review note (optional)</FormLabel>
      <FormControl>
        <textarea
          {...field}
          rows={3}
          maxLength={2000}
          className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </FormControl>
      <FormMessage />
    </FormItem>
  )}
/>
```

The design must commit to one of these; leaving it ambiguous is a HIGH gap.

---

### Finding 3 — HIGH: `apiPatch` in `features/attendance/hooks.ts` is declared after the hooks that use it

**Where:** `features/attendance/hooks.ts` §9 — `apiPatch` const is defined at line ~180 (after `useMarkAttendance`, `useSubmitSession`, `useFinalizeSession`), but called inside `useMarkAttendance` (at line ~130).

**Problem:** `apiPatch` is a `const` (not a `function` declaration), so it is NOT hoisted. In module scope, `const` declarations exist in the temporal dead zone until their line is reached. Calling `apiPatch(...)` inside `useMarkAttendance`'s closure is fine at call-time (the hook is called after module initialisation), but TypeScript strict mode will report the identifier as used before declaration, and the coder reading the file will be confused about call order. More importantly, the pattern diverges from `features/classes/hooks.ts` (which correctly places `apiPatch` at the top) and `features/academics/hooks.ts` (same).

**Fix:** Move the entire `apiPatch` + `API_BASE` block to the top of `features/attendance/hooks.ts`, immediately after the imports and before any hook function, matching the established pattern in `features/classes/hooks.ts` and `features/academics/hooks.ts`. The file structure should be: imports → `API_BASE` → `apiPatch` → `currentPermissions` → `toastError` → hooks.

---

### Finding 4 — MEDIUM: `todayISO()` is documented as "local time" but the implementation returns UTC date

**Where:** §12 (Utility Helpers), and Screen 5 (client-side faculty filter).

**Problem:** The design comment says `/** Returns today's date as a YYYY-MM-DD ISO string (local time). */` but the implementation is:

```typescript
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
```

`toISOString()` always returns UTC. For a faculty in IST (UTC+5:30), at 11:00 PM local time, `todayISO()` returns yesterday's UTC date, causing today's sessions to disappear from the filtered view until midnight UTC (5:30 AM IST). This is a real user-facing bug. The API contract says `AttendanceSession.date` is "truncated to UTC midnight," so server-stored dates are in UTC. Comparing client local-date vs. server UTC-date will cause mismatch.

**Two valid fixes:**

**Option A (match server UTC):** Keep `toISOString().slice(0,10)` but remove the misleading "local time" comment — the comparison is correct because the server also stores dates at UTC midnight:

```typescript
/** Returns today's date as YYYY-MM-DD in UTC (matches server storage). */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
```

**Option B (use local date):** Use the local date, which aligns better with faculty expectation of "today":

```typescript
/** Returns today's local date as YYYY-MM-DD. */
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
```

The design must pick one and remove the ambiguous comment. Given that the server stores UTC midnight dates, Option A is technically correct (faculty creating a session at 11 PM IST for "today" would have given a UTC date), but Option B matches user intuition. **The design must state a definitive choice.**

---

### Finding 5 — MEDIUM: Screen 2 Faculty tab uses `<Can permission="classes.assignments.manage" anyOf={["classes.faculty.assign"]}>` which is invalid usage of `<Can>`

**Where:** Screen 2 (Section Detail), Faculty tab, assign button (§10/Screen 2).

**Problem:** The design shows:

```
Assign button: <Can permission="classes.assignments.manage" anyOf={["classes.faculty.assign"]}>
```

Then immediately notes: "Implementation note: the permission key `classes.assignments.manage` does not exist. Use `<Can permission="classes.faculty.assign">` (the actual key from the shared package)."

The design correctly identifies its own error, but still includes the invalid code snippet. Looking at `Can.tsx`: when both `permission` and `anyOf` are passed, the `permission` check takes precedence and the `anyOf` list is ignored. Since `classes.assignments.manage` is NOT a real permission key (confirmed in `packages/shared/src/permissions.ts`), the button would NEVER render — `perms.includes("classes.assignments.manage")` is always `false`, and the `anyOf` fallback is never reached.

**Fix:** Remove the erroneous code snippet entirely. The design text under this section must show only:

```tsx
<Can permission="classes.faculty.assign">
  <Button onClick={() => setAssignOpen(true)}>Assign Faculty</Button>
</Can>
```

The "implementation note" must also be removed (it's now the primary instruction, not a footnote).

---

### Finding 6 — MEDIUM: Screen 5 `useMemo` dependency array includes `canViewAll` but `canViewAll` is derived from a store subscription that may not update the memo

**Where:** Screen 5 (Attendance Sessions List), client-side filtering block (§10/Screen 5).

**Problem:**

```typescript
const permissions = useAuthStore((s) => s.permissions);
const canViewAll = can("attendance.view", permissions);

const displayed = useMemo(() => {
  ...
}, [data, canViewAll]);
```

`canViewAll` is a derived boolean computed outside `useMemo`. React's `useMemo` compares dependencies by reference equality. Since `canViewAll` is a primitive boolean, equality works correctly. However, `permissions` (the array) is referenced only to compute `canViewAll` — the memo's dependency list does not include `permissions`. If permissions change (e.g., during an impersonation or session refresh), `canViewAll` will update, but React won't know to re-run the memo because `canViewAll` only changes if the boolean flips.

Actually, because `canViewAll` IS included in the dependency array, this works correctly for the boolean value — but the concern is that `permissions` is re-subscribed every render via `useAuthStore((s) => s.permissions)` and any change to permissions will trigger a re-render which recomputes `canViewAll`, which will then trigger the memo. This is fine.

**BUT:** The bigger issue is the design shows `const canViewAll = can("attendance.view", permissions)` — where `permissions` comes from `useAuthStore((s) => s.permissions)`. This is correct. However, the design ALSO shows this in the same function:

```typescript
"use client";
const permissions = useAuthStore((s) => s.permissions);
const canViewAll = can("attendance.view", permissions);
```

These two lines derive `canViewAll` correctly. The memo dependency `[data, canViewAll]` is complete and correct. **Revise this to NIT level** — the design is actually correct here and this finding is not a genuine ambiguity.

*Reclassified: this finding is withdrawn.* (The memo dependency analysis is sound.)

---

### Finding 7 — MEDIUM: `useAttendanceSession` `enabled` gate missing `attendance.mark` without `attendance.view`

**Where:** `features/attendance/hooks.ts`, `useAttendanceSession` function (§9).

**Problem:** `useAttendanceSession` uses:

```typescript
enabled: Boolean(id) && (can("attendance.view", perms) || can("attendance.mark", perms)),
```

This appears correct. However, `GET /api/attendance/sessions/:id` requires `attendance.view` (per the API contract): `"attendance.view" (+module)`. The `attendance.mark` permission is for mutating sessions. A user holding only `attendance.mark` would have the query enabled, but the API would return 403.

**Verified from API contract §2:** `GET /api/attendance/sessions/:id` requires `attendance.view` — NOT `attendance.mark`. `attendance.mark` is for POST/PATCH mutation endpoints.

**Fix:** Change the `enabled` guard to only check `attendance.view`:

```typescript
// useAttendanceSessions
enabled: can("attendance.view", perms),

// useAttendanceSession  
enabled: Boolean(id) && can("attendance.view", perms),
```

Faculty with only `attendance.mark` should NOT be fetching session lists or session details via `useAttendanceSession` / `useAttendanceSessions`. They access the mark-attendance page via the sessions list which they CAN see (they hold `attendance.mark` which enables `POST /api/attendance/sessions` and `PATCH /api/attendance/sessions/:id/records`). The sessions list for navigation purposes is fetched with `attendance.view`.

Actually — re-reading the API contract: "GET /api/attendance/sessions — `attendance.view` (+module)". A faculty member with ONLY `attendance.mark` and no `attendance.view` cannot call `GET /api/attendance/sessions`. This means Screen 5 is unusable for them unless they also hold `attendance.view`. This is an existing design gap that needs to be acknowledged: faculty who can only `attendance.mark` cannot even SEE the sessions list.

**Revised Fix:** The design must explicitly acknowledge that `GET /api/attendance/sessions` requires `attendance.view`, so faculty holding ONLY `attendance.mark` cannot see any sessions. Either (a) document that `attendance.mark` roles in the app also receive `attendance.view`, or (b) add a note that Screen 5 will be empty/inaccessible for `attendance.mark`-only users, or (c) note that the sessions list `enabled` gate on `attendance.view || attendance.mark` will result in a 403 for mark-only users and add explicit 403 handling. The design currently sets `enabled: can("attendance.view", perms) || can("attendance.mark", perms)` which fires the query for mark-only users and silently gets a 403. This is a real user-facing gap.

---

### Finding 8 — MEDIUM: No timetable list/index page — navigation to timetable detail is undefined

**Where:** File inventory (§14), NAV entry for Classes points to `/classes/sections`, Screen 4 design.

**Problem:** The file inventory includes `app/(app)/classes/timetables/[id]/page.tsx` but NO `app/(app)/classes/timetables/page.tsx` (index/list). The nav entry points to `/classes/sections`. Section 2 (Section Detail) shows a Timetable tab that "lists timetables for this section's `academicTermId`. Each row links to `/classes/timetables/${timetable.id}`."

This means the only way to reach a timetable is through the Section Detail Timetable tab. However, `useTimetables()` is called on the Section Detail page and filtered client-side by `academicTermId`. There is no standalone timetable list. A user holding `classes.timetable.manage` who wants to create or view timetables must navigate section → timetable tab. This is an acceptable design choice, but it is never explicitly stated and creates the following gap: `useCreateTimetable()` hook exists in `features/classes/hooks.ts` but no screen in the inventory calls it (Screen 4 is timetable-detail only; no "Create Timetable" dialog is specified anywhere).

**Fix:** Either (a) add a timetable list page `app/(app)/classes/timetables/page.tsx` with a create-timetable button, or (b) add `CreateTimetableDialog` to the Section Detail Timetable tab (gated on `classes.timetable.manage`), or (c) explicitly document that timetable creation is out of scope for this iteration and `useCreateTimetable` is a forward-declared hook. The current design leaves `useCreateTimetable` as dead code with no callsite.

---

### Finding 9 — MEDIUM: Screen 5 `CreateSessionDialog` fields and flow are underspecified

**Where:** Screen 5 (Attendance Sessions List), row action "Open session" (§10/Screen 5).

**Problem:** The design mentions a `CreateSessionDialog` for the "Open session" row action with: "Opens a `CreateSessionDialog`." But no dialog design follows for this — no form schema usage, no field list, no mutation invocation, no success/error handling, no 403/404/409 mapping. The `createSessionSchema` from `features/attendance/formSchemas.ts` has fields `scheduledClassId`, `date`, and optional `submissionDeadline`. The API can return:
- `403 "not a faculty member"` / `"not assigned to this class"`
- `404 "scheduled class not found"`
- `409 "scheduled class cancelled"` / `"date does not match scheduled class"` / `"session already exists"`

None of these error mappings are specified for the create-session dialog. This is a gap equivalent in severity to the Screen 2 AssignFacultyDialog error mapping (prior F10 was HIGH in the original review).

**Fix:** Add a `CreateSessionDialog` specification to Screen 5 with:
1. Form schema: `createSessionSchema` from `features/attendance/formSchemas`
2. Fields: `scheduledClassId` (Input), `date` (Input type="date"), `submissionDeadline?` (Input type="datetime-local", optional)
3. Mutation: `useCreateAttendanceSession()`
4. Error mapping:
   - 403 → `toast.error("You are not assigned to this class.")`
   - 404 → `form.setError("scheduledClassId", { message: "Scheduled class not found." })`
   - 409 `"session already exists"` → `form.setError("date", { message: "A session for this class on this date already exists." })`
   - 409 `"date does not match scheduled class"` → `form.setError("date", { message: err.data?.error })`
   - 409 `"scheduled class cancelled"` → `toast.error("This scheduled class has been cancelled.")`
5. onSuccess: `toast.success("Session opened.")`, `form.reset()`, `onOpenChange(false)`, invalidate sessions

---

### Finding 10 — NIT: `"use client"` directive comment in `hooks.ts` is misleading

**Where:** `features/classes/hooks.ts`, first comment block (§8).

**Problem:**

```typescript
// features/classes/hooks.ts
"use client";  // Not required here — hooks.ts is a plain TS module, not a page/component.
               // The "use client" directive is only needed on page and component files.
```

This includes `"use client";` as a directive AND immediately comments that it is not required. The directive will be parsed by Next.js if present, not ignored. The design should either include it without the contradictory comment or (better) omit it entirely. Having `"use client"` on a plain TS module is harmless in Next.js 14 (it marks the module as client-only, which is correct for hooks calling `useAuthStore.getState()` at module init time), but the contradictory comment will confuse the coder.

**Fix:** Remove the `"use client";` line and the associated comment from `hooks.ts` files entirely (as done in `features/academics/hooks.ts` — confirmed: no `"use client"` present there). The comment in §8 acknowledging this is sufficient.

---

### Finding 11 — NIT: `FacultyAssignment.updatedAt` typed as required but may not be in all API responses

**Where:** `features/classes/types.ts` §2, `FacultyAssignment` interface.

**Problem:**

```typescript
export interface FacultyAssignment {
  ...
  updatedAt: string;         // may not be present in all API responses; treat as optional
}
```

The comment says "may not be present in all API responses; treat as optional" but the TypeScript type declares it as required (`updatedAt: string`). This is internally contradictory. If the field may be absent, the type should be `updatedAt?: string`.

**Fix:** Either change to `updatedAt?: string` to match the comment, or remove the comment if the field is always present (confirm from API contract — the API contract does not list `updatedAt` as a FacultyAssignment field; it lists: `id`, `institutionId`, `facultyId`, `subjectId`, `classSectionId`, `academicTermId`, `role`, `status`, `endedAt`, `createdAt`).

**Recommended fix:** Based on the API contract which does not list `updatedAt` on `FacultyAssignment`, remove `updatedAt` from the interface entirely, or type it as `updatedAt?: string`. Do not declare a required field and then comment that it may be missing.

---

## Verified Assumptions

These claims in the design were checked against source files and are correct:

1. **`lib/api.ts` exports `get/post/put/delete` only — no PATCH.** Verified. The `api` object has `get`, `post`, `put`, `delete`. PATCH is correctly handled via the local `apiPatch` helper.

2. **`ApiError` is exported from `lib/api.ts`.** Verified — `export { ApiError }`.

3. **`RouteGuard` accepts an optional `requirePermission`.** Verified in `RouteGuard.tsx`.

4. **`<Can>` accepts `permission` OR `anyOf` but treats `permission` as the primary check.** Verified in `Can.tsx` — `permission ? perms.includes(permission) : anyOf ? anyOf.some(...) : false`.

5. **`useModuleActive` falls back to `item.module ?? "fees"` and the guard `if (item.module && moduleStatus === "inactive")` is skipped for module-less nav items.** Verified in `AppShell.tsx`.

6. **`useModuleActive` currently only has a probe for `"fees"` — an attendance probe must be added.** Verified in `useModuleActive.ts` — only the `if (moduleKey === "fees")` branch exists.

7. **`classes.*` and `attendance.*` permission keys exist exactly as listed in the design.** Verified against `packages/shared/src/permissions.ts`.

8. **`"attendance"` and `"class_course"` are valid `ModuleKey` literals.** Verified in `packages/shared/src/modules.ts`.

9. **`"use client"` is NOT present in `features/academics/hooks.ts`.** Verified.

10. **`apiPatch` is declared at the top of `features/academics/hooks.ts` (before all hook functions).** Verified.

11. **`attendanceKeys.corrections(status)` correctly includes the status in the cache key.** Verified against the pattern — `["attendance", "corrections", status ?? "all"]`.

12. **`EmptyState` (`icon`, `label`, `description`) and `InlineError` (`message`) exist.** Verified in `components/ui-ext/`.

13. **shadcn `Table`, `Dialog`, `Form`, `Input`, `Select`, `Badge`, `Skeleton`, `Tabs` components all exist.** Verified — all are present in `components/ui/`.

14. **`PermissionKey` type is imported from `@campusgate/shared` in existing components.** Verified in `Can.tsx`, `RouteGuard.tsx`, `AppShell.tsx`.

15. **`GET /api/attendance/sessions` returns ALL sessions with no date/faculty filter.** Verified in API contract §2.

16. **Session statuses are `OPEN`/`SUBMITTED`/`FINALIZED` (not `OPEN`/`CLOSED`/`CANCELLED`).** Verified in API contract §2 and §4.5.

17. **`GET /api/attendance/reports/section/:sectionId` does NOT return per-student present/absent counts.** Verified in API contract §2.

---

## Unverified / Wrong Assumptions

1. **`<Textarea>` from `components/ui/textarea` — WRONG.** This component does not exist. (Finding 2.)

2. **`apiPatch` is placed before its call sites in `features/attendance/hooks.ts` — WRONG.** The design places `apiPatch` at line ~180 after the hooks that call it. (Finding 3.)

3. **`todayISO()` comment says "local time" but uses `toISOString()` — WRONG.** `toISOString()` returns UTC, not local time. (Finding 4.)

4. **Screen 2 assigns button uses `<Can permission="classes.assignments.manage">` — WRONG key.** `classes.assignments.manage` does not exist in `packages/shared/src/permissions.ts`. (Finding 5.)

5. **`useAttendanceSessions` and `useAttendanceSession` with `enabled` including `attendance.mark` — WRONG.** `GET /api/attendance/sessions` and `GET /api/attendance/sessions/:id` require `attendance.view`, not `attendance.mark`. (Finding 7.)

---

## Verdict

| Severity | Count |
|---|---|
| HIGH | 3 (Findings 1, 2, 3) |
| MEDIUM | 4 (Findings 4, 5, 7, 8, 9 — Finding 6 withdrawn) |
| NIT | 2 (Findings 10, 11) |

**Total HIGH + MEDIUM: 8**

**VERDICT: CHANGES_REQUESTED**
