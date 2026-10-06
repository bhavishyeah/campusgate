# CAMPUSGATE — Comprehensive Audit Report
**Date:** 2026-10-06  
**Scope:** Full codebase scan of `c:\campusgate` (uncommitted changes)  
**Auditor:** Planning Agent (read-only investigation)

---

## EXECUTIVE SUMMARY

The CAMPUSGATE project is substantially built. The core multi-tenant architecture, gate pass lifecycle, allowance engine, reliability engine, analytics, emergency alerts, guard shifts, academic calendar, and notification system are all present and well-structured. The major gaps are:

1. **No Super Admin UI beyond a minimal platform dashboard** — institution creation is backend-only (no UI form for creating institutions from the platform page).
2. **Session & Device Security** — completely absent. No session table, no device tracking, no security event log.
3. **Printable/shareable digital movement receipt** — the summary data exists in the API, but there is no dedicated printable page or PDF export.
4. **Platform dashboard is minimal** — read-only stats + institution list. No inline institution creation form, no suspend/resume UI from the frontend.
5. **TypeScript compiles cleanly** — no errors in either `apps/api` or `apps/web`.

---

## DETAILED FINDINGS

### 1. Multi-tenancy / Super Admin Architecture

**Status: EXISTS (partially — backend complete, frontend minimal)**

**Evidence:**
- `packages/db/prisma/schema.prisma` — `Role` enum includes `SUPER_ADMIN`. `Institution` model with `InstitutionStatus` (ACTIVE/SUSPENDED) is defined.
- `apps/api/src/routes/platform.ts` — `platformRoutes` with `requireSuperAdmin()` guard. Endpoints: `GET /platform/stats`, `GET /platform/institutions`, `POST /platform/institutions`, `PUT /platform/institutions/:id/status`.
- `apps/api/src/middleware/auth.ts` — `requireSuperAdmin()` and `requireTenantRole()` properly block cross-role access. SUPER_ADMIN is explicitly blocked from tenant endpoints (line 79–82).
- `apps/web/src/app/platform/layout.tsx` — Platform layout verifies `user.role === "SUPER_ADMIN"` before rendering; redirects to `/login` otherwise.
- `apps/web/src/app/platform/page.tsx` — Minimal dashboard: shows institution count, user count, movement stats, and a read-only institution table.
- `packages/db/seed-neon.ts` — Seeds `user_superadmin` with role `SUPER_ADMIN` linked to a `inst_platform` institution.

**What is MISSING:**
- No **institution creation form** in the platform UI. The `POST /platform/institutions` endpoint exists but no frontend form calls it.
- No **suspend/resume institution** button in the platform UI. The `PUT /platform/institutions/:id/status` endpoint exists but is not wired up.
- No **institution-level drill-down** in the platform dashboard (click an institution to see its stats).
- No platform-level audit log UI.

**Recommendation:** Add an institution creation modal and status-toggle button to `apps/web/src/app/platform/page.tsx`. These are ~50 lines of UI against already-complete endpoints.

---

### 2. Outside-Time Allowance (AllowanceEngine)

**Status: EXISTS — COMPLETE**

**Evidence:**
- `apps/api/src/services/allowance-engine.ts` — Fully implemented. Covers:
  - Policy creation/retrieval with defaults.
  - Period bounds for DAILY/WEEKLY/MONTHLY/SEMESTER.
  - Week-start-day-aware weekly bounds.
  - Academic calendar integration (working/non-working day detection).
  - `getRemainingAllowance()` computing consumed time from gate events.
  - Real-time elapsed tracking for OUTSIDE passes.
  - `getEnforcementDecision()` returning allow/block/warn.
- `apps/api/src/routes/student.ts` — `GET /api/student/allowance` endpoint returns `AllowanceSummary`.
- `apps/web/src/app/student/page.tsx` — Student dashboard renders allowance widget with remaining time, consumed time, period dates, and a real-time elapsed counter when outside.
- `apps/web/src/app/admin/page.tsx` — Admin dashboard has full allowance policy editor (amount, period, grace period, enforcement mode, severity thresholds).
- DB models `AllowancePolicy` and `InstitutionConfig` are present in schema.

