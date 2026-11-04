# Examinations Frontend — API Contract

Recorded from source files on first read. Do NOT invent or interpolate — every
claim here is taken directly from the file listed as source.

---

## Endpoints

All routes are mounted at `/api/exams` (registered in `server.ts`).

Every route carries:
- `authenticate` — global preHandler hook (decodes JWT, populates `request.user` and `request.auth`)
- `requireModuleActive("examinations")` — per-route preHandler (module key `examinations`)
- `requirePermission("<key>")` — per-route preHandler (listed per endpoint below)

The publish route adds an extra `requireStepUp("exams.results.publish")` step-up gate (exact ordering: `requirePermission` → `requireStepUp` → `requireModuleActive`).

The status-advance route checks the required permission **inside the handler** (because it depends on the target status).

### 1. `POST /api/exams`
- **Permission**: `exams.manage`
- **Request body** (`createExaminationSchema`):
  ```json
  {
    "academicSessionId": "string (cuid-like, required)",
    "academicTermId": "string (cuid-like, required)",
    "programId": "string (cuid-like, required)",
    "name": "string (min 1, max 200, required)",
    "type": "'MIDTERM' | 'FINAL' | 'INTERNAL' | 'SUPPLEMENTARY'",
    "parentExaminationId": "string (cuid-like, optional — SUPPLEMENTARY only)"
  }
  ```
- **Response 201**:
  ```json
  {
    "id": "string",
    "academicSessionId": "string",
    "academicTermId": "string",
    "programId": "string",
    "name": "string",
    "type": "string",
    "status": "string",
    "createdByUserId": "string",
    "createdAt": "ISO string",
    "updatedAt": "ISO string"
  }
  ```
- **Error shapes**: `{ error: "academic session not found" }` 404 / `{ error: "program not found" }` 404 / `{ error: "<reason>" }` 400 (supplementary linkage)
- **Guard**: SUPPLEMENTARY type requires `parentExaminationId` and the parent must exist in the same tenant.

---

### 2. `PATCH /api/exams/:id`
- **Permission**: `exams.manage`
- **Request body** (`patchExaminationSchema`):
  ```json
  { "name": "string (min 1, max 200, optional — but at least one field required)" }
  ```
- **Response 200**: serialized Examination object (same shape as POST 201)
- **Error shapes**: `{ error: "examination not found" }` 404

---

### 3. `GET /api/exams`
- **Permission**: `exams.results.view`
- **Response 200**:
  ```json
  { "examinations": [/* Examination[] */] }
  ```

---

### 4. `GET /api/exams/:id`
- **Permission**: `exams.results.view`
- **Response 200**: serialized Examination object
- **Error shapes**: `{ error: "examination not found" }` 404

---

### 5. `POST /api/exams/:id/status`
- **Permission**: checked inside handler based on target status:
  - `SCHEDULED` → `exams.manage`
  - `MARKS_OPEN` → `exams.manage`
  - `MARKS_LOCKED` → `exams.moderate`
  - `MODERATION` → `exams.moderate`
  - `APPROVED` → `exams.moderate`
  - `PUBLISHED` — NOT reachable via this route (step-up-gated publish route only)
- **Module gate**: `requireModuleActive("examinations")` only (no top-level `requirePermission`)
- **Request body** (`advanceExamStatusSchema`):
  ```json
  { "to": "'SCHEDULED' | 'MARKS_OPEN' | 'MARKS_LOCKED' | 'MODERATION' | 'APPROVED'" }
  ```
- **Response 200**: `{ "id": "string", "status": "string" }`
- **Error shapes**:
  - `{ error: "unsupported status transition target" }` 400
  - `{ error: "Forbidden: missing permission <key>" }` 403
  - `{ error: "examination not found" }` 404
  - `{ error: "illegal status transition" }` 409

---

### 6. `POST /api/exams/:id/schedules`
- **Permission**: `exams.manage`
- **Request body** (`createExamScheduleSchema`):
  ```json
  {
    "subjectId": "string (cuid-like, required)",
    "room": "string (min 1, max 100, required)",
    "roomCapacity": "number (int, positive, required)",
    "startsAt": "ISO datetime string",
    "endsAt": "ISO datetime string"
  }
  ```
- **Response 201**: ExamSchedule object (raw Prisma shape: `id, institutionId, examId, subjectId, room, roomCapacity, startsAt, endsAt, createdAt, updatedAt`)
- **Error shapes**: `{ error: "examination not found" }` 404 / `{ error: "subject not found" }` 404 / `{ error: "a schedule for this exam+subject already exists" }` 409

---

### 7. `GET /api/exams/:id/schedules`
- **Permission**: `exams.results.view`
- **Response 200**: `{ "schedules": [/* ExamSchedule[] */] }` ordered by `startsAt asc`

---

