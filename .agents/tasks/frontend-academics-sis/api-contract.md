# API Contract — Academics + SIS Module UI

Ground-truth endpoint shapes extracted from source files on 2026-11-02.
All routes verified against `apps/api/src/routes/admin.ts`,
`apps/api/src/routes/students.ts`, `packages/shared/src/permissions.ts`,
and `packages/shared/src/modules.ts`.

---

## Route prefixes (from `apps/api/src/server.ts`)

| File | Registered prefix |
|------|------------------|
| `routes/admin.ts` | `/api/admin` |
| `routes/students.ts` | `/api/students` |

---

## 1. ACADEMIC SESSIONS

> Permission gate: `academics.sessions.manage` (all write ops); `academics.view` (read-only callers).
> Module gate: **NONE** — academics is foundational institution-layer data, permission-only.

### GET /api/admin/academic/sessions

List sessions, optionally filtered.

**Query params:**
```
status?  — e.g. "UPCOMING" | "ACTIVE" | "CLOSED"
```

**Response envelope:**
```json
{
  "sessions": [ /* AcademicSession[] */ ],
  "warnings": []
}
```

---

### POST /api/admin/academic/sessions

Create a new academic session.

**Request body:**
```json
{
  "name":          "string (required)",
  "structureType": "string (required) — e.g. SEMESTER | TRIMESTER | ANNUAL",
  "startDate":     "ISO date string (required)",
  "endDate":       "ISO date string (required)"
}
```

**Response envelope (201):**
```json
{
  "session": { /* AcademicSession */ },
  "warnings": []
}
```

**Error cases:**
- `409` — session name already exists for the institution

---

### GET /api/admin/academic/sessions/:id

Fetch a single session with its terms.

**Response envelope:**
```json
{
  "session": {
    /* AcademicSession fields */
    "terms": [ /* AcademicTerm[], ordered by ordinal asc */ ]
  },
  "warnings": []
}
```

**Error cases:**
- `404` — session not found

---

### PATCH /api/admin/academic/sessions/:id

Edit a session. **Allowed only when session status is `UPCOMING`** — any other status returns 409.

**Request body (all fields partial):**
```json
{
  "name":          "string?",
  "structureType": "string?",
  "startDate":     "ISO date string?",
  "endDate":       "ISO date string?"
}
```

**Response envelope:**
```json
{
  "session": { /* updated AcademicSession */ },
  "warnings": []
}
```

**Error cases:**
- `404` — session not found
- `409` — session not editable (status ≠ UPCOMING)

---

### POST /api/admin/academic/sessions/:id/terms

Add a term to a session.

**Request body:**
```json
{
  "name":      "string (required)",
  "ordinal":   "number (required) — 1-based term order",
  "startDate": "ISO date string (required)",
  "endDate":   "ISO date string (required)"
}
```

**Response envelope (201):**
```json
{
  "term": { /* AcademicTerm */ },
  "warnings": [ /* Warning[] — may include overlap / outside-session / count warnings */ ]
}
```

**Error cases:**
- `404` — session not found
- `409` — ordinal already exists for this session

---

### PATCH /api/admin/academic/terms/:id

Edit a term. **Not allowed when term status is `CLOSED`** (returns 409).

**Request body (all fields partial):**
```json
{
  "name":      "string?",
  "ordinal":   "number?",
  "startDate": "ISO date string?",
  "endDate":   "ISO date string?"
}
```

**Response envelope:**
```json
{
  "term": { /* updated AcademicTerm */ },
  "warnings": []
}
```

**Error cases:**
- `404` — term not found
- `409` — term not editable (status = CLOSED)

---

### POST /api/admin/academic/sessions/:id/activate

Activate a session (state machine transition: UPCOMING → ACTIVE).

**Query params (optional):**
```
handover=true  — closes any currently ACTIVE session before activating this one
```

**Request body (optional):**
```json
{ "handover": true }
```

**Response envelope:**
```json
{
  "session": { /* AcademicSession with status ACTIVE */ },
  "warnings": [ /* Warning[] */ ]
}
```