**No known gaps.**

---

### 3. GatePass Reliability Score (ReliabilityEngine)

**Status: EXISTS — COMPLETE**

**Evidence:**
- `apps/api/src/services/reliability-engine.ts` — Fully implemented:
  - `classifySeverity()` with MINOR/MODERATE/SIGNIFICANT/SEVERE buckets.
  - `computeTimelyReturnRate()` with weighted severity deductions.
  - `computeCompletionRate()` from terminal-status passes.
  - `computeComplianceRate()` (currently always 1.0 — noted TODO for violation tracking).
  - `filterMovementsForScoring()` excluding emergency override passes.
  - `computeScore()` with 0.6/0.2/0.2 weighted formula.
  - `recordSnapshot()` and `getScoreTrend()` for historical tracking.
- `apps/api/src/routes/guard.ts` — `mark-return` fires async snapshot recording after a pass completes.
- `apps/api/src/routes/student.ts` — `GET /api/student/reliability` endpoint.
- `apps/api/src/routes/hod.ts` — `GET /api/hod/requests/:passId/reliability` endpoint; reliability score embedded in `GET /api/hod/requests/:passId`.
- `apps/web/src/app/hod/page.tsx` — HOD dashboard renders reliability score per request.

**Minor gap:** `hasViolation` is hardcoded to `false` (authorization compliance rate always 1.0). This is noted with a TODO comment in the code. Not a blocker.

---

### 4. Campus Movement Analytics

**Status: EXISTS — COMPLETE**

**Evidence:**
- `apps/api/src/routes/admin.ts` — `GET /api/admin/analytics` with date range filtering. Returns:
  - Overview stats (total/approved/rejected/revoked/completed, currently outside, overdue, avg outside minutes).
  - Department-wise breakdown with avg outside duration.
  - Reason distribution with percentages.
  - Gate-wise exit/return counts.
  - Hourly exit distribution (all 24 hours).
  - Daily trend (requests/exits/returns per day).
  - Emergency overview (declared/resolved, avg resolution, active alert).
  - Emergency by type and daily emergency trend.
- `apps/web/src/app/admin/analytics/page.tsx` — Full analytics UI with all sections rendered. Date range picker, bar charts (custom CSS-based), tables.

**No gaps.**

---

### 5. Notification System

**Status: EXISTS — COMPLETE**

**Evidence:**
- `apps/api/src/services/notifications.ts` — `notifyUser()`, `notifyInstitutionAdmins()`, `notifyDepartmentHods()`. Persists to DB and pushes via WebSocket.
- `apps/api/src/routes/notifications.ts` — `GET /api/notifications`, `GET /api/notifications/unread-count`, `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`.
- `apps/web/src/components/NotificationBell.tsx` — Full dropdown UI with unread count badge, live WebSocket updates, mark-individual/mark-all-read, relative timestamps, type-based color accents.

**Notification types currently fired:**
- `NEW_REQUEST` — when student requests a pass (to HODs).
- `PASS_APPROVED` — when HOD approves (to student).
- `PASS_REJECTED` — when HOD rejects (to student).
- `REGISTRATION_PENDING` — when student self-registers (to admins).

**Missing notification types:**
- `PASS_REVOKED` — no notification to student when admin/HOD revokes.
- `PASS_EXPIRED` — no notification when a pass expires.
- `EMERGENCY_DECLARED` / `EMERGENCY_RESOLVED` — no push notification to all institution users when an emergency is declared or resolved. Students currently only see emergency alerts by polling `GET /api/student/emergency/active` on dashboard load.
- `OVERDUE` — no notification when a student is overdue.

**Recommendation:** Add `notifyUser()` calls in the revoke endpoints, and add a broadcast function to notify all institution users on emergency declaration/resolution.

---

### 6. Emergency Alert System

**Status: EXISTS — PARTIAL**