### 8. `POST /api/exams/:id/schedules/:scheduleId/allocate`
- **Permission**: `exams.candidates.manage`
- **Request body** (`allocateCandidatesSchema`):
  ```json
  { "candidateIds": ["string (cuid-like)"] /* min 1, max 1000 */ }
  ```
- **Response 200**: `{ "allocated": number, "occupied": number }`
- **Error shapes**: `{ error: "schedule not found" }` 404 / `{ error: "one or more candidates not found for this exam" }` 404 / `{ error: "candidate already allocated to another schedule" }` 409 / `{ error: "room full" }` 409 / `{ error: "seat taken" }` 409
- **Concurrency**: uses `pg_advisory_xact_lock` on `examalloc:{institutionId}:{scheduleId}`; already-on-same-schedule ⇒ idempotent no-op.

---

### 9. `POST /api/exams/:id/candidates`
- **Permission**: `exams.candidates.manage`
- **Request body** (`registerCandidatesSchema`):
  ```json
  { "studentIds": ["string (cuid-like)"] /* min 1, max 5000 */ }
  ```
- **Response 201**: `{ "registered": number, "candidateIds": ["string"] }`
- **Error shapes**: `{ error: "examination not found" }` 404 / `{ error: "one or more students not found" }` 404
- **Idempotency**: duplicate student ⇒ silent skip (409 unique violation is caught internally)

---

### 10. `GET /api/exams/:id/candidates`
- **Permission**: `exams.results.view`
- **Response 200**: `{ "candidates": [/* Candidate[] */] }` ordered by `createdAt asc`

---

### 11. `POST /api/exams/:id/assessments`
- **Permission**: `exams.manage`
- **Request body** (`createAssessmentSchema`):
  ```json
  {
    "subjectId": "string (cuid-like, required)",
    "name": "string (min 1, max 100, required)",
    "maxMarks": "number (int, positive, required)",
    "weight": "number (int, min 1, max 100, required)"
  }
  ```
- **Service invariant**: sum of weights for (exam, subject) must be ≤ 100 at every point (soft — new component checked against existing sum + new weight > 100 → 400)
- **Response 201**: Assessment object (raw Prisma shape: `id, institutionId, examId, subjectId, name, maxMarks, weight, createdAt, updatedAt`)
- **Error shapes**: `{ error: "examination not found" }` 404 / `{ error: "subject not found" }` 404 / `{ error: "weights must sum to 100" }` 400 / `{ error: "an assessment with this name already exists for this subject" }` 409

---

### 12. `PATCH /api/exams/:id/assessments/:assessmentId`
- **Permission**: `exams.manage`
- **Request body** (`patchAssessmentSchema`):
  ```json
  {
    "name": "string (min 1, max 100, optional)",
    "maxMarks": "number (int, positive, optional)",
    "weight": "number (int, min 1, max 100, optional)"
  }
  ```
  At least one field required.
- **Response 200**: updated Assessment object
- **Error shapes**: `{ error: "assessment not found" }` 404 / `{ error: "weights must sum to 100" }` 400

---

### 13. `GET /api/exams/:id/assessments`
- **Permission**: `exams.results.view`
- **Response 200**: `{ "assessments": [/* Assessment[] */] }` ordered by `createdAt asc`

---

### 14. `PUT /api/exams/:id/marks`
- **Permission**: `exams.marks.enter`
- **Scope**: Faculty only; scoped by FacultyAssignment to the candidate's ClassSection for the exam's academicTermId. Deactivated faculty → 403.
- **Accepted only while `status === 'MARKS_OPEN'`** (otherwise 409 `marks locked`)
- **Request body** (`putMarksSchema`):
  ```json
  {
    "marks": [
      {
        "assessmentId": "string (cuid-like)",
        "candidateId": "string (cuid-like)",
        "marks": "number (int, min 0)"
      }
    ]
    /* array min 1, max 5000 */
  }
  ```
- **Response 200**: `{ "written": number, "records": [{ "marksRecordId": "string", "changeType": "'MARKED' | 'CORRECTED'" }] }`
- **Error shapes**: `{ error: "examination not found" }` 404 / `{ error: "marks locked" }` 409 / `{ error: "not a faculty member" }` 403 / `{ error: "assessment not found for this exam" }` 404 / `{ error: "candidate not found for this exam" }` 404 / `{ error: "marks out of range" }` 400 / `{ error: "out of scope for this subject/section" }` 403

---

### 15. `GET /api/exams/:id/marks`
- **Permission**: `exams.results.view`
- **Response 200**: `{ "marks": [/* MarksRecord[] */] }` ordered by `createdAt asc`

---

### 16. `POST /api/exams/:id/marks/:recordId/correct`
- **Permission**: `exams.moderate`
- **Accepted only while `status === 'MODERATION'`** (otherwise 409 `marks locked`)
- **Request body** (`correctMarkSchema`):
  ```json
  {
    "marks": "number (int, min 0, required)",
    "reason": "string (min 1, max 500, required)"
  }
  ```