**Error cases:**
- `404` — session not found
- `409` — various: invalid state, no terms, term invalid dates, active session exists (pass `handover=true` to override)

---

### POST /api/admin/academic/sessions/:id/close

Close an active session (state machine: ACTIVE → CLOSED).

**Response envelope:**
```json
{
  "session": { /* AcademicSession with status CLOSED */ },
  "warnings": []
}
```

**Error cases:**
- `404` — session not found
- `409` — invalid state

---

### POST /api/admin/academic/terms/:id/activate

Activate a term. Parent session must be ACTIVE.

**Response envelope:**
```json
{
  "term": { /* AcademicTerm with status ACTIVE */ },
  "warnings": []
}
```

**Error cases:**
- `404` — term not found
- `409` — session not active, or term in invalid state

---

### POST /api/admin/academic/terms/:id/close

Close a term.

**Response envelope:**
```json
{
  "term": { /* AcademicTerm with status CLOSED */ },
  "warnings": []
}
```

**Error cases:**
- `404` — term not found
- `409` — invalid state

---

## 2. ACADEMIC PROGRAMS

> Permission gate: `academics.programs.manage`.
> Module gate: **NONE** — foundational institution-layer data, permission-only.

### GET /api/admin/academic/programs

List programs.

**Query params:**
```
departmentId?  — filter by department
status?        — e.g. "ACTIVE" | "INACTIVE"
```

**Response envelope:**
```json
{
  "programs": [ /* Program[] */ ],
  "warnings": []
}
```

---

### POST /api/admin/academic/programs

Create a new program.

**Request body:**
```json
{
  "departmentId":  "string (required)",
  "name":          "string (required)",
  "code":          "string (required) — must be unique per institution",
  "duration":      "number (required)",
  "durationUnit":  "string (required) — e.g. YEARS | SEMESTERS | MONTHS"
}
```

**Response envelope (201):**
```json
{
  "program": { /* Program */ },
  "warnings": []
}
```

**Error cases:**
- `400` — unknown department
- `409` — program code already exists

---

### PATCH /api/admin/academic/programs/:id

Update a program. All fields are partial.

**Request body (all optional):**
```json
{
  "name":         "string?",
  "code":         "string?",
  "duration":     "number?",
  "durationUnit": "string?",
  "departmentId": "string?",
  "status":       "ACTIVE | INACTIVE"
}
```

> Note: `status` is read directly from the raw request body (whitelisted separately from the Zod schema).

**Response envelope:**
```json
{
  "program": { /* updated Program */ },
  "warnings": []
}
```

**Error cases:**
- `404` — program not found
- `400` — unknown department
- `409` — program code already exists (when changing code)

---

## 3. ACADEMIC CALENDAR

> Permission gate: `academics.calendar.manage`.
> Module gate: **NONE** — foundational institution-layer data, permission-only.
> Route prefix: `/api/admin` (same admin.ts file).

### GET /api/admin/academic-calendar

Fetch calendar entries for a date range.

**Query params:**
```
startDate?    — ISO date string; defaults to first day of current month
endDate?      — ISO date string; defaults to last day of current month
departmentId? — scope to a department (null = institution-wide)
```

**Response:** Array of `AcademicCalendarDay` objects (no envelope wrapper — raw array).

---

### PUT /api/admin/academic-calendar/day

Upsert (create or update) a single calendar day entry.

**Request body:**
```json
{
  "date":               "YYYY-MM-DD (required)",
  "dayType":            "string (required) — e.g. WORKING | HOLIDAY | EXAM | EVENT",
  "note":               "string?",
  "academicSessionId":  "string?",
  "departmentId":       "string? — null = institution-wide"
}
```

> Note: Source also accepts `academicTermId` (not listed in the prompt spec but present in the schema).

**Response envelope:**
```json
{
  "calendarDay": { /* AcademicCalendarDay */ },
  "warnings": []
}
```

---

### DELETE /api/admin/academic-calendar/day/:date

Delete a calendar day entry.

**Path param:** `:date` — format `YYYY-MM-DD`

**Query params:**
```
departmentId? — scope to a department (null = institution-wide)
```