**Evidence:**
- `packages/db/prisma/schema.prisma` — `EmergencyAlert` model with type (FIRE/EARTHQUAKE/MEDICAL/SECURITY/EVACUATION/OTHER), status (ACTIVE/RESOLVED), title, message, affectedArea, declaredBy/resolvedBy.
- `apps/api/src/routes/admin.ts` — `GET /emergency/active`, `GET /emergency`, `POST /emergency/declare`, `POST /emergency/:id/resolve`.
- `apps/web/src/app/admin/emergency/page.tsx` — Full declare/resolve UI with history list.
- `apps/web/src/app/student/page.tsx` — Student dashboard polls `GET /api/student/emergency/active` and renders an emergency banner.
- `apps/api/src/routes/student.ts`, `guard.ts`, `hod.ts` — All expose `GET /emergency/active` endpoint.

**What is MISSING:**
- **No real-time broadcast to all connected users** when an emergency is declared. Students/guards only see it when they load/refresh their dashboard. No WebSocket push on emergency declaration.
- Guard and HOD pages have the emergency endpoint available but no visible emergency banner in their layouts.

---

### 7. Pass Revocation

**Status: EXISTS — COMPLETE**

**Evidence:**
- `apps/api/src/routes/admin.ts` — `POST /api/admin/passes/:passId/revoke` — requires reason ≥ 3 chars, transitions APPROVED/ACTIVE/OUTSIDE → REVOKED, optimistic locking via `updateMany`.
- `apps/api/src/routes/hod.ts` — `POST /api/hod/revoke` — same logic, scoped to HOD's department.
- `PassStatus.REVOKED` in schema.
- `PASS_REVOKED` action in `AuditLog`.

**Minor gap:** No notification to the student when their pass is revoked (mentioned in item 5 above).

---

### 8. Digital Movement Summary / Printable Receipt

**Status: PARTIAL — API exists, no print/export UI**

**Evidence:**
- `apps/api/src/routes/student.ts` — `GET /api/student/gate-pass/:passId/summary` returns structured movement summary (student info, reason, approval, actual exit/return, duration, gate names).
- `apps/api/src/routes/hod.ts` — `GET /api/hod/requests/:passId/summary` — same.
- `apps/api/src/services/pass-lifecycle.ts` — `computeOutsideDurationMinutes()` helper.
- `apps/web/src/app/student/history/page.tsx` — Summary is shown in an expandable inline panel within the history list.

**What is MISSING:**
- No dedicated `/student/pass/[passId]/receipt` page or print-friendly layout.
- No PDF export or browser print button.
- The summary data is inline within the history accordion, not a standalone page or printable document.

---

### 9. Pass Timeline

**Status: EXISTS — COMPLETE**

**Evidence:**
- `apps/api/src/services/pass-lifecycle.ts` — `buildPassTimeline()` constructs chronological events: REQUEST_CREATED, APPROVED, EXIT_RECORDED, RETURN_RECORDED, REJECTED, CANCELLED, REVOKED, EXPIRED, COMPLETED. Sources from both GateEvent timestamps and AuditLog records.
- `apps/api/src/routes/student.ts` — `GET /api/student/gate-pass/:passId/timeline`.
- `apps/api/src/routes/hod.ts` — `GET /api/hod/requests/:passId/timeline`.
- `apps/web/src/app/student/history/page.tsx` — Timeline rendered in expandable accordion alongside summary.
- `apps/web/src/app/hod/history/page.tsx` — Same pattern.

**No gaps.**

---

### 10. Gate Health Monitoring

**Status: EXISTS — COMPLETE**

**Evidence:**
- `apps/api/src/routes/admin.ts` — `GET /api/admin/gates/health` and `GET /api/admin/gates/:gateId/health`. Returns OPERATIONAL/WARNING/OFFLINE/CLOSED status based on last activity timestamp (OPERATIONAL <30min, WARNING 30–120min, OFFLINE >120min, CLOSED if inactive). Includes todayExits, todayReturns, recent events, assigned guards.
- `apps/web/src/app/admin/gates/page.tsx` — Full gate health UI with list of gates with status badges, detail panel with recent events and guard assignments.