- **Response 200**: `{ "marksRecordId": "string" }`
- **Error shapes**: `{ error: "examination not found" }` 404 / `{ error: "marks locked" }` 409 / `{ error: "marks record not found" }` 404 / `{ error: "assessment not found" }` 404 / `{ error: "marks out of range" }` 400

---

### 17. `POST /api/exams/grading-schemes`
- **Permission**: `exams.grading.manage`
- **Request body** (`createGradingSchemeSchema`):
  ```json
  {
    "name": "string (min 1, max 200, required)",
    "isActive": "boolean (optional)",
    "bands": [
      {
        "minPercentBps": "number (int, min 0, max 10000)",
        "maxPercentBps": "number (int, min 0, max 10000)",
        "gradeLabel": "string (min 1, max 20)",
        "gradePoints": "number (int, min 0)",
        "isPassing": "boolean"
      }
    ]
    /* min 1, max 50 bands */
  }
  ```
  Band validation (server-side): must start at 0, end at 10000, be contiguous (non-overlapping, no gaps), isPassing monotonic non-decreasing.
- **Response 201**: GradingScheme object (raw Prisma shape — no bands in the top-level POST response)
- **Error shapes**: `{ error: "<band validation message>" }` 400 / `{ error: "a grading scheme with this name already exists" }` 409
- **Side-effect**: if `isActive: true`, all other active schemes for the tenant are deactivated first (within same transaction).

---

### 18. `PATCH /api/exams/grading-schemes/:id`
- **Permission**: `exams.grading.manage`
- **Request body** (`patchGradingSchemeSchema`):
  ```json
  {
    "name": "string (min 1, max 200, optional)",
    "isActive": "boolean (optional)",
    "bands": [/* same GradeBandInput shape, optional — replaces wholesale */]
  }
  ```
  At least one field required.
- **Response 200**: `{ "id": "string" }`
- **Error shapes**: `{ error: "grading scheme not found" }` 404 / `{ error: "<band validation>" }` 400

---

### 19. `GET /api/exams/grading-schemes`
- **Permission**: `exams.results.view`
- **Response 200**: `{ "gradingSchemes": [/* GradingScheme + { bands: GradeBand[] } */ ] }` bands ordered by `ordinal asc`

---

### 20. `POST /api/exams/:id/publish` ← STEP-UP GATED
- **preHandler order**: `requirePermission("exams.results.publish")` → `requireStepUp("exams.results.publish")` → `requireModuleActive("examinations")`
- **Request body** (optional):
  ```json
  { "reason": "string (required for re-publication, i.e. version > 1)" }
  ```
- **Response 201**: `{ "publicationId": "string", "version": number, "snapshotCount": number }`
- **Error shapes**: `{ error: "examination not found" }` 404 / `{ error: "exam not approved" }` 409 / `{ error: "no active grading scheme" }` 409 / `{ error: "reason required for a re-publication" }` 400 / `{ error: "grading misconfigured" }` 409 / `{ error: "prior version not in PUBLISHED state" }` 409
- **Step-up failure**: 401 `{ error: "Step-up required" }` — the `x-step-up` header was absent, expired, had wrong action, or wrong userId.
- **Concurrency**: advisory lock on `exampub:{institutionId}:{examId}`; re-publication flips prior PUBLISHED version to SUPERSEDED in the same transaction.

---

### 21. `GET /api/exams/:id/results`
- **Permission**: `exams.results.view`
- **Response 200**:
  ```json
  {
    "publications": [/* ResultPublication[] */],
    "latestVersion": "number | null",
    "snapshots": [/* ResultSnapshot[] of latest version */]
  }
  ```
  snapshots ordered by `studentId asc, subjectId asc`

---

### 22. `GET /api/exams/:id/results/distribution`
- **Permission**: `exams.results.view`
- **Response 200**:
  ```json
  {
    "latestVersion": "number | null",
    "gradeDistribution": { "<gradeLabel>": number },
    "passed": number,
    "failed": number
  }
  ```
  Uses latest publication (any status, max version — not filtered to PUBLISHED).

---

### 23. `GET /api/exams/:id/results/rollups`
- **Permission**: `exams.results.view`
- **Response 200**:
  ```json
  {
    "latestVersion": "number | null",
    "perSubject": [
      { "subjectId": "string", "count": number, "passed": number, "failed": number, "avgPercentBps": number }
    ]
  }
  ```

---

### 24. `GET /api/exams/:id/results.xlsx`
- **Permission**: `exams.results.view`
- **Response**: binary `.xlsx` file (`Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`)
- **Headers**: `Content-Disposition: attachment; filename="exam-<examId>-results.xlsx"`
- **Columns**: Student ID, Candidate ID, Subject ID, Percent (2 dp), Grade, Grade Points (2 dp), Passed (YES/NO)

---

