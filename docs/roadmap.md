# CAMPASS Implementation Roadmap (Phases 0–10)

> Owning doc for decision **D8 (incremental, dependency-ordered, tested rollout)**. Each
> phase is self-contained enough to start a focused build session from. Phases cross-link
> to [`architecture.md`](./architecture.md), [`tenancy.md`](./tenancy.md),
> [`identity-rbac.md`](./identity-rbac.md),
> [`superadmin-security.md`](./superadmin-security.md), and
> [`database.md`](./database.md).

---

## Build strategy decision (2026-10-xx): BACKEND-FIRST (Option A)

**Decision:** complete the backend architecture across all phases FIRST; the frontend
(`apps/web`) is built as a single dedicated pass AFTER the backend roadmap is complete.
Rationale: finish the coherent architecture against which a stable UI can later be built
with minimal rework.

**Consequence (tracked deliberately, not drifting):** as of this decision, `apps/web`
only covers the original **Phase 0 GatePass** UI (admin/hod/guard/student/platform gate
flows + institution management + MFA enrollment). **Phases 1, 2, 3 have NO frontend** —
their APIs are fully built, tested, and live, but no screens exist. Each new backend
phase's "Definition of Done (demoable)" is satisfied at the **API + test + DB-verification**
level during backend-first; the user-facing demo is deferred to the frontend pass.

**Deferred frontend scope (the eventual UI pass must cover):**
- Phase 1 — academic sessions/terms, programs, calendar management screens
- Phase 2 — SIS: student records, enrollment, promotion, transfer, search, self-service
- Phase 3 — courses/subjects/sections, faculty, class enrollment, timetable + conflict UI
- Phase 4 — attendance UI: faculty marking screen (open session → load enrolled students →
  mark present/absent/late/excused → submit → finalize), correction request/review
  (faculty request with reason, HOD/ADMIN approve/reject), student attendance view
  (own records + rate), department reports + export
- Phase 7 (slice 1) — fees UI (Option A, backend only; `apps/web` fees screens deferred):
  accountant fee-structure/component management, charge posting (single + bulk), the
  per-student ledger (charges + allocations + computed outstanding), payments/receipts
  lists, and reconciliation; the STUDENT self-service screens (own charges/outstanding/
  receipts + the Razorpay checkout that calls `POST /api/fees/payments` then the
  checkout-callback `POST /api/fees/payments/verify`). The webhook is server-only (no UI).
- Phase 5+ — each phase adds to this list as it ships backend-only

Keep this list current as phases land so the frontend pass has an exact scope.

---

## How to read a phase

Every phase lists: **Objective · Dependencies · Scope · Schema additions · Security &
tenancy notes · Tests · Definition of Done (demoable)**.