**No gaps.**

---

### 11. Guard Shift Management

**Status: EXISTS — COMPLETE**

**Evidence:**
- `packages/db/prisma/schema.prisma` — `GuardShift` model with status (SCHEDULED/ACTIVE/COMPLETED/CANCELLED), `scheduledStartAt/End`, `actualStartAt/End`, overlap detection index.
- `apps/api/src/routes/admin.ts` — `GET /api/admin/guard-shifts`, `POST /api/admin/guard-shifts` (overlap check, gate assignment validation).
- `apps/api/src/routes/guard.ts` — `GET /shift/current`, `POST /shift/start` (with 30-min early window), `POST /shift/end`. Guards must have an ACTIVE shift on the correct gate to record exits/returns.
- `apps/web/src/app/admin/shifts/page.tsx` — Full shift scheduling UI.
- `apps/web/src/app/guard/page.tsx` — Guard dashboard shows current/next shift and shift start/end buttons.

**No gaps.**

---

### 12. Institution Configuration UI

**Status: EXISTS — MOSTLY COMPLETE**

**Evidence:**
- `apps/web/src/app/admin/page.tsx` — Admin dashboard includes:
  - **Outside-Time Policy** editor: allowanceAmount, policyPeriod, gracePeriod, enforcement mode, minimumSampleSize, severity thresholds.
  - **Institution Configuration** editor: timezone, weekStartDay, workingDaysOfWeek (checkbox), lowAllowanceThresholdMinutes.
  - **Academic Calendar** editor: upsert/delete calendar day overrides with day type and note.
- `apps/api/src/routes/admin.ts` — All corresponding endpoints present: `GET/PUT /allowance-policy`, `GET/PUT /institution-config`, `GET/PUT/DELETE /academic-calendar`.

**What is MISSING:**
- No institution **branding/name/domain** edit UI (name, code, domain are set at institution creation and not editable from the admin UI).
- No **exit reasons management** from a dedicated settings page — reasons management is in `apps/web/src/app/admin/reasons/page.tsx` (exists).

Overall institution config is well covered.

---

### 13. Academic Calendar

**Status: EXISTS — COMPLETE**

**Evidence:**
- `packages/db/prisma/schema.prisma` — `AcademicCalendarDay` model with `AcademicDayType` enum (WORKING_DAY, HOLIDAY, WEEKEND, EXAM_DAY, VACATION, SPECIAL_WORKING_DAY, INSTITUTION_EVENT).
- `apps/api/src/routes/admin.ts` — `GET /academic-calendar`, `PUT /academic-calendar/day`, `DELETE /academic-calendar/day/:date`.
- `apps/api/src/services/allowance-engine.ts` — Calendar days are queried and integrated into allowance calculation (working day filtering).
- `apps/web/src/app/admin/page.tsx` — Monthly calendar editor with month navigation.

**No gaps.**

---

### 14. Session & Device Security

**Status: MISSING**

**Evidence:**
- `packages/db/prisma/schema.prisma` — No `Session`, `DeviceToken`, `SecurityEvent`, or similar model.
- `apps/api/src/routes/auth.ts` — `lastLoginAt` is updated on login (single field, no device/IP tracking).
- No session revocation endpoint. No device list. No security event logging (separate from audit logs).

**What is MISSING:**
- Session table (token issuance, expiry, revocation).
- Device/browser fingerprinting.
- Concurrent session detection and limits.
- Security event logging (failed logins, suspicious activity).
- "Sign out all devices" feature.

**Recommendation:** Add a `Session` model to the schema and a `POST /auth/logout` that marks the session as revoked. JWT-based apps can implement this with a revocation list or session table. This is the largest missing security feature.

---

### 15. CSV Import

**Status: EXISTS — COMPLETE AND WORKING**

**Evidence:**
- `apps/web/src/app/admin/import/page.tsx` — Full 5-step wizard:
  1. Upload (drag-and-drop or file picker, validates .csv, max 5MB).
  2. Column mapping with auto-detection and required-field validation.
  3. Course code resolution with inline course creation.
  4. Editable preview table (click-to-edit any cell).
  5. Result screen with created/skipped/errors.