### 25. `GET /api/exams/me/results`
- **Permission**: `exams.results.view_own`
- **Response 200**:
  ```json
  {
    "results": [
      {
        "examId": "string",
        "version": number,
        "snapshots": [/* ResultSnapshot[] for this student */]
      }
    ]
  }
  ```
  Returns ONLY results from the **latest PUBLISHED** (status-filtered) publication; superseded/unpublished exams are invisible.

---

### 26. `GET /api/exams/me/results/:examId`
- **Permission**: `exams.results.view_own`
- **Response 200**: `{ "published": true, "version": number, "snapshots": [/* ResultSnapshot[] */] }`
- **Response 404**: `{ "error": "no published result" }` — also returned if the result is superseded/unpublished.

---

### 27. `POST /api/exams/me/reeval`
- **Permission**: `exams.reeval.request_own`
- **Request body** (`createReevalRequestSchema`):
  ```json
  {
    "examId": "string (cuid-like, required)",
    "subjectId": "string (cuid-like, required)",
    "reason": "string (min 1, max 500, required)"
  }
  ```
- **Response 201**: serialized ReevalRequest (see shape below)
- **Error shapes**: `{ error: "no student profile" }` 404 / `{ error: "no published result" }` 404 / `{ error: "a re-evaluation request is already open" }` 409

---

### 28. `GET /api/exams/me/reeval`
- **Permission**: `exams.reeval.request_own`
- **Response 200**: `{ "requests": [/* ReevalRequest[] */] }` ordered by `createdAt desc, id asc`

---

### 29. `GET /api/exams/reeval`
- **Permission**: `exams.reeval.manage`
- **Query params** (`listReevalQuerySchema`):
  - `status?: 'REQUESTED' | 'UNDER_REVIEW' | 'REMARKED' | 'CLOSED' | 'REJECTED'`
  - `examId?: string`
- **Response 200**: `{ "requests": [/* ReevalRequest[] */] }` ordered by `createdAt asc, id asc`

---

### 30. `POST /api/exams/reeval/:id/transition`
- **Permission**: `exams.reeval.manage`
- **Request body** (`transitionReevalSchema`):
  ```json
  {
    "to": "'UNDER_REVIEW' | 'REMARKED' | 'CLOSED' | 'REJECTED'",
    "note": "string (min 1, max 500, optional — required when to='REJECTED')",
    "outcomePublicationId": "string (cuid-like, optional — only valid when to='REMARKED')"
  }
  ```
- **Response 200**: `{ "id": "string", "status": "string" }`
- **Error shapes**: `{ error: "re-evaluation request not found" }` 404 / `{ error: "illegal re-evaluation transition" }` 409 / `{ error: "outcome publication not found" }` 404 / `{ error: "re-evaluation request changed concurrently" }` 409

---

### 31. `POST /api/exams/reeval/:id/remark`
- **Permission**: `exams.reeval.manage`
- **Accepted only while request status is `UNDER_REVIEW`**
- **Request body** (`remarkReevalSchema`):
  ```json
  {
    "marksRecordId": "string (cuid-like, required)",
    "marks": "number (int, min 0, required)",
    "reason": "string (min 1, max 500, required)"
  }
  ```
- **Response 200**: `{ "marksRecordId": "string", "previousMarks": number, "newMarks": number }`
- **Error shapes**: `{ error: "re-evaluation request not found" }` 404 / `{ error: "request not under review" }` 409 / `{ error: "marks record not found for this request" }` 404 / `{ error: "marks out of range" }` 400

---

### 32. `POST /api/exams/:id/candidates/supplementary`
- **Permission**: `exams.candidates.manage`
- **Request body** (`registerSupplementaryCandidatesSchema`):
  ```json
  {
    "subjectIds": ["string (cuid-like)"] /* min 1, max 1000 */,
    "studentIds": ["string (cuid-like)"] /* max 5000, optional — if absent, all eligible are registered */
  }
  ```
- **Response 201**: `{ "eligibleCount": number, "registered": number, "candidateIds": ["string"] }`
- **Error shapes**: `{ error: "examination not found" }` 404 / `{ error: "not a supplementary examination" }` 409 / `{ error: "parent results not published" }` 409 / `{ error: "one or more students are not eligible" }` 409

---

### 33. `GET /api/exams/me/results/history`
- **Permission**: `exams.results.view_own`
- **Response 200**:
  ```json
  {
    "history": [
      {
        "examId": "string",
        "examName": "string | null",
        "examType": "string | null",
        "academicSessionId": "string | null",
        "academicTermId": "string | null",
        "parentExaminationId": "string | null",
        "version": number,
        "publishedAt": "ISO string",
        "subjects": [
          { "subjectId": "string", "percentBps": number, "gradeLabel": "string", "gradePoints": number, "passed": boolean }
        ]
      }
    ]
  }
  ```
  Latest PUBLISHED only per exam, sorted by `publishedAt desc, examId asc`.