**Non-negotiables apply to every phase** (full list in
[`README.md`](./README.md#non-negotiables-apply-to-every-phase-and-every-module)):
backend-enforced authz, two-layer tenant isolation (scoped client + RLS), transactional
+ idempotent critical ops, audit on important actions, preserve history over hard
delete, module activation enforced server-side.

**The single-identity rule** (repeated because it is the most common ERP mistake): there
is **one** authoritative `Student` and **one** `Institution` identity, created in the
foundation and reused by every later module. No module (attendance, library, fees, exams)
creates its own copy of a student or institution — it references the shared identity and
keeps only its own domain records. See
[`identity-rbac.md`](./identity-rbac.md) and [`architecture.md`](./architecture.md).

**Dependency overview:**

```text
Phase 0  Foundation ───────────────────────────────────────────────┐
   │                                                                 │ (everything
   ▼                                                                 │  depends on
Phase 1  Shared institutional data (sessions, programs, calendar)    │  the foundation)
   │                                                                 │
   ▼                                                                 │
Phase 2  Student Information System ◄── authoritative student        │
   │                                                                 │
   ├──────────────► Phase 5  Library            (needs shared identity)
   │                                                                 │
   ▼                                                                 │
Phase 3  Class & Course ──► Phase 4  Attendance (needs 2 + 3)         │
   │                                                                 │
   ▼                                                                 │
Phase 6  Admissions ──► feeds Phase 2 (no duplicate identities)      │
   │                                                                 │
   ▼                                                                 │
Phase 7  Fees (needs 2) ─► Phase 8  Examinations (needs 1,2,3)       │
   │                                                                 │
   ▼                                                                 │
Phase 9  Institutional ops   Phase 10  Advanced ERP ─────────────────┘
```

Phases can overlap where dependencies allow, but foundational dependencies must be
respected.

---

## Phase 0 — Foundation hardening & future-proofing

> The most important phase. Everything else inherits it. No new user-facing module —
> this hardens the existing GatePass app into the platform foundation.

**Objective.** Make the existing GatePass application run on the future ERP architecture:
real two-layer tenant isolation, a membership/role/permission identity model, a Super
Admin with zero standing tenant access plus audited break-glass, generic audit, versioned
migrations on Supabase, and an explicit module system — all proven by a cross-tenant
escape test suite.

**Dependencies.** None (it is the base).

**Scope.**
1. **Database move & migrations** ([`database.md`](./database.md)): Neon → Supabase;
   pooled + direct connection strategy; replace `db push --accept-data-loss` with
   versioned Prisma migrations; dedicated non-`BYPASSRLS` app role.
2. **Tenancy A2** ([`tenancy.md`](./tenancy.md)): add `institutionId` + backfill on all
   tenant-owned tables missing it; `(id, institutionId)` composite uniques; composite FKs
   for same-tenant links; `ENABLE`+`FORCE` RLS + standard policies; tenant-scoped Prisma
   client + request middleware that sets `app.current_institution_id` from the verified
   token.
3. **Identity/RBAC B2** ([`identity-rbac.md`](./identity-rbac.md)):
   `InstitutionMembership`, `Role`, `Permission`, join tables; JWT gains
   `membershipId` + resolved `roles`/`permissions`; central authz engine
   (`requirePermission`, `requireModuleActive`, `canOnResource`); compatibility shim so
   existing `requireRole` guards keep working during migration.
4. **Super Admin & security C** ([`superadmin-security.md`](./superadmin-security.md)):
   platform-vs-tenant permission split; `SupportGrant` break-glass; MFA for platform
   accounts + step-up for high-risk actions; AuditLog v2 (generic string action,
   tenant-scoped, `supportGrantId`).
5. **Module system** ([`architecture.md`](./architecture.md) §5):
   entitlement + activation + dependency tables and guards; model Campus Movement as the
   first registered module.
6. **Migrate GatePass onto all of the above** — the proving ground. Every GatePass route
   moves to the tenant-scoped client + permission guards; its actions write AuditLog v2.
7. **Cross-tenant escape test suite** ([`tenancy.md`](./tenancy.md) §7) in CI.

**Schema additions.** See [`database.md`](./database.md) §5 (tenancy columns/FKs/RLS;
membership/role/permission; `SupportGrant`; `AuditEvent`; `ModuleEntitlement`/
`ModuleActivation`).

**Security & tenancy notes.** This phase *is* the security foundation. The headline
guarantee: a deliberately buggy query that forgets the tenant filter still returns only
the caller's tenant because RLS is forced at the DB.

**Tests.**
- Full cross-tenant escape suite (read/write escape, spoofed tenant, deliberately-buggy
  query, fail-closed on missing context, report scope, break-glass scope).
- Auth regression: login, session revocation, suspended-institution block still work.
- GatePass end-to-end regression on the new foundation.
- MFA + step-up on a high-risk action (e.g. pass revoke / support grant).
- Meta-test: every tenant-owned table has RLS + policies.

**Definition of Done (demoable).**
- Two institutions run simultaneously with **zero** cross-tenant access, proven by the
  escape suite including the deliberately-buggy-query test passing against RLS.
- A Super Admin has no standing tenant-data access; a `SupportGrant` grants scoped,
  time-limited, audited, revocable access to **one** institution, visible to that
  institution.
- GatePass fully migrated to permissions + tenant-scoped client + AuditLog v2.
- Deploy uses versioned migrations on Supabase; `db push --accept-data-loss` removed.
- All tests green in CI.

---

## Phase 1 — Shared institutional data

**Objective.** A single, configurable representation of academic time and structure that
every later module reuses: academic sessions/terms, the program/department hierarchy, and
the academic calendar (generalizing the existing `AcademicCalendarDay` +
`InstitutionConfig`).

**Dependencies.** Phase 0.

**Scope.**
- Academic sessions (years) and subdivisions (semesters/terms/trimesters) — configurable,
  not hardcoded to one pattern.
- Program hierarchy (institution → department → program), building on existing
  `Department`.
- Academic calendar service: working days, holidays, exam periods, vacations, events,
  with scope (institution/department) and revision history. Exposed to modules as a
  service; modules decide what dates **mean** (the calendar does not invent rules).
- Session lifecycle: create → define terms → assign programs/classes → enroll → active →
  closure; historical sessions remain readable.

**Schema additions.** `AcademicSession`, `AcademicTerm`, `Program` (if not already
sufficient), calendar generalization + revision records. All tenant-owned (tenancy
checklist).

**Security & tenancy notes.** Promoting a student to a new term must not rewrite
historical records (attendance/grades/enrollment stay linked to the session they
occurred in). Preserve-history non-negotiable.

**Tests.** Configurable structures (semester vs annual vs trimester) work; historical
session access intact after promotion; calendar scope respects tenant + department;
cross-tenant escape tests extended to new tables.

**Definition of Done (demoable).** Two institutions with different academic structures
(e.g. semester vs annual) each configure a session, terms, programs, and a calendar;
records created in one session remain correctly linked after a promotion.

---

## Phase 2 — Student Information System (SIS)

**Objective.** The authoritative student record every academic module depends on — one
identity, never duplicated downstream.

**Dependencies.** Phase 0, Phase 1.

**Scope.**
- Student profile (generalize existing `StudentProfile`): identity, program, session,
  semester/section, enrollment status, admission date, emergency contact (only if
  collected), documents (reference), profile history.
- Student statuses (configurable to institution policy): applicant/enrolled/active/
  on-leave/graduated/withdrawn/suspended.
- Operations: create, update (permitted fields), bulk import (exists — fold into the new
  model), validate enrollment identifiers, assign program, enroll into session, promote,
  transfer, deactivate/archive, search/filter, view history, export (authorized).
- Student self-service portal: own profile + services available from active modules.

**Schema additions.** Generalized `Student`/`StudentProfile`, status + history records,
document references. Tenant-owned.

**Security & tenancy notes.** A student record is **not** duplicated inside attendance/
library/fees/gatepass — those reference the shared student and keep their own records.
Sensitive PII restricted to authorized users; exports authorized + audited.

**Tests.** No duplicate identity on re-import; permitted-field update enforcement;
self-service shows only active-module services; cross-tenant escape extended.

**Definition of Done (demoable).** A student exists once; GatePass, and later modules,
reference that single identity; a student logs into self-service and sees only what their
institution has activated and permitted.

---

## Phase 3 — Class & Course management

**Objective.** Represent what students study, who teaches it, and when classes occur.

**Dependencies.** Phase 0, 1, 2.

**Scope.** Courses/programs, subjects/units, class/section creation, student class
enrollment, faculty assignment, subject allocation, room allocation, timetable creation
with **conflict detection** (faculty overlap, room double-booking, section conflicts,
invalid periods, out-of-hours), class cancellation, substitute assignment, schedule
history (revisions, not silent overwrite).

**Schema additions.** `Course`, `Subject`, `ClassSection`, `ClassEnrollment`,
`FacultyAssignment`, `Timetable`, `ScheduledClass`. Tenant-owned; composite FKs link to
shared student/faculty/session.

**Security & tenancy notes.** Faculty assignment changes do not erase historical teaching
records. Published timetable changes create revisions.

**Tests.** Conflict detection catches each conflict type; schedule revisions preserved;
enrollment links reference shared student; cross-tenant escape extended.

**Definition of Done (demoable).** An institution builds a timetable; the system rejects a
double-booked room/faculty; a published change is recorded as a revision; students/faculty
see their schedule.

---

## Phase 4 — Attendance

**Objective.** Record attendance against actual scheduled academic activities, with a
controlled correction workflow.

**Dependencies.** Phase 0, 1, 2, **3** (attendance needs classes + timetable).

**Scope.** Class/subject/session attendance; present/absent/late/approved-leave
(configurable states); faculty attendance UI loading enrolled students from the schedule;
submission deadlines; **correction workflow** (request → reason → authorized review →
approve/reject → apply → audit); faculty history; student dashboard; department reports;
low-attendance alerts; export; audit. Future methods (QR/self-check-in/biometric) noted as
later add-ons each needing their own anti-abuse controls — **not** assumed to prove
presence.

**Schema additions.** `AttendanceSession`, `AttendanceRecord`, `AttendanceCorrection`.
Tenant-owned; composite FKs to student + scheduled class + faculty.

**Security & tenancy notes.** A faculty member marks only assigned classes
(`attendance.mark` + `canOnResource` scope); finalized records are not silently edited —
corrections are audited. Attendance ≠ gate-pass state (explicitly separate records).

**Tests.** Faculty cannot mark an unassigned class; correction requires authorized review
+ writes audit; finalized record immutable except via correction; cross-tenant escape
extended.

**Definition of Done (demoable).** Faculty marks attendance for an assigned class only; a
correction goes through review and is audited; a student sees their attendance; low
attendance triggers a notification.

---

## Phase 5 — Library

**Objective.** Manage the physical collection and its circulation, with correct
title-vs-copy modeling.

**Dependencies.** Phase 0, Phase 2 (shared student identity). Independent of 3/4.

**Scope.** Catalogue (title), **physical copies** (distinct from title), ISBN/accession/
author/publisher/category/shelf, acquisition, condition; issue/return/renew/reserve;
borrowing limits, due dates, overdue tracking, lost/damaged, fines (if configured);
student features (search, availability, loans, due dates, reservations, history,
reminders); reports.

**Schema additions.** `BookTitle`, `BookCopy`, `LibraryLoan`, `BookReservation`,
`LibraryFine`. Tenant-owned; loans composite-FK to shared student + copy.

**Security & tenancy notes.** Students see only their own borrowing history. Librarians
manage circulation but do not gain access to fees/exams/etc. **Concurrency:** two
librarians issuing the same copy — only one succeeds (unique constraint / locking).

**Tests.** Title vs copy correctly tracked; concurrent-issue race yields exactly one
success; student cannot see another's history; module disabled → routes reject;
cross-tenant escape extended.

**Definition of Done (demoable).** Two institutions run separate libraries on shared
identity; a copy's availability is accurate through issue/return; a concurrent double-issue
is prevented.

---

## Phase 6 — Admissions

**Objective.** Manage applicant → enrolled student, feeding Phase 2 **without duplicate
identities**.

**Dependencies.** Phase 0, 1, 2.

**Scope.** Admission campaigns, program selection, form builder, applicant registration,
document submission, (optional) application fee, eligibility, status tracking, review,
document verification, merit/selection lists, interview/counseling scheduling, offers,
acceptance, **enrollment confirmation → create/link the authoritative student record**,
rejection/withdrawal, applicant communication, analytics. Configurable application
lifecycle states.

**Schema additions.** `AdmissionCampaign`, `Application`, `ApplicationDocument`,
`ApplicationReview`, `AdmissionOffer`, `Enrollment`. Tenant-owned; separate from active
SIS (an applicant is not yet a student).

**Security & tenancy notes.** Applicants access only their own applications; officers only
authorized ones; decisions require permissions and are auditable. On enrollment, **link to
an existing student identity if the applicant already exists** — never create a duplicate.
Rejected applicants do not auto-become active students.

**Tests.** Applicant isolation; enroll does not duplicate an existing student; decision
changes audited; cross-tenant escape extended.

**Definition of Done (demoable).** An applicant moves through the configured process and
becomes an enrolled student with a single identity reused by downstream modules.

---

## Phase 7 — Fees & payments

**Objective.** An auditable financial ledger with safe payment processing — more care than
CRUD because it holds money.

**Dependencies.** Phase 0, Phase 2.

**Scope.** Fee categories/structures (program/session/installments/due dates),
scholarships/concessions/waivers, late-fee policy, student-specific adjustments, fee
structure **versioning**; per-student ledger (charges, payments, discounts, refunds,
balance, receipts, history); payment processing with **server-side verification**, gateway
signature verification, **idempotent webhooks**, duplicate-posting prevention, gateway
reference storage, reconciliation of pending transactions, refund/adjustment history,
restricted financial exports; reports (assessed, collected, outstanding, overdue,
scholarships, refunds, failures, reconciliation discrepancies).

**Schema additions.** `FeeStructure`, `StudentCharge`, `PaymentTransaction`,
`PaymentAllocation`, `Refund`, `FeeAdjustment`, `Receipt`. Tenant-owned; composite FKs to
shared student.

**Security & tenancy notes.** A payment attempt ≠ a confirmed payment; a receipt is issued
only after server-verified settlement. Refunds/adjustments require explicit permissions +
approval + step-up ([`superadmin-security.md`](./superadmin-security.md) §5.2). Changing a
fee structure must not rewrite posted transactions. Never store raw card data. **Two
webhooks for one transaction must not double-post** (idempotency key + unique constraint).

**Tests.** Duplicate webhook posts once; unsigned/invalid gateway callback rejected;
ledger balance reconciles with transactions; refund requires permission + step-up; fee
structure change preserves history; cross-tenant escape extended.

**Definition of Done (demoable).** Payments and adjustments are auditable; a replayed
webhook does not double-charge; ledger balances reconcile; refunds are permissioned and
stepped-up.

**Slice 1 — SHIPPED (backend only, Option A).** The money-critical core landed:
`FeeStructure` + `FeeComponent`, the immutable-snapshot `StudentCharge` ledger (all money
INTEGER PAISE / `BIGINT`, currency `INR`, crossing every JSON boundary as a decimal string),
the Razorpay (INR) payment spine where the **webhook is the sole authoritative, idempotent
writer** of `CAPTURED`/allocations/receipt (idempotency by DB construction — a global unique
event id + a partial unique payment id + a one-receipt-per-transaction unique), server-side
signature verification (checkout payment signature + webhook HMAC via Node `crypto`),
oldest-due-first allocation, receipts issued only post-capture, computed outstanding, and a
reconciliation path. `fees` is a gated module (`requireModuleActive("fees")` on every
operational route; the webhook is signature-gated only). New `fees.*` permissions + an
additive fees-scoped `ACCOUNTANT` template role; `STUDENT` gets `fees.view_own`. The frontend
is deferred (see the deferred-frontend scope list above).

**Slice 7.1 — SHIPPED (backend only).** Scholarships, concessions, waivers, fee
**adjustments**, **refunds**, and the full financial report set landed as **NEW ledger-entry
tables** (`concession_definitions`, `student_concessions`, `concession_credits`, `refunds`,
`refund_reversals`, `adjustments`) plus **new allocation/reversal entries** and **forward +
backward charge-status transitions driven by a single ledger** — with **no** edits to posted
`student_charges`, `CAPTURED` `payment_transactions`, `payment_allocations`, or `receipts`
(the slice-1 append-only / column-guard model held; the four new INSERT-only ledger tables
are trigger-protected the same way, and `refunds` carries a `refunds_guard` column guard).
Outstanding/status is a single source of truth (`services/fees/ledger.ts`) composed across
charges + payments + concessions + refund reversals + adjustments, all money INTEGER PAISE
(`BIGINT`) internally and strings/typed cells on every boundary. The Razorpay refund spine
(`refundPayment` + the public `refund.processed`/`refund.failed`/`refund.created` webhook
branch) settles idempotently under an advisory lock with net-refundable recompute. The
`fees.refund` and `fees.adjust` permission keys (forward-declared, unbound in slice 1) are now
**bound** (to `ACCOUNTANT` + `ADMIN`) and consumed by step-up-gated routes (`requireStepUp` +
the permission) alongside the new `fees.concession.manage` key; the migration
`20261129000000_phase7_fees_slice2` is additive (no DROP on existing tables) and
`prisma migrate status` is clean. Verification run: clean `npm ci` + workspace build green;
`npm test -w @campusgate/api` 454/454 green; both new live-DB suites green in isolation
(`fees-behavioral` 22/22, extended `tenant-escape` 75/75). The frontend remains deferred
(see the deferred-frontend scope list above). Historical note — 7.1 was originally scoped as
DEFERRED in slice 1: the keys were forward-declared, unbound; 7.1 wired their step-up-gated
routes with `requireStepUp` + the permission
([`superadmin-security.md`](./superadmin-security.md) §5.2).

---

## Phase 8 — Examinations & results

**Objective.** Exams, schedules, marks, moderation, and controlled result publication.

**Dependencies.** Phase 0, 1, 2, 3.

**Scope.** Exam sessions/types, subject-wise schedules, room allocation, candidate lists,
assessment components, marks entry (scoped), validation, moderation/approval, result
calculation (configurable grading — not one universal formula), publication,
re-evaluation, supplementary exams, result reports, student result history.

**Schema additions.** `Examination`, `ExamSchedule`, `Candidate`, `Assessment`,
`MarksRecord`, `ResultPublication`. Tenant-owned; composite FKs to shared student + class.

**Security & tenancy notes.** Students never see unpublished results. Faculty enter marks
only within assigned scope. Published results corrected only through controlled procedures;
mark changes audited; result exports authorized; publication is a step-up action.

**Tests.** Unpublished results hidden from students; faculty scope on marks entry;
publication permissioned + stepped-up; grade calc follows configured rules; mark-change
audit; cross-tenant escape extended.

**Definition of Done (demoable).** Only authorized users enter/approve/modify/publish
results per the configured workflow; a student sees results only after publication.

**Slice 8.1 — SHIPPED (backend only).** The access-and-correctness-critical exam
foundation landed: ten tenant-owned exam tables (`examinations`, `grading_schemes`,
`grade_bands`, `exam_schedules`, `candidates`, `assessments`, `marks_records`,
`marks_record_history`, `result_publications`, `result_snapshots`) behind ENABLE+FORCE
RLS with nullif-guarded fail-closed policies, a hand-authored lettered a–j migration
`20261206000000_phase8_exams_slice1` (strictly additive — **no DROP** on existing tables,
the 14 frozen dirs byte-untouched, `prisma migrate status` up to date at 15 migrations).
The `/api/exams` route surface covers exam setup, the forward-only status lifecycle
(DRAFT→SCHEDULED→MARKS_OPEN→MARKS_LOCKED→MODERATION→APPROVED→PUBLISHED, column-guard
trigger enforced), capacity-aware room allocation (library advisory-lock idiom + partial
unique backstop), faculty-scoped marks entry (scope from ACTIVE `FacultyAssignment`,
deactivated/out-of-scope write → 403 + `DENIED` audit, no row written), post-`MARKS_LOCKED`
audited append-only corrections (`marks_record_history`), moderation/approval, and
step-up-gated append-only versioned result publication (`requireStepUp("exams.results.publish")`
+ `requirePermission`). A pure integer/BigInt grading engine (`services/exams/grading.ts`)
bands on basis points with a single documented round-half-up step and a typed `GradingError`
on misconfiguration — no float touches the computation or a boundary. Student reads return
only the latest PUBLISHED version's snapshot; unpublished state is invisible at both the
query layer and the `exams.results.view_own` vs `exams.results.view` permission split. RBAC:
ADMIN and HOD each bind exactly the six management keys (`exams.manage`,
`exams.grading.manage`, `exams.candidates.manage`, `exams.moderate`, `exams.results.publish`,
`exams.results.view`), FACULTY `exams.marks.enter` only, STUDENT `exams.results.view_own`
only (14 role_permissions pairs; catalogue-sync set-equality is the self-enforcing backstop).
Every lifecycle transition is audited under the single `exams.examination.status_changed`
key (no dead `exams.marks.locked` / `exams.moderation.opened` keys). `MODULE_DEPENDENCIES`
is unchanged (`examinations` keeps its three foundational edges); routes are gated by
`requireModuleActive("examinations")`. Verification run: clean `npm ci` + workspace build
green (`turbo build` 3/3 successful); `npm test -w @campusgate/api` **484/484** green (was
454 before the slice); both new live-DB suites green **in isolation** (`exams-behavioral`
7/7, extended `tenant-escape` 82/82 with teardown total 0). The frontend remains deferred
(see the deferred-frontend scope list above).

---

## Phase 9 — Institutional operations

**Objective.** Add operational modules as institutional demand requires, each on the shared
foundation.

**Dependencies.** Phase 0 (plus per-module: Faculty/HR relate to users; Hostel/Transport
may reference students).

**Scope (each a module with entitlement/activation + its own permissions + tenant
isolation + audit).**
- **Faculty Management** — academic assignments, qualifications, workload, teaching
  history (distinct from HR).
- **HR Management** — employee records, contracts, leave policies/applications/approval,
  employee attendance, shifts; HR data isolated from student-facing access.
- **Hostel** — buildings/rooms/allocation/transfers/check-in-out, leave, warden approval,
  occupancy, maintenance. Hostel-leave ↔ gate-pass only by **explicit** configuration.
- **Transport** — vehicles/routes/stops/assignments, transport fee, enrollment, drivers,
  capacity, maintenance, schedules.
- **Inventory & Assets** — asset registry/categories/custody/transfers/maintenance/
  disposal, consumable stock, audits (distinct from Library).
- **Service Requests** — predefined request types, forms, assignment, status/SLA,
  approvals, resolution, feedback (start with fixed workflow types, not a generic engine).
- **Document Management** — controlled uploads, metadata, ownership, access permissions,
  versions, retention, download authorization, audit; large files in object storage, not
  the relational DB.

**Schema additions.** Per module, tenant-owned, following the tenancy checklist.

**Security & tenancy notes.** Each module ships its permission catalogue + template roles.
Explicit, configured integrations only (e.g. hostel leave ≠ auto gate-pass). Documents not
public by default; downloads verify permission + tenant.

**Definition of Done (demoable).** Each activated module operates end-to-end for two
institutions with isolation, permissions, and audit; dependencies enforced at activation.

---

## Phase 10 — Advanced ERP

**Objective.** High-complexity capabilities, after the earlier modules are stable.

**Dependencies.** The relevant earlier phases (e.g. Accounting builds on Fees; Parent
portal on SIS/Attendance/Fees/Exams).

**Scope.**
- **Financial Accounting** — chart of accounts, journal entries, GL, AP/AR, expenses,
  vendors, POs, reconciliation, statements, budgets, period close, audit trail. Balanced,
  controlled transactions with auditable reversals — **not** arbitrary balance updates.
  *Recommended out of the first release; Fees stands alone until Accounting is designed +
  validated separately.*
- **Payroll** — salary structures, earnings/deductions, periods, adjustments, payslips,
  approval, export, statutory reporting. Jurisdiction-specific rules **implemented +
  verified**, never guessed. Separate, tightly controlled module.
- **Parent/Guardian Portal** — access based on a **verified** relationship + explicit
  policy; never blanket access to all student records.
- **Mobile apps** — student/faculty/staff; sensitive actions require server verification;
  offline must not bypass authorization or create conflicting authoritative records.
- **Advanced analytics** — cross-institution analytics restricted to authorized platform
  operations on aggregated/de-identified data.
- **AI-assisted operations** — search/summarize/draft within authorized scope; AI must not
  grant permissions, fabricate transactions, publish results, or make high-impact decisions
  without human authorization.
- **Configurable workflows** — start with well-defined workflow types; a fully generic
  engine only when real institutional need justifies it.

**Security & tenancy notes.** The highest-risk modules; everything here is gated by
permissions, step-up, audit, and (for cross-institution analytics) de-identification. AI
and automation never bypass the authorization engine.

**Definition of Done (demoable).** Each capability, when built, passes the per-module
Definition of Done ([`architecture.md`](./architecture.md) §7) with special attention to
transactional integrity (Accounting/Payroll), verified relationships (Parent portal), and
human-authorization gates (AI).

---

## Phase completion gate (applies to all phases)

A phase is complete only when, in addition to its own Definition of Done:

- The per-module Definition of Done checklist ([`architecture.md`](./architecture.md) §7)
  passes for every module in the phase.
- The cross-tenant escape suite ([`tenancy.md`](./tenancy.md) §7) is **extended** to cover
  the phase's new tables and passes (including the deliberately-buggy-query test).
- New permissions are registered in the catalogue and bound to template roles
  ([`identity-rbac.md`](./identity-rbac.md) §6).
- Important actions write AuditLog v2 events
  ([`superadmin-security.md`](./superadmin-security.md) §6).
- Schema changes shipped as versioned migrations with RLS/FKs in the same migration
  ([`database.md`](./database.md) §4).

---

## Changelog

| Date | Change |
|---|---|
| 2026-10-18 | Initial roadmap: phases 0–10 with objective/dependencies/scope/schema/security/tests/DoD, dependency overview, single-identity rule, phase completion gate. |