**Response envelope:**
```json
{
  "success": true,
  "warnings": []
}
```

**Error cases:**
- `404` — calendar day not found for that date/department

---

## 4. STUDENTS (SIS)

> Permission gates: various `students.*` permissions per operation (see section 5).
> Module gate: **NONE** — foundational institution-layer data, permission-only (confirmed by source comment: "Decision A").
> Route prefix: `/api/students` (routes/students.ts registered at `/api/students`).

### GET /api/students

List / search students.

**Query params (validated via `listStudentsQuerySchema`):**
```
status?      — StudentStatus enum
programId?   — filter by structured program FK
departmentId?— filter by department
q?           — free-text search across name, enrollmentNo, rollNumber
page?        — integer, default 1
pageSize?    — integer, capped at server-side max
```

> Note: HOD callers are automatically scoped to their own department (server-side `departmentScopeFilter`).

**Response envelope:**
```json
{
  "students": [ /* StudentProfile[] */ ],
  "pagination": {
    "page":       1,
    "pageSize":   20,
    "total":      42,
    "totalPages": 3
  }
}
```

---

### GET /api/students/:id

Fetch a single student profile with related data.

**Response:** `StudentProfile` with relations:
```json
{
  /* StudentProfile fields */
  "department":       { /* Department */ },
  "structuredProgram":{ /* Program | null */ },
  "academicSession":  { /* AcademicSession | null */ },
  "currentTerm":      { /* AcademicTerm | null */ }
}
```
(No `{ student, warnings }` envelope — returns the profile object directly.)

**Error cases:**
- `404` — student not found (or HOD cannot see this department)

---

### POST /api/students/:id/deactivate

Archive a student via a terminal status. This is the **only** supported way to change student status to a non-active value.

> **Important:** There is no `PATCH /api/students/:id/status` route. Use this endpoint for all status deactivation operations.

**Request body:**
```json
{
  "status": "WITHDRAWN | SUSPENDED | GRADUATED | ON_LEAVE (required)",
  "reason": "string? (optional — stored in StudentProfileHistory)"
}
```

**Response:** Updated `StudentProfile` object (no envelope wrapper).

**Error cases:**
- `400` — invalid status value
- `404` — student not found

---

### POST /api/students/:id/promote

Advance a student's term/semester.

**Request body:**
```json
{
  "semester":      "number? — explicit semester number; defaults to current semester",
  "currentTermId": "string? — target term FK; if omitted, keeps current term"
}
```

**Response:** Updated `StudentProfile` object (no envelope wrapper).

**Error cases:**
- `400` — invalid target term
- `404` — student not found

---

### Additional SIS endpoints (in students.ts, not in main scope but present)

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `POST` | `/api/students/` | `students.create` | Create a student (User + StudentProfile in one tx) |
| `PATCH` | `/api/students/:id` | `students.update` | Edit permitted mutable fields (name, rollNumber, section, dob, phone, address, admissionDate) |
| `POST` | `/api/students/:id/assign-program` | `students.update` | Link student to a structured Program FK |
| `POST` | `/api/students/:id/enroll` | `students.enroll` | Enroll into an academic session/term |
| `POST` | `/api/students/:id/transfer` | `students.update` | Transfer to another department/program |
| `GET` | `/api/students/:id/history` | `students.view` | Paginated append-only change history |

---

## 5. PERMISSION KEYS

Exact values from `packages/shared/src/permissions.ts`:

```
academics.sessions.manage   — create/update/activate/close sessions and terms
academics.programs.manage   — manage academic programs
academics.calendar.manage   — manage academic calendar entries
academics.view              — read-only view of sessions, terms, programs, calendar

students.view               — view student records, list, detail, history
students.create             — create a student
students.update             — edit permitted fields; assign program; transfer; reactivate
students.deactivate         — archive via status (withdraw/suspend/graduate/leave)
students.promote            — advance term/semester
```

Additional students permissions (also in the catalogue, for reference):
```
students.enroll             — enroll a student into a session/term
students.view_own           — student self-service (own profile only)
```

---

## 6. MODULE KEYS

Exact values from `packages/shared/src/modules.ts`:

```
academic_sessions    — "Academic Sessions" — sessions/terms
class_course         — "Class & Course" — classes/courses
student_management   — "Student Management" — SIS
```

---

## 7. MODULE GATING NOTES

**Academics routes are NOT module-gated.** The source code comment confirms:

> "academics is foundational, not a gated module — Decision A"
> `requirePermission(...)` ONLY — NO `requireModuleActive` call on any academic route.

**Students routes are also NOT module-gated.** From the source:

> "Decision A: these are foundational institution-layer data — gated by
> `requirePermission("students.<x>")` ONLY, NEVER `requireModuleActive`."

This means `useModuleActive` is **not** needed for either academics or students nav items in AppShell. These items show/hide based solely on `canAny(item.anyOf, perms)`.

---

## 8. REACT QUERY HOOK PATTERN (mirror from `features/fees/hooks.ts`)

```typescript
// Query keys file — e.g. features/academics/keys.ts
export const academicsKeys = {
  sessions:       ()           => ["academics", "sessions"] as const,
  session:        (id: string) => ["academics", "sessions", id] as const,
  terms:          (sessionId: string) => ["academics", "sessions", sessionId, "terms"] as const,
  programs:       ()           => ["academics", "programs"] as const,
  program:        (id: string) => ["academics", "programs", id] as const,
  calendar:       (params: object) => ["academics", "calendar", params] as const,
};

export const studentsKeys = {
  list:    (params: object) => ["students", params] as const,
  detail:  (id: string)     => ["students", id] as const,
  history: (id: string)     => ["students", id, "history"] as const,
};
```

**Query hook template:**
```typescript
export function useSessions(status?: string) {
  const permissions = useAuthStore.getState().permissions;
  const qs = status ? `?status=${status}` : "";
  return useQuery<{ sessions: AcademicSession[]; warnings: Warning[] }>({
    queryKey: academicsKeys.sessions(),
    queryFn:  () => api.get(`/api/admin/academic/sessions${qs}`),
    enabled:  can("academics.sessions.manage", permissions) ||
              can("academics.view", permissions),
  });
}
```

**Mutation hook template (PATCH — uses apiPatch helper from fees pattern):**
```typescript
export function useUpdateSession(id: string) {
  const qc = useQueryClient();
  return useMutation<{ session: AcademicSession; warnings: Warning[] }, ApiError, Partial<AcademicSessionBody>>({
    mutationFn: (body) => apiPatch(`/api/admin/academic/sessions/${id}`, body),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: academicsKeys.sessions() });
      qc.invalidateQueries({ queryKey: academicsKeys.session(id) });
    },
    onError: toastError,
  });
}
```

**POST mutation hook template:**
```typescript
export function useActivateSession(id: string) {
  const qc = useQueryClient();
  return useMutation<{ session: AcademicSession; warnings: Warning[] }, ApiError, { handover?: boolean }>({
    mutationFn: (body) => api.post(`/api/admin/academic/sessions/${id}/activate`, body),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: academicsKeys.sessions() });
      qc.invalidateQueries({ queryKey: academicsKeys.session(id) });
    },
    onError: toastError,
  });
}
```

---

## 9. AppShell NAV ITEMS to add

Based on the existing `NAV` array shape in `apps/web/src/components/shell/AppShell.tsx`:

```typescript
// No module? field — academics and students are never module-gated
{
  href:   "/academics/sessions",
  label:  "Academic Sessions",
  icon:   CalendarDays, // or BookOpen — pick from lucide-react
  anyOf:  ["academics.sessions.manage", "academics.view"],
  // module: omitted — not gated
},
{
  href:   "/academics/programs",
  label:  "Programs",
  icon:   GraduationCap,
  anyOf:  ["academics.programs.manage", "academics.view"],
},
{
  href:   "/academics/calendar",
  label:  "Academic Calendar",
  icon:   Calendar,
  anyOf:  ["academics.calendar.manage", "academics.view"],
},
{
  href:   "/students",
  label:  "Students",
  icon:   Users,
  anyOf:  ["students.view", "students.create"],
},
```