---

### 34. `GET /api/exams/students/:studentId/results/history`
- **Permission**: `exams.results.view`
- **Response 200**: same `{ "history": [...] }` shape, but includes ALL publication statuses (PUBLISHED + SUPERSEDED) — staff view.

---

### 35. `GET /api/exams/students/:studentId/results/history.xlsx`
- **Permission**: `exams.results.view`
- **Response**: binary `.xlsx` (`Content-Disposition: attachment; filename="student-<studentId>-results-history.xlsx"`)
- **Columns**: Exam, Type, Session, Term, Subject, Percent, Grade, Grade Points, Passed, Version, Status

---

### ReevalRequest serialized shape
```json
{
  "id": "string",
  "examId": "string",
  "candidateId": "string",
  "studentId": "string",
  "subjectId": "string",
  "sourcePublicationId": "string",
  "status": "string",
  "studentReason": "string",
  "requestedByUserId": "string",
  "processedByUserId": "string | null",
  "staffNote": "string | null",
  "outcomePublicationId": "string | null",
  "createdAt": "ISO string",
  "updatedAt": "ISO string"
}
```

---

## Permission Keys

Source: `c:\campusgate\packages\shared\src\permissions.ts`

All keys whose `module` is `"examinations"`:

```typescript
"exams.manage"            // Create/update examinations, schedules, assessments; status advance to APPROVED
"exams.grading.manage"    // Create/update grading schemes + bands
"exams.candidates.manage" // Register candidates; allocate rooms
"exams.marks.enter"       // Enter/edit own in-scope marks (scope enforced in service)
"exams.moderate"          // Lock marks, run moderation corrections, approve
"exams.results.publish"   // Publish results (step-up-gated)
"exams.results.view"      // Staff read of unpublished + published results/reports
"exams.results.view_own"  // Student read of OWN latest PUBLISHED result only
"exams.reeval.request_own" // Student self-service re-evaluation request against OWN published result
"exams.reeval.manage"     // Staff re-evaluation processing (transition + re-mark on a PUBLISHED exam)
```

Separation of duties noted in the permissions catalogue:
- `ADMIN` never gets `exams.marks.enter`
- `ADMIN` never gets the STUDENT-only `exams.results.view_own`
- `STUDENT` never gets `exams.reeval.manage`
- Staff roles never get `exams.reeval.request_own`

---

## Module Key

Source: `c:\campusgate\packages\shared\src\modules.ts`

```typescript
"examinations"
```

Declared dependencies (from `MODULE_DEPENDENCIES`):
```typescript
examinations: ["academic_sessions", "class_course", "student_enrollment"]
```

This is a **gated** module — every route MUST carry `requireModuleActive("examinations")`.

---

## Validation Schemas

Source: `c:\campusgate\packages\shared\src\validation.ts` (Phase 8 section)

### `examinationTypeEnum`
```typescript
z.enum(["MIDTERM", "FINAL", "INTERNAL", "SUPPLEMENTARY"])
```

### `reevalRequestStatusEnum`
```typescript
z.enum(["REQUESTED", "UNDER_REVIEW", "REMARKED", "CLOSED", "REJECTED"])
```

### `createExaminationSchema`
```typescript
{
  academicSessionId: z.string().min(1).max(64),   // cuidLikeString
  academicTermId:    z.string().min(1).max(64),
  programId:         z.string().min(1).max(64),
  name:              z.string().min(1).max(200),
  type:              examinationTypeEnum,
  parentExaminationId: z.string().min(1).max(64).optional(),  // SUPPLEMENTARY only
}
```

### `patchExaminationSchema`
```typescript
z.object({ name: z.string().min(1).max(200).optional() })
  .refine(v => v.name !== undefined, { message: "no updatable fields provided" })
```

### `advanceExamStatusSchema`
```typescript
{ to: z.enum(["SCHEDULED", "MARKS_OPEN", "MARKS_LOCKED", "MODERATION", "APPROVED"]) }
```

### `createExamScheduleSchema`
```typescript
{
  subjectId:    z.string().min(1).max(64),
  room:         z.string().min(1).max(100),
  roomCapacity: z.number().int().positive(),
  startsAt:     z.string().datetime(),
  endsAt:       z.string().datetime(),
}
```

### `allocateCandidatesSchema`
```typescript
{ candidateIds: z.array(z.string().min(1).max(64)).min(1).max(1000) }
```

### `registerCandidatesSchema`
```typescript
{ studentIds: z.array(z.string().min(1).max(64)).min(1).max(5000) }
```

### `createAssessmentSchema`
```typescript
{
  subjectId: z.string().min(1).max(64),
  name:      z.string().min(1).max(100),
  maxMarks:  z.number().int().positive(),
  weight:    z.number().int().min(1).max(100),
}
```