- `apps/api/src/routes/admin.ts` — `POST /api/admin/students/bulk-import` — validates each row with `bulkImportStudentSchema`, resolves department by code, skips duplicates, max 500 rows.
- Error reporting: row-level error messages bubbled to UI.
- Export also available: `GET /api/admin/students/export` (CSV) and `GET /api/admin/students/export.xlsx` (Excel with ExcelJS).

**No gaps.**

---

### 16. seed-neon.ts — updatedAt fields

**Status: FIXED — ALL `updatedAt` FIELDS PRESENT**

**Evidence:**  
`packages/db/seed-neon.ts` — Every INSERT statement includes `"updatedAt"` with `NOW()`:
- `institutions` table: `"updatedAt"` in both the platform institution insert and demo institution insert.
- `departments` table: `"updatedAt"` present.
- `gates` table: `"updatedAt"` present.
- `exit_reasons` table: `"updatedAt"` present.
- `users` table: `"updatedAt"` present in all user inserts.
- `hod_profiles` table: `"updatedAt"` present.
- `guard_profiles` table: `"updatedAt"` present.
- `student_profiles` table: `"updatedAt"` present.

The `guard_gate_assignments` table correctly omits `updatedAt` (it has no such column in the schema).

**No issues.**

---

### 17. TypeScript Errors

**Status: CLEAN — No errors in either app**

**Evidence:**  
Running `npx tsc --noEmit` in both `apps/api` and `apps/web` produced no output (exit code 0). Both projects compile cleanly.

---

### 18. Prisma Schema Completeness

**Status: COMPLETE against roadmap**

The schema contains all required models:
| Model | Status |
|---|---|
| `Institution` | ✅ with `InstitutionStatus` enum |
| `Department` | ✅ |
| `User` | ✅ with `Role` (including SUPER_ADMIN), `AccountStatus`, `lastLoginAt` |
| `StudentProfile` | ✅ with rollNumber, dob, phone, address |
| `HodProfile` | ✅ |
| `GuardProfile` | ✅ |
| `Gate` | ✅ |
| `GuardGateAssignment` | ✅ |
| `ExitReason` | ✅ |
| `GatePass` | ✅ with REVOKED status, allowanceWarning |
| `GateEvent` | ✅ |
| `GuardShift` | ✅ with full lifecycle |
| `AuditLog` | ✅ with comprehensive `AuditAction` enum |
| `Notification` | ✅ |
| `AllowancePolicy` | ✅ |
| `InstitutionConfig` | ✅ |
| `AcademicCalendarDay` | ✅ |
| `EmergencyOverride` | ✅ |
| `EmergencyAlert` | ✅ |
| `ReliabilityScoreSnapshot` | ✅ |
| `Session` / `DeviceToken` | ❌ MISSING |