### `patchAssessmentSchema`
```typescript
z.object({
  name:     z.string().min(1).max(100).optional(),
  maxMarks: z.number().int().positive().optional(),
  weight:   z.number().int().min(1).max(100).optional(),
}).refine(v => v.name !== undefined || v.maxMarks !== undefined || v.weight !== undefined, {
  message: "no updatable fields provided",
})
```

### `putMarksSchema`
```typescript
{
  marks: z.array(z.object({
    assessmentId: z.string().min(1).max(64),
    candidateId:  z.string().min(1).max(64),
    marks:        z.number().int().min(0),
  })).min(1).max(5000),
}
```

### `correctMarkSchema`
```typescript
{
  marks:  z.number().int().min(0),
  reason: z.string().min(1).max(500),
}
```

### `gradeBandInputSchema` (embedded in grading scheme schemas)
```typescript
{
  minPercentBps: z.number().int().min(0).max(10000),
  maxPercentBps: z.number().int().min(0).max(10000),
  gradeLabel:    z.string().min(1).max(20),
  gradePoints:   z.number().int().min(0),
  isPassing:     z.boolean(),
}
```

### `createGradingSchemeSchema`
```typescript
{
  name:     z.string().min(1).max(200),
  isActive: z.boolean().optional(),
  bands:    z.array(gradeBandInputSchema).min(1).max(50),
}
```

### `patchGradingSchemeSchema`
```typescript
z.object({
  name:     z.string().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  bands:    z.array(gradeBandInputSchema).min(1).max(50).optional(),
}).refine(v => v.name !== undefined || v.isActive !== undefined || v.bands !== undefined, {
  message: "no updatable fields provided",
})
```

### `createReevalRequestSchema`
```typescript
{
  examId:    z.string().min(1).max(64),
  subjectId: z.string().min(1).max(64),
  reason:    z.string().min(1).max(500),
}
```

### `transitionReevalSchema`
```typescript
z.object({
  to:                   z.enum(["UNDER_REVIEW", "REMARKED", "CLOSED", "REJECTED"]),
  note:                 z.string().min(1).max(500).optional(),
  outcomePublicationId: z.string().min(1).max(64).optional(),
})
.refine(v => v.to !== "REJECTED" || v.note !== undefined, { message: "note is required when rejecting" })
.refine(v => v.outcomePublicationId === undefined || v.to === "REMARKED", { message: "outcomePublicationId only for REMARKED" })
```

### `remarkReevalSchema`
```typescript
{
  marksRecordId: z.string().min(1).max(64),
  marks:         z.number().int().min(0),
  reason:        z.string().min(1).max(500),
}
```

### `listReevalQuerySchema`
```typescript
{
  status: reevalRequestStatusEnum.optional(),
  examId: z.string().min(1).max(64).optional(),
}
```

### `registerSupplementaryCandidatesSchema`
```typescript
{
  subjectIds: z.array(z.string().min(1).max(64)).min(1).max(1000),
  studentIds: z.array(z.string().min(1).max(64)).max(5000).optional(),
}
```

---

## MFA Step-Up Contract

Source: `c:\campusgate\apps\api\src\middleware\step-up.ts` and `c:\campusgate\apps\api\src\services\mfa.ts`

### 403 body when `requireStepUp` fails
`requireStepUp` actually returns **401** (not 403) when the token is absent, expired, or invalid:
```json
{ "error": "Step-up required" }
```
HTTP status: **401**

### When `requirePermission` fails before step-up is reached
```json
{ "error": "Forbidden" }
```
HTTP status: **403**

### Step-up token shape
A short-lived JWT minted by `POST /api/auth/mfa/verify` after a successful TOTP/recovery-code assertion:
```typescript
interface StepUpClaims {
  userId:  string;
  jti:     string;      // random UUID — unique per token
  stepUp:  true;
  action:  string;      // e.g. "exams.results.publish"
  exp:     number;      // Unix timestamp; TTL = 5 minutes (300 seconds)
}
```

### How to pass it on the high-risk request
Add the header:
```
x-step-up: <stepUpJwt>
```

The `requireStepUp` middleware reads `request.headers["x-step-up"]` (string). It checks:
1. Header must be a non-empty string (else 401)
2. JWT signature + expiry (via `app.jwt.verify`) must be valid
3. `claims.stepUp === true`
4. `claims.userId === request.auth.userId` (bound to the authenticated user)
5. `claims.action === actionClass` (bound to the specific action, e.g. `"exams.results.publish"`)

Any mismatch → 401 `{ error: "Step-up required" }`.

### Obtaining a step-up token
The frontend calls `POST /api/auth/mfa/verify` with a current TOTP code to receive the step-up token. Token TTL is 5 minutes; it is multi-use within that TTL but action-class bound.

### MFA enrollment flow (MfaEnrollment.tsx)
1. `POST /api/auth/mfa/enroll/start {}` → `{ otpauthUri: string, qrCodeDataUrl: string }` (base64 PNG)
2. User scans QR or enters setup key in authenticator app
3. `POST /api/auth/mfa/enroll/verify { code: string }` → `{ enabled: true, recoveryCodes: string[] }`

The login page (`app/login/page.tsx`) does not implement a step-up token storage; it only calls `POST /api/auth/login` and stores the resulting JWT via `setAuth(token, user)`. **No `stepUpToken` field exists in the auth store.** The step-up token must be fetched on-demand before a step-up-gated action.

---

## Auth Store Shape

Source: `c:\campusgate\apps\web\src\stores\auth.ts`

```typescript
interface AuthState {
  // Persisted
  token:              string | null;       // JWT Bearer token
  user:               UserInfo | null;     // { id, email, role: string, accountStatus, profile? }
  roles:              string[];            // decoded from JWT claims
  permissions:        string[];            // decoded from JWT claims (PermissionKey values)
  permissionsVersion: number | null;       // decoded from JWT claims
  membershipId:       string | null;       // decoded from JWT claims
  institutionId:      string | null;       // decoded from JWT claims

  // Runtime-only
  hydrated:           boolean;

  // Actions
  setAuth:     (token: string, user: UserInfo) => void;
  logout:      () => void;
  setHydrated: () => void;
}
```

**No `stepUpToken` field** — the step-up JWT is not stored in the auth store; it must be fetched fresh from `POST /api/auth/mfa/verify` immediately before a step-up-gated request.

Persistence key: `"campusgate-auth"`, version: `1`. Claims are decoded from the JWT at `setAuth` time via `decodeAuthClaims(token)`. A pre-v1 session triggers migration to cleared state (forces re-login).

---

## API Client Headers

Source: `c:\campusgate\apps\web\src\lib\api.ts`

The `api` client sends:
```
Content-Type: application/json
Authorization: Bearer <token>          // from useAuthStore.getState().token
```

There is **no built-in `x-step-up` header mechanism** in `lib/api.ts`. The `api.post/get/put/delete` helpers accept a plain `options: RequestInit` override so the step-up header must be injected by the caller via:
```typescript
request(endpoint, { headers: { "x-step-up": stepUpJwt } })
```
or by using `fetch` directly with the same pattern as `apiPatch` in `fees/hooks.ts`.

Auto-logout on 401 is implemented: `useAuthStore.getState().logout()` is called when the response status is 401.

The `api` object exposes: `api.get`, `api.post`, `api.put`, `api.delete`. There is no `api.patch` — the `fees/hooks.ts` pattern defines a local `apiPatch` helper that replicates the same `Bearer` + `ApiError` semantics.

---

## F0 Pattern (NavItem, Hooks Pattern)

### NavItem shape (AppShell.tsx)

Source: `c:\campusgate\apps\web\src\components\shell\AppShell.tsx`

```typescript
import type { ModuleKey, PermissionKey } from "@campusgate/shared";
import type { LucideIcon } from "lucide-react";

interface NavItem {
  href:    string;
  label:   string;
  icon:    LucideIcon;
  anyOf:   PermissionKey[];   // at least one must be in user's permissions
  module?: ModuleKey;         // optional — if present, item is hidden when module is inactive
}
```

Visibility logic in `useNavItemVisible(item, perms)`:
1. `canAny(item.anyOf, perms)` — if none of the permissions match → hidden
2. `item.module && useModuleActive(item.module) === "inactive"` → hidden
3. Otherwise visible

`useModuleActive` is imported from `@/features/modules/useModuleActive`. It accepts a `ModuleKey` and returns `"active" | "inactive" | "unknown"`. The hook is called unconditionally (with a fallback of `"fees"` when `item.module` is undefined, to satisfy React hook rules).

Existing NAV entries use `module: "fees"`, `module: "attendance"` (module-gated), and no `module` field for foundational routes (academics, students, classes).

To add the examinations nav item, the pattern is:
```typescript
{
  href:   "/examinations",
  label:  "Examinations",
  icon:   <SomeLucideIcon>,
  anyOf:  ["exams.manage", "exams.results.view", "exams.results.view_own"],
  module: "examinations",
}
```

---

### Query Keys Pattern (fees/keys.ts)

```typescript
export const feesKeys = {
  structures:     ()          => ["fees", "structures"] as const,
  structure:      (id)        => ["fees", "structure", id] as const,
  components:     (id)        => ["fees", "structure", id, "components"] as const,
  ledger:         (sid)       => ["fees", "ledger", sid] as const,
  payments:       ()          => ["fees", "payments"] as const,
  receipts:       ()          => ["fees", "receipts"] as const,
  reconciliation: (q)         => ["fees", "reconciliation", q] as const,
  meCharges:      ()          => ["fees", "me", "charges"] as const,
  meReceipts:     ()          => ["fees", "me", "receipts"] as const,
  meOutstanding:  ()          => ["fees", "me", "outstanding"] as const,
} as const;
```