**One notable absence:** `Session` / `DeviceToken` model (matches finding #14).

The `AuditAction` enum covers 24 actions including SHIFT_CREATED/STARTED/ENDED, EMERGENCY_DECLARED/RESOLVED, and INSTITUTION_CONFIG_UPDATED — very complete.

---

### 19. packages/db/add-columns.ts

**Status: EXISTS — CORRECT AND COMPLETE**

**Evidence:**  
`packages/db/add-columns.ts` — Adds exactly the four columns that Prisma schema defines on `student_profiles` but that may have been missing from an earlier Neon migration:
```sql
ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "rollNumber" TEXT;
ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "dob" TEXT;
ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "address" TEXT;
```
Uses `ADD COLUMN IF NOT EXISTS` (idempotent). Connects with SSL for Neon. Correct.

---

### 20. SUPER_ADMIN Role — Codebase Coverage

**Status: EXISTS and ENFORCED**

| Location | Reference |
|---|---|
| `packages/db/prisma/schema.prisma` | `Role` enum line 14 |
| `packages/shared/src/constants.ts` | `ROLES` array |
| `apps/api/src/middleware/auth.ts` | `requireSuperAdmin()`, SUPER_ADMIN blocked from tenant routes |
| `apps/api/src/routes/platform.ts` | All routes use `requireSuperAdmin()` |
| `apps/web/src/app/platform/layout.tsx` | Guards redirect if `role !== "SUPER_ADMIN"` |
| `apps/web/src/stores/auth.ts` | Type includes `"SUPER_ADMIN"` |
| `packages/db/seed-neon.ts` | Seeds `superadmin@campusgate.local` with `SUPER_ADMIN` role |
| `packages/db/src/seed.ts` | Same seed logic for local dev |
| `apps/api/src/routes/__tests__/tenant-boundary.integration.test.ts` | Test: SUPER_ADMIN is blocked from tenant endpoints |

The role is end-to-end wired correctly.

---

## SUMMARY TABLE

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | Multi-tenancy / Super Admin | PARTIAL | Backend complete; platform UI needs create/suspend institution forms |
| 2 | Outside-Time Allowance | EXISTS | Complete including academic calendar integration |
| 3 | GatePass Reliability Score | EXISTS | Complete; violation tracking hardcoded to 0 (noted TODO) |
| 4 | Campus Movement Analytics | EXISTS | Comprehensive analytics endpoint and full UI |
| 5 | Notification System | PARTIAL | Core system complete; missing REVOKED/EXPIRED/EMERGENCY_DECLARED notifications |
| 6 | Emergency Alert System | PARTIAL | Admin declare/resolve and student banner exist; no real-time broadcast |
| 7 | Pass Revocation | EXISTS | Complete in both admin and HOD routes |
| 8 | Digital Movement Summary | PARTIAL | API complete; no dedicated print page or PDF export |
| 9 | Pass Timeline | EXISTS | Complete with timeline endpoint and inline UI |
| 10 | Gate Health Monitoring | EXISTS | Complete with OPERATIONAL/WARNING/OFFLINE/CLOSED logic |
| 11 | Guard Shift Management | EXISTS | Complete with start/end flow and overlap detection |
| 12 | Institution Configuration UI | EXISTS | Complete (policy, institution config, calendar) |
| 13 | Academic Calendar | EXISTS | Complete including allowance engine integration |
| 14 | Session & Device Security | MISSING | No session model, no device tracking, no session revocation |
| 15 | CSV Import | EXISTS | Complete 5-step wizard with course resolution and editable preview |
| 16 | seed-neon.ts updatedAt | FIXED | All tables have updatedAt NOW() |
| 17 | TypeScript errors | CLEAN | Both apps compile with 0 errors |
| 18 | Prisma schema completeness | EXISTS | All models present except Session/DeviceToken |
| 19 | add-columns.ts | EXISTS | Correct and idempotent |
| 20 | SUPER_ADMIN role | EXISTS | Fully wired across schema, middleware, routes, and UI |

---

## PRIORITY RECOMMENDATIONS

### P1 — High Impact, Low Effort
1. **Platform UI: Add institution creation form** (`apps/web/src/app/platform/page.tsx`) — The `POST /platform/institutions` endpoint is ready; just need a form modal.
2. **Platform UI: Add suspend/activate institution button** — `PUT /platform/institutions/:id/status` endpoint exists; just needs a button per row.
3. **Notifications for REVOKED, EXPIRED, EMERGENCY_DECLARED** — Add `notifyUser()` calls in 3 existing places.

### P2 — Security
4. **Session model + revocation** — Add `Session` table, update `POST /auth/login` to create a session record, add `POST /auth/logout` to revoke it, add session check in `authenticate` middleware. Critical for production.

### P3 — UX Completeness
5. **Printable receipt page** — Add `/student/pass/[passId]/receipt` using existing summary API. Add `window.print()` button.
6. **Emergency broadcast via WebSocket** — In `POST /emergency/declare`, push a message to all connected users in the institution.

### P4 — Minor
7. **Authorization compliance rate** — Currently hardcoded to 1.0. Add a `hasViolation` flag to `GatePass` or derive it from an existing signal to make reliability scoring more accurate.