Pattern: `["<domain>", "<resource>", ...params]`.

---

### TypeScript Types Pattern (fees/hooks.ts — no separate types.ts file)

The fees feature co-locates types in `hooks.ts` (there is no separate `types.ts` in the fees feature directory). Types mirror API response shapes exactly:
- Interface per entity (e.g. `FeeStructure`, `Charge`, `Ledger`)
- `amountPaise` is always `string` (integer paise as decimal string, mirrors PaiseAmount)
- Dates are always `string` (ISO strings from the API)
- Nullable fields typed as `T | null`

---

### React Query Hooks Pattern (fees/hooks.ts)

**Query hooks** (`useQuery`):
```typescript
export function useStructures() {
  return useQuery<{ structures: FeeStructure[] }>({
    queryKey: feesKeys.structures(),
    queryFn:  () => api.get("/api/fees/structures"),
    enabled:  can("fees.view", currentPermissions()),  // permission guard
  });
}
```
- `enabled` gated by `can("<permission>", currentPermissions())` (reads store imperatively)
- `queryKey` from the keys factory
- `queryFn` calls `api.get(...)` or `api.post(...)` or the local `apiPatch`

**Mutation hooks** (`useMutation`):
```typescript
export function useCreateStructure() {
  const qc = useQueryClient();
  return useMutation<FeeStructure, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/fees/structures", body),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: feesKeys.structures() }); },
    onError:    toastError,  // non-blocking toast of the server message
  });
}
```
- Error type is always `ApiError`
- `onSuccess` invalidates relevant query keys
- `onError` calls `toastError` (shows a Sonner toast with the server error message)

**Step-up-gated mutations**: there is no existing step-up mutation example in the fees feature (fees.refund / fees.adjust are forward-declared but not yet implemented). The step-up header (`x-step-up`) would need to be passed via a custom fetch call or by wrapping `api.post` with additional headers, since the `api` client does not expose a header-injection mechanism natively. The `apiPatch` local pattern in `fees/hooks.ts` shows how to replicate the auth semantics in a custom fetch when needed.

---

## Summary

- **Endpoints recorded**: 35
- **MFA step-up**: The `requireStepUp("exams.results.publish")` middleware reads the `x-step-up` request header. A missing/expired/wrong-action token returns **401** `{ error: "Step-up required" }`. The token is a short-lived JWT (5 min) with claims `{ userId, jti, stepUp: true, action: "exams.results.publish" }`, obtained from `POST /api/auth/mfa/verify` after a fresh TOTP assertion. There is **no stepUpToken field in the auth store**; the token must be fetched on demand and passed in the `x-step-up` header on the publish request.
- **Permission keys**: `exams.manage`, `exams.grading.manage`, `exams.candidates.manage`, `exams.marks.enter`, `exams.moderate`, `exams.results.publish`, `exams.results.view`, `exams.results.view_own`, `exams.reeval.request_own`, `exams.reeval.manage`

---

## Addendum — faculty marking reads (backend commit d1fbf02)

FACULTY holds only `exams.marks.enter`; every pre-existing GET needed to render a marks grid
requires `exams.results.view` (ADMIN/HOD only — ADMIN/HOD never hold `marks.enter`, by
separation of duties), so no role could use marks entry end to end. Two read-only endpoints were
added. Both: `requirePermission("exams.marks.enter")` + `requireModuleActive("examinations")`,
tenant-scoped, and scoped by ACTIVE FacultyAssignment exactly like `PUT /:id/marks`
(subject + term, `classSectionId` = candidate's section OR NULL/subject-wide).

### GET /api/exams/my-marking
200 `{ exams: [{ id, name, type, status: "MARKS_OPEN"|"MARKS_LOCKED"|"MODERATION", academicTermId }] }`
(max 100, newest first; `[]` if no matching assignments). 403 `{ error: "not a faculty member" }`
for a non-faculty / deactivated holder.

### GET /api/exams/:id/marks-sheet
200
```
{
  exam: { id, name, type, status, academicTermId },
  editable: boolean,                       // exam.status === "MARKS_OPEN"
  assessments: [{ id, name, subjectId, maxMarks, weight }],   // only the faculty's subjects with >=1 in-scope candidate
  rows: [{ candidateId, studentId, enrollmentNo, studentName,
           cells: [{ assessmentId, marksRecordId: string|null, marks: number|null }] }]
}
```
A row's `cells` lists ONLY the assessments that candidate is in scope for; a missing
(candidate, assessment) pair is NOT writable (PUT would 403). No in-scope pairs -> 200 with
`assessments: []`, `rows: []`. Errors: 404 `examination not found` (also another tenant's exam),
403 `not a faculty member`.

### UI semantics
There is no separate "submit" step for marks: they stay editable until staff move the exam to
MARKS_LOCKED. The marks page therefore offers **Save** and **Save & close** (same PUT).
